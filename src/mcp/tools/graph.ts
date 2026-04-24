// src/mcp/tools/graph.ts
import * as Reactodia from '@reactodia/workspace';
import type { McpTool, McpResult } from '@/mcp/types';
import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';
import { mcpManifest, mcpServerDescription } from '@/mcp/manifest';
import { Parser as SparqlParser } from 'sparqljs';
import { resolveOntologyLoadUrl, WELL_KNOWN_PREFIXES } from '@/utils/wellKnownOntologies';
import { useSettingsStore } from '@/stores/settingsStore';

/** Prepend PREFIX declarations from the namespace map for any prefix not already declared in the query. */
function injectPrefixes(sparql: string): string {
  const namespaces = rdfManager.getNamespaces();
  const declared = new Set<string>();
  for (const m of sparql.matchAll(/(?:PREFIX|BASE)\s+(\S+)\s*:/gi)) declared.add(m[1].toLowerCase());
  const lines = namespaces
    .filter(ns => ns.prefix && ns.uri && !declared.has(ns.prefix.toLowerCase()))
    .map(ns => `PREFIX ${ns.prefix}: <${ns.uri}>`);
  return lines.length ? `${lines.join('\n')}\n${sparql}` : sparql;
}

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
function getElementLabel(data: Reactodia.ElementModel | undefined): string {
  return (data?.properties?.[RDFS_LABEL]?.[0] as { value?: string } | undefined)?.value ?? '';
}

function getCanvasIris(): string[] {
  try {
    const { ctx } = getWorkspaceRefs();
    return ctx.model.elements
      .filter(e => e instanceof Reactodia.EntityElement)
      .map(e => (e as Reactodia.EntityElement).iri);
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// loadRdf
// ---------------------------------------------------------------------------
const loadRdf: McpTool = {
  name: 'loadRdf',
  description: 'Load RDF data into the graph from a URL or inline Turtle text.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL of an RDF document to fetch and load.' },
      turtle: { type: 'string', description: 'Inline Turtle text to load.' },
    },
    oneOf: [{ required: ['url'] }, { required: ['turtle'] }],
  },
  async handler(params): Promise<McpResult> {
    try {
      const p = params as { url?: string; turtle?: string };
      if (p.url) {
        await rdfManager.loadRDFFromUrl(p.url);
        return { success: true, data: { loaded: p.url } };
      }
      if (p.turtle) {
        const canvasBefore = getCanvasIris();
        await rdfManager.loadRDFIntoGraph(p.turtle, 'urn:vg:data', 'text/turtle');
        // Wait for the RDF worker change event to propagate to dataProvider.allSubjects
        await new Promise(r => setTimeout(r, 600));
        const { dataProvider } = getWorkspaceRefs();
        const allItems = await dataProvider.lookupAll();
        const canvasBeforeSet = new Set(canvasBefore);
        const newEntities = allItems
          .filter(item => !canvasBeforeSet.has(item.element.id))
          .slice(0, 100)
          .map(item => ({ iri: item.element.id, label: getElementLabel(item.element) || item.element.id }));
        return {
          success: true,
          data: {
            loaded: 'inline turtle',
            canvasNodesBefore: canvasBefore,
            newEntitiesAvailable: newEntities,
          },
        };
      }
      return { success: false, error: 'Provide either url or turtle' };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// loadOntology
// ---------------------------------------------------------------------------
const loadOntology: McpTool = {
  name: 'loadOntology',
  description:
    'Load a well-known ontology by prefix name (e.g. "bfo", "ro", "iao", "foaf", "pmdco"), ' +
    'by its namespace URL, or by any direct ontology file URL. ' +
    'Call with url="" or omit url to list all available well-known ontologies.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description:
          'Prefix name (e.g. "bfo"), namespace IRI, or direct ontology URL. ' +
          'Leave empty to list available well-known ontologies.',
      },
    },
  },
  async handler(params): Promise<McpResult> {
    const { url = '' } = (params ?? {}) as { url?: string };

    // Empty call — return registry listing
    if (!url.trim()) {
      const known = WELL_KNOWN_PREFIXES
        .filter(p => (p as any).ontologyUrl || p.url)
        .map(p => ({ prefix: p.prefix, name: p.name, namespace: p.url, ontologyUrl: (p as any).ontologyUrl ?? p.url }));
      return { success: true, data: { availableOntologies: known } };
    }

    const resolvedUrl = resolveOntologyLoadUrl(url);
    const corsProxyUrl = useSettingsStore.getState().settings.corsProxyUrl;
    try {
      await rdfManager.loadRDFFromUrl(resolvedUrl, { corsProxyUrl });
      return { success: true, data: { loaded: resolvedUrl, requestedAs: url !== resolvedUrl ? url : undefined } };
    } catch (e) {
      // Suggest close matches from the registry
      const q = url.toLowerCase();
      const suggestions = WELL_KNOWN_PREFIXES
        .filter(p => p.prefix.includes(q) || p.name.toLowerCase().includes(q))
        .map(p => p.prefix);
      return {
        success: false,
        error: String(e),
        ...(suggestions.length ? { suggestions } : {}),
      };
    }
  },
};

// ---------------------------------------------------------------------------
// queryGraph
// ---------------------------------------------------------------------------
const queryGraph: McpTool = {
  name: 'queryGraph',
  description: 'Run a SPARQL query or update against asserted data (urn:vg:data). Namespace prefixes are injected automatically. Supported: SELECT (return bindings), CONSTRUCT (return triples, read-only), INSERT DATA, DELETE DATA, DELETE WHERE, DELETE...INSERT...WHERE. Inferred triples are in GRAPH urn:vg:inferred.',
  inputSchema: {
    type: 'object',
    required: ['sparql'],
    properties: {
      sparql: { type: 'string', description: 'SPARQL query or update string.' },
      limit: { type: 'integer', default: 200, description: 'Max rows/triples to return (default 200).' },
    },
  },
  async handler(params): Promise<McpResult> {
    try {
      const { sparql: rawSparql, limit = 200 } = params as { sparql: string; limit?: number };
      if (!rawSparql) return { success: false, error: 'sparql is required' };

      const sparql = injectPrefixes(rawSparql);

      // Validate parse before sending to worker (gives better error messages)
      let parsed: any;
      try {
        parsed = new SparqlParser().parse(sparql);
      } catch (e) {
        return { success: false, error: `SPARQL parse error: ${String(e)}` };
      }
      if (parsed.type === 'query' && parsed.queryType === 'ASK') {
        return { success: false, error: 'ASK queries are not supported. Use SELECT or CONSTRUCT.' };
      }

      const workerResult = await rdfManager.sparqlQuery(sparql, { limit });

      if (workerResult.type === 'select') {
        const rows: Array<Record<string, string>> = workerResult.rows ?? [];
        return { success: true, data: { rows, total: rows.length, truncated: rows.length >= limit } };
      }

      if (workerResult.type === 'construct') {
        const triples: Array<{ s: string; p: string; o: string }> = workerResult.triples ?? [];
        return {
          success: true,
          data: {
            triples,
            total: triples.length,
            truncated: triples.length >= limit,
            ...(triples.length === 0
              ? { notice: 'CONSTRUCT matched 0 triples. Check that WHERE patterns match asserted data.' }
              : {}),
          },
        };
      }

      if (workerResult.type === 'update') {
        return { success: true, data: { updated: true } };
      }

      return { success: false, error: `Unexpected result type from worker: ${(workerResult as any)?.type}` };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// exportGraph
// ---------------------------------------------------------------------------
const exportGraph: McpTool = {
  name: 'exportGraph',
  description: 'Export the current RDF graph in the requested serialisation format.',
  inputSchema: {
    type: 'object',
    required: ['format'],
    properties: {
      format: {
        type: 'string',
        enum: ['turtle', 'jsonld', 'rdfxml'],
        description: 'Serialisation format: turtle | jsonld | rdfxml',
      },
    },
  },
  async handler(params): Promise<McpResult> {
    try {
      const { format } = params as { format: string };
      let content: string;
      if (format === 'turtle') {
        content = await rdfManager.exportToTurtle();
      } else if (format === 'jsonld') {
        content = await rdfManager.exportToJsonLD();
      } else if (format === 'rdfxml') {
        content = await rdfManager.exportToRdfXml();
      } else {
        return { success: false, error: `Unknown format: ${format}` };
      }
      return { success: true, data: { content } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// exportImage  (SVG default — vector text, far fewer tokens than PNG base64)
// ---------------------------------------------------------------------------
const exportImage: McpTool = {
  name: 'exportImage',
  description: 'Export the current diagram canvas as SVG (default) or PNG. Use noCss: true to strip embedded CSS for smaller token-efficient output — recommended for AI relay use.',
  inputSchema: {
    type: 'object',
    properties: {
      format: {
        type: 'string',
        enum: ['svg', 'png'],
        default: 'svg',
        description: 'Image format: svg (default) | png',
      },
      noCss: {
        type: 'boolean',
        default: false,
        description: 'Strip embedded CSS from SVG output to reduce token count. Nodes lose visual styling but topology remains readable.',
      },
    },
  },
  async handler(params): Promise<McpResult> {
    try {
      const { format = 'svg', noCss = false } = (params ?? {}) as { format?: string; noCss?: boolean };
      let canvas: Reactodia.CanvasApi | undefined;
      try {
        const { ctx } = getWorkspaceRefs();
        canvas = ctx.view.findAnyCanvas();
      } catch {
        return { success: false, error: 'Canvas not available' };
      }
      if (!canvas) return { success: false, error: 'Canvas not available' };

      if (format === 'svg') {
        let content = await canvas.exportSvg({ addXmlHeader: true });
        if (noCss) {
          // Strip <style>...</style> blocks to reduce token count
          content = content.replace(/<style[\s\S]*?<\/style>/gi, '');
        }
        return { success: true, data: { content } };
      }
      if (format === 'png') {
        const content = await canvas.exportRaster({ mimeType: 'image/png' });
        return { success: true, data: { content } };
      }
      return { success: false, error: `Unknown format: ${format}` };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// getGraphState
// ---------------------------------------------------------------------------
const getGraphState: McpTool = {
  name: 'getGraphState',
  description: 'Return a summary of what is currently on the canvas: node count, link count, and node details.',
  inputSchema: { type: 'object' },
  async handler(): Promise<McpResult> {
    try {
      const { ctx } = getWorkspaceRefs();
      const model = ctx.model;
      const nodes = model.elements
        .filter(e => e instanceof Reactodia.EntityElement)
        .map(e => {
          const entity = e as Reactodia.EntityElement;
          const data = entity.data;
          return {
            iri: entity.iri,
            label: getElementLabel(data),
            types: data?.types ?? [],
          };
        });
      return {
        success: true,
        data: {
          nodeCount: nodes.length,
          linkCount: model.links.length,
          nodes,
        },
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------
const help: McpTool = {
  name: 'help',
  async handler(params): Promise<McpResult> {
    const { tool } = (params ?? {}) as { tool?: string };
    if (tool) {
      const entry = mcpManifest.find(e => e.name === tool);
      if (!entry) return { success: false, error: `Unknown tool: ${tool}. Call help() with no arguments to list all tools.` };
      return { success: true, data: { content: JSON.stringify({ name: entry.name, description: entry.description, inputSchema: entry.inputSchema }) } };
    }
    const instructions = [
      mcpServerDescription,
      '',
      'RELAY OUTPUT FORMAT',
      'Emit one MCP JSON-RPC 2.0 request per line, each wrapped in single backtick chars (U+0060).',
      'Format: BACKTICK{"jsonrpc":"2.0","id":<N>,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}BACKTICK',
      'Replace BACKTICK with the actual backtick character (`) and fill in tool name and arguments.',
      '',
      'Rules:',
      '1. Multiple tool calls per response are allowed — they run sequentially.',
      '2. Use a different integer id for each call.',
      '3. Wait for the injected result message before issuing more calls.',
      '4. Never output a tool call unless you intend it to run — the relay executes everything it finds.',
      '5. addLink requires both nodes to already exist on canvas — never issue addNode and addLink for the same node in one response.',
      '',
      'Reading results:',
      'The relay injects a message starting with [VisGraph — N tools ✓] followed by one backtick-wrapped',
      'JSON-RPC 2.0 response per call. result.content[0].text holds the outcome summary.',
      '- result means success; error means failure (check error.message).',
      '- A Canvas summary line and SVG may follow.',
      '',
      'Timeout / late results:',
      'Long operations (layout, reasoning) may exceed the relay timeout. A timed-out call returns a JSON-RPC',
      'error with data.lateResult=true. Do NOT retry — a [VisGraph — late result for <tool>] follow-up',
      'will be injected automatically when the operation completes.',
      '',
      'GRAPH ARCHITECTURE',
      'Asserted triples live in urn:vg:data — all mutation tools (addNode, addLink, updateNode, SPARQL CONSTRUCT, etc.) operate here only.',
      'Inferred triples live in urn:vg:inferred — written by runReasoning, cleared by clearInferred, and read-only from all other tools.',
      'SHACL shapes live in urn:vg:shapes — loaded by loadShacl, read by validateGraph.',
      'Mutation tools never touch urn:vg:inferred or urn:vg:shapes; the separation is structural.',
      '',
      'Common namespace prefixes usable in argument values:',
      'rdf: rdfs: owl: xsd: foaf: skos: dc: dcterms: schema: ex:',
      '',
      'TOOLS',
      ...mcpManifest.map(e => `${e.name} — ${e.description}`),
      '',
      'Call help({"tool":"<name>"}) for the full schema of any tool.',
    ].join('\n');
    return { success: true, data: { content: instructions } };
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
export const graphTools: McpTool[] = [
  loadRdf,
  loadOntology,
  queryGraph,
  exportGraph,
  exportImage,
  getGraphState,
  help,
];
