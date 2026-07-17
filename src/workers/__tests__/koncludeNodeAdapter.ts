// src/workers/__tests__/koncludeNodeAdapter.ts
//
// TEST-ONLY node-compatible adapter implementing KoncludeReasonerLike on top of
// the package `RdfReasoner`. The production KoncludeReasoner in
// rdfManager.runtime.ts spawns a Web Worker (`new Worker(...)`) which is
// unavailable under vitest's node environment; this adapter wraps the package
// reasoner (which initialises its WASM worker fine in node) so a test can inject
// it via setKoncludeReasonerFactoryForTest and drive the REAL worker runtime
// (handleReasonIncremental, the full-run Konclude path) end-to-end.
//
// It mirrors the production KoncludeReasoner's boundary transforms EXACTLY:
//   • de-skolemize urn:vg:bnode:* NamedNodes → real blank nodes before reasoning;
//   • drop the inferred graph + workflows/shapes/provenance from the source set;
//   • filter out already-asserted triples from the inferred result.
import { RdfReasoner } from 'rdf-reasoner-konclude';
import * as N3 from 'n3';
import type { KoncludeReasonerLike } from '../rdfManager.runtime';

const KONCLUDE_INFERRED_GRAPH_IRI = 'urn:vg:inferred';
const BNODE_PREFIX = 'urn:vg:bnode:';

function deskolemizeQuads(candidates: N3.Quad[]): N3.Quad[] {
  return candidates.map((q) => {
    const subj =
      q.subject.termType === 'NamedNode' && q.subject.value.startsWith(BNODE_PREFIX)
        ? N3.DataFactory.blankNode(q.subject.value.slice(BNODE_PREFIX.length))
        : q.subject;
    const obj =
      q.object.termType === 'NamedNode' && q.object.value.startsWith(BNODE_PREFIX)
        ? N3.DataFactory.blankNode(q.object.value.slice(BNODE_PREFIX.length))
        : q.object;
    if (subj === q.subject && obj === q.object) return q;
    return N3.DataFactory.quad(subj as N3.Quad_Subject, q.predicate, obj as N3.Quad_Object, q.graph);
  });
}

const keyOf = (q: { subject: N3.Term; predicate: N3.Term; object: N3.Term }) =>
  `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`;

async function classifyDirect(r: RdfReasoner, candidates: N3.Quad[]): Promise<N3.Quad[]> {
  const sourceKeys = new Set(candidates.map(keyOf));
  const deskolemized = deskolemizeQuads(candidates);
  // r.materialize returns @rdfjs/types Quad[]; cast to N3.Quad[] (structurally
  // identical RDF/JS terms) for the KoncludeReasonerLike contract.
  const inferred = (await r.materialize(deskolemized)) as unknown as N3.Quad[];
  return inferred.filter((q) => !sourceKeys.has(keyOf(q)));
}

/** Build a KoncludeReasonerLike backed by the package RdfReasoner (node). */
export function createNodeKoncludeReasoner(): KoncludeReasonerLike {
  const r = new RdfReasoner();
  return {
    ready: r.ready,
    async reason(store: N3.Store): Promise<void> {
      const inferredGraphNode = N3.DataFactory.namedNode(KONCLUDE_INFERRED_GRAPH_IRI);
      store.removeQuads(store.getQuads(null, null, null, inferredGraphNode));
      const EXCLUDED = new Set(['urn:vg:workflows', 'urn:vg:shapes', 'urn:vg:provenance']);
      const all = store.getQuads(null, null, null, null) as N3.Quad[];
      const source = all.filter((q) => {
        const g = q.graph.termType === 'DefaultGraph' ? '' : q.graph.value;
        return !EXCLUDED.has(g);
      });
      const inferred = await classifyDirect(r, source);
      for (const q of inferred) {
        store.addQuad(N3.DataFactory.quad(q.subject, q.predicate, q.object, inferredGraphNode));
      }
    },
    async checkConsistency(store: N3.Store): Promise<boolean> {
      const EXCLUDED = new Set([
        'urn:vg:workflows',
        'urn:vg:inferred',
        'urn:vg:shapes',
        'urn:vg:provenance',
      ]);
      const candidates = (store.getQuads(null, null, null, null) as N3.Quad[]).filter((q) => {
        const g = q.graph.termType === 'DefaultGraph' ? '' : q.graph.value;
        return !EXCLUDED.has(g);
      });
      return r.checkConsistency(new N3.Store(deskolemizeQuads(candidates)));
    },
    async getUnsatisfiableClasses(store: N3.Store): Promise<string[]> {
      const EXCLUDED = new Set([
        'urn:vg:workflows',
        'urn:vg:inferred',
        'urn:vg:shapes',
        'urn:vg:provenance',
      ]);
      const candidates = (store.getQuads(null, null, null, null) as N3.Quad[]).filter((q) => {
        const g = q.graph.termType === 'DefaultGraph' ? '' : q.graph.value;
        return !EXCLUDED.has(g);
      });
      return r.getUnsatisfiableClasses(new N3.Store(deskolemizeQuads(candidates)));
    },
    async explainInconsistency(store: N3.Store, maxJustifications = 1): Promise<N3.Quad[][]> {
      const EXCLUDED = new Set([
        'urn:vg:workflows',
        'urn:vg:inferred',
        'urn:vg:shapes',
        'urn:vg:provenance',
      ]);
      const candidates = (store.getQuads(null, null, null, null) as N3.Quad[]).filter((q) => {
        const g = q.graph.termType === 'DefaultGraph' ? '' : q.graph.value;
        return !EXCLUDED.has(g);
      });
      return (await r.explainInconsistency(new N3.Store(deskolemizeQuads(candidates)), {
        maxJustifications,
      })) as unknown as N3.Quad[][];
    },
    async explainEntailment(
      store: N3.Store,
      subjectIri: string,
      predicateIri: string,
      objectIri: string,
      objectIsClassLike: boolean,
      maxJustifications = 1,
    ): Promise<{
      isEntailed: boolean | null;
      justifications: N3.Quad[][];
      ontologyInconsistent?: boolean;
      vacuous?: boolean;
      reason?: string;
    }> {
      const EXCLUDED = new Set([
        'urn:vg:workflows',
        'urn:vg:inferred',
        'urn:vg:shapes',
        'urn:vg:provenance',
      ]);
      const candidates = (store.getQuads(null, null, null, null) as N3.Quad[]).filter((q) => {
        const g = q.graph.termType === 'DefaultGraph' ? '' : q.graph.value;
        return !EXCLUDED.has(g);
      });
      return r.explainEntailment(
        new N3.Store(deskolemizeQuads(candidates)),
        subjectIri,
        predicateIri,
        objectIri,
        { maxJustifications, objectIsClassLike },
      ) as unknown as {
        isEntailed: boolean | null;
        justifications: N3.Quad[][];
        ontologyInconsistent?: boolean;
        vacuous?: boolean;
        reason?: string;
      };
    },
    terminate(): void {
      r.terminate();
    },
  };
}
