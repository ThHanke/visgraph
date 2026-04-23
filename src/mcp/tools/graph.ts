// src/mcp/tools/graph.ts
import * as Reactodia from '@reactodia/workspace';
import type { McpTool, McpResult } from '@/mcp/types';
import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';
import { mcpManifest, mcpServerDescription } from '@/mcp/manifest';
import { Parser as SparqlParser } from 'sparqljs';

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
  description: 'Load an ontology from a URL into the graph.',
  inputSchema: {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string', description: 'URL of the ontology to load.' },
    },
  },
  async handler(params): Promise<McpResult> {
    try {
      const { url } = params as { url: string };
      await rdfManager.loadRDFFromUrl(url);
      return { success: true, data: { loaded: url } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// SPARQL BGP evaluator (main-thread, operates on quads fetched from worker)
// ---------------------------------------------------------------------------

type Binding = Record<string, string>;

/** Return IRI or literal string for an RDF/JS-like term from sparqljs. */
function termValue(t: any): string {
  if (!t) return '';
  if (t.termType === 'NamedNode') return t.value;
  if (t.termType === 'Literal') return t.value;
  if (t.termType === 'BlankNode') return `_:${t.value}`;
  return String(t.value ?? t);
}

/** Apply one binding to a triple pattern term, returning null if the term is an unbound variable. */
function applyBinding(term: any, binding: Binding): string | null {
  if (term.termType === 'Variable') return binding[term.value] ?? null;
  return termValue(term);
}

/** Evaluate a list of BGP triple patterns against a flat quad array. Returns all bindings. */
function evalBGP(
  patterns: Array<{ subject: any; predicate: any; object: any }>,
  quads: Array<{ subject: string; predicate: string; object: string }>,
): Binding[] {
  let bindings: Binding[] = [{}];
  for (const pat of patterns) {
    const next: Binding[] = [];
    for (const b of bindings) {
      const s = applyBinding(pat.subject, b);
      const p = applyBinding(pat.predicate, b);
      const o = applyBinding(pat.object, b);
      for (const q of quads) {
        if (s !== null && s !== q.subject) continue;
        if (p !== null && p !== q.predicate) continue;
        if (o !== null && o !== q.object) continue;
        const extended: Binding = { ...b };
        if (pat.subject.termType === 'Variable') extended[pat.subject.value] = q.subject;
        if (pat.predicate.termType === 'Variable') extended[pat.predicate.value] = q.predicate;
        if (pat.object.termType === 'Variable') extended[pat.object.value] = q.object;
        next.push(extended);
      }
    }
    bindings = next;
  }
  return bindings;
}

/** Recursively collect BGP triple patterns from a parsed WHERE clause. */
function collectPatterns(groups: any[]): Array<{ subject: any; predicate: any; object: any }> {
  const patterns: Array<{ subject: any; predicate: any; object: any }> = [];
  for (const g of groups ?? []) {
    if (g.type === 'bgp') patterns.push(...(g.triples ?? []));
    else if (g.patterns || g.triples) patterns.push(...collectPatterns(g.patterns ?? g.triples ?? []));
  }
  return patterns;
}

// ---------------------------------------------------------------------------
// queryGraph
// ---------------------------------------------------------------------------
const queryGraph: McpTool = {
  name: 'queryGraph',
  description: 'Run a SPARQL SELECT or CONSTRUCT query against the asserted graph (urn:vg:data). Inferred triples are not included unless queried via GRAPH urn:vg:inferred.',
  inputSchema: {
    type: 'object',
    required: ['sparql'],
    properties: {
      sparql: { type: 'string', description: 'SPARQL SELECT or CONSTRUCT query.' },
      limit: { type: 'integer', default: 200, description: 'Max rows/triples to return (default 200).' },
    },
  },
  async handler(params): Promise<McpResult> {
    try {
      const { sparql, limit = 200 } = params as { sparql: string; limit?: number };
      if (!sparql) return { success: false, error: 'sparql is required' };

      let parsed: any;
      try {
        const parser = new SparqlParser();
        parsed = parser.parse(sparql);
      } catch (e) {
        return { success: false, error: `SPARQL parse error: ${String(e)}` };
      }

      if (parsed.type !== 'query') return { success: false, error: 'Only SELECT and CONSTRUCT queries are supported' };
      if (parsed.queryType !== 'SELECT' && parsed.queryType !== 'CONSTRUCT') {
        return { success: false, error: `Only SELECT and CONSTRUCT supported, got: ${parsed.queryType}` };
      }

      // Fetch all asserted quads
      const { items: quads } = await rdfManager.fetchQuadsPage({ graphName: 'urn:vg:data', limit: 0 });
      const patterns = collectPatterns(parsed.where ?? []);
      const bindings = evalBGP(patterns, quads ?? []);

      if (parsed.queryType === 'SELECT') {
        // sparqljs encodes SELECT * as variables containing a Wildcard term
        const isSelectStar = !parsed.variables ||
          (Array.isArray(parsed.variables) && parsed.variables.some((v: any) => v?.termType === 'Wildcard' || v === '*'));
        const allVarNames: string[] = isSelectStar
          ? [...new Set(patterns.flatMap(p =>
              [p.subject, p.predicate, p.object]
                .filter((t: any) => t?.termType === 'Variable')
                .map((t: any) => t.value)
            ))]
          : (parsed.variables as any[]).map((v: any) => v?.value ?? String(v));

        const rows = bindings.slice(0, limit).map(b =>
          Object.fromEntries(allVarNames.map((v: string) => [v, b[v] ?? null]))
        );
        return { success: true, data: { rows, total: bindings.length, truncated: bindings.length > limit } };
      }

      // CONSTRUCT
      const template: Array<{ subject: any; predicate: any; object: any }> = parsed.template ?? [];
      const newTriples: Array<{ s: string; p: string; o: string }> = [];
      for (const b of bindings) {
        for (const t of template) {
          const s = applyBinding(t.subject, b);
          const p = applyBinding(t.predicate, b);
          const o = applyBinding(t.object, b);
          if (s && p && o) newTriples.push({ s, p, o });
        }
      }

      const uniqueTriples = newTriples.slice(0, limit);
      // Add to store
      const { ctx } = getWorkspaceRefs();
      for (const t of uniqueTriples) {
        rdfManager.addTriple(t.s, t.p, t.o);
      }
      // Refresh canvas for any new subjects
      const newSubjects = [...new Set(uniqueTriples.map(t => t.s))] as Reactodia.ElementIri[];
      if (newSubjects.length) {
        await ctx.model.requestElementData(newSubjects);
        await ctx.model.requestLinks({ addedElements: newSubjects });
      }

      return {
        success: true,
        data: { added: uniqueTriples.length, truncated: newTriples.length > limit, triples: uniqueTriples },
      };
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
