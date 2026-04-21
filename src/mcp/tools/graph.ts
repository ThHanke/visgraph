// src/mcp/tools/graph.ts
import * as Reactodia from '@reactodia/workspace';
import type { McpTool, McpResult } from '@/mcp/types';
import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';

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
// queryGraph — graceful stub
// ---------------------------------------------------------------------------
const queryGraph: McpTool = {
  name: 'queryGraph',
  description: 'Run a SPARQL SELECT query against the graph (stub — not yet implemented).',
  inputSchema: {
    type: 'object',
    required: ['sparql'],
    properties: {
      sparql: { type: 'string', description: 'SPARQL SELECT query string.' },
    },
  },
  async handler(_params): Promise<McpResult> {
    return {
      success: false,
      error: 'SPARQL SELECT not yet supported — use getNodes/getLinks to query the graph',
    };
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
// Exports
// ---------------------------------------------------------------------------
export const graphTools: McpTool[] = [
  loadRdf,
  loadOntology,
  queryGraph,
  exportGraph,
  exportImage,
  getGraphState,
];
