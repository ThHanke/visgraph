// src/mcp/tools/shacl.ts
import type { McpTool, McpResult } from '@/mcp/types';
import { rdfManager } from '@/utils/rdfManager';

const SHACL_GRAPH = 'urn:vg:shapes';
const DATA_GRAPH = 'urn:vg:data';

const SH_NODESHAPE = 'http://www.w3.org/ns/shacl#NodeShape';
const SH_PROPERTLYSHAPE = 'http://www.w3.org/ns/shacl#PropertyShape';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// ---------------------------------------------------------------------------
// loadShacl
// ---------------------------------------------------------------------------
const loadShacl: McpTool = {
  name: 'loadShacl',
  description: 'Load SHACL shapes from inline Turtle text into the shapes graph (urn:vg:shapes). Call validateGraph to run validation after loading.',
  inputSchema: {
    type: 'object',
    required: ['turtle'],
    properties: {
      turtle: { type: 'string', description: 'Inline Turtle containing SHACL shape definitions.' },
    },
  },
  async handler(params): Promise<McpResult> {
    try {
      const { turtle } = params as { turtle: string };
      if (!turtle?.trim()) return { success: false, error: 'turtle is required' };

      await rdfManager.loadRDFIntoGraph(turtle, SHACL_GRAPH, 'text/turtle');

      // Count loaded shapes (NodeShape or PropertyShape)
      const { items } = await rdfManager.fetchQuadsPage({ graphName: SHACL_GRAPH, limit: 0 });
      const shapes = (items ?? [])
        .filter(q => q.predicate === RDF_TYPE && (q.object === SH_NODESHAPE || q.object === SH_PROPERTLYSHAPE))
        .map(q => q.subject);

      return { success: true, data: { loaded: shapes.length, shapes } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// validateGraph
// ---------------------------------------------------------------------------
const validateGraph: McpTool = {
  name: 'validateGraph',
  description: 'Validate the asserted graph (urn:vg:data) against SHACL shapes loaded in urn:vg:shapes. Returns conforms flag and structured violation list.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  async handler(): Promise<McpResult> {
    try {
      // Lazy import to avoid bundling issues when not used
      const [{ default: SHACLValidator }, { default: factory }, { Parser }] = await Promise.all([
        import('rdf-validate-shacl'),
        // Use the bundled default environment which has clownface + dataset support
        import('rdf-validate-shacl/src/defaultEnv.js' as string),
        import('n3'),
      ]);

      // Fetch shapes and data quads from the worker store
      const [shapesPage, dataPage] = await Promise.all([
        rdfManager.fetchQuadsPage({ graphName: SHACL_GRAPH, limit: 0 }),
        rdfManager.fetchQuadsPage({ graphName: DATA_GRAPH, limit: 0 }),
      ]);

      // Rebuild RDF/JS datasets from the flat quad arrays
      function quadsToDataset(items: Array<{ subject: string; predicate: string; object: string }>) {
        const ds = factory.dataset();
        for (const q of items ?? []) {
          // Classify subject/object as named node or literal
          const s = factory.namedNode(q.subject);
          const p = factory.namedNode(q.predicate);
          const o = q.object.startsWith('_:')
            ? factory.blankNode(q.object.slice(2))
            : /^[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(q.object)
              ? factory.namedNode(q.object)
              : factory.literal(q.object);
          ds.add(factory.quad(s, p, o));
        }
        return ds;
      }

      const shapesDs = quadsToDataset(shapesPage.items ?? []);
      const dataDs = quadsToDataset(dataPage.items ?? []);

      const validator = new SHACLValidator(shapesDs, { factory });
      const report = await validator.validate(dataDs);

      const violations = (report.results ?? []).map((r: any) => ({
        focusNode: r.focusNode?.value ?? null,
        path: r.path?.value ?? null,
        constraint: r.sourceConstraintComponent?.value ?? null,
        severity: r.severity?.value?.replace('http://www.w3.org/ns/shacl#', 'sh:') ?? null,
        message: Array.isArray(r.message) ? r.message.map((m: any) => m.value).join('; ') : (r.message?.value ?? null),
        sourceShape: r.sourceShape?.value ?? null,
      }));

      return { success: true, data: { conforms: report.conforms, violations } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

export const shaclTools: McpTool[] = [loadShacl, validateGraph];
