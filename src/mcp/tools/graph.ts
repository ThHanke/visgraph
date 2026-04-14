// src/mcp/tools/graph.ts
import type { McpTool, McpResult } from '@/mcp/types';
import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';

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
        await rdfManager.loadRDFIntoGraph(p.turtle, 'default', 'text/turtle');
        return { success: true, data: { loaded: 'inline turtle' } };
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
    try {
      return {
        success: false,
        error: 'SPARQL SELECT not yet supported — use getNodes/getLinks to query the graph',
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
// exportImage
// ---------------------------------------------------------------------------
const exportImage: McpTool = {
  name: 'exportImage',
  description: 'Export the current diagram canvas as SVG or PNG.',
  inputSchema: {
    type: 'object',
    required: ['format'],
    properties: {
      format: {
        type: 'string',
        enum: ['svg', 'png'],
        description: 'Image format: svg | png',
      },
    },
  },
  async handler(params): Promise<McpResult> {
    try {
      const { format } = params as { format: string };
      let ctx;
      try {
        ({ ctx } = getWorkspaceRefs());
      } catch {
        return { success: false, error: 'Canvas not available' };
      }
      const canvas = ctx.canvas;
      if (!canvas) {
        return { success: false, error: 'Canvas not available' };
      }
      if (format === 'svg') {
        const content = await canvas.exportSvg({ addXmlHeader: true });
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
// Exports
// ---------------------------------------------------------------------------
export const graphTools: McpTool[] = [
  loadRdf,
  loadOntology,
  queryGraph,
  exportGraph,
  exportImage,
];
