import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { rdfManager } from "../../utils/rdfManager";
const { namedNode, literal, quad } = DataFactory;

describe("rdfManager.emitAllSubjects - includes quads from all graphs", () => {
  it(
    "emits authoritative quads from urn:vg:data subjects including ontology graph triples",
    async () => {
      // Clean environment
      try {
        rdfManager.removeGraph("urn:vg:data");
      } catch (_) {/* noop */}
      try {
        rdfManager.removeGraph("urn:vg:ontologies");
      } catch (_) {/* noop */}

      // Disable blacklist so test IRIs are not filtered
      try {
        rdfManager.setBlacklist([], []);
      } catch (_) {/* noop */}

      const subj = "http://example.test/Entity1";
      const ontG = namedNode("urn:vg:ontologies");
      const dataG = namedNode("urn:vg:data");

      // Ontology triple (in ontologies graph)
      const ontTriple = quad(
        namedNode(subj),
        namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
        namedNode("http://www.w3.org/2002/07/owl#Class"),
        ontG,
      );

      // Data triple (in data graph)
      const dataTriple = quad(
        namedNode(subj),
        namedNode("http://www.w3.org/2000/01/rdf-schema#label"),
        literal("MyLabel"),
        dataG,
      );

      // Insert directly into the store so emitAllSubjects can read authoritative snapshots
      const store = rdfManager.getStore();
      try {
        store.addQuad(ontTriple);
        store.addQuad(dataTriple);
      } catch (e) {
        // best-effort insert failures should fail the test
        throw e;
      }

      const calls: Array<{ subjects: string[]; quads?: any[] }> = [];
      const handler = (subjects: string[], quads?: any[]) => {
        try {
          calls.push({ subjects: Array.isArray(subjects) ? subjects.slice() : [], quads });
        } catch (_) {
          calls.push({ subjects: [], quads });
        }
      };
      rdfManager.onSubjectsChange(handler);

      // Trigger emission for subjects in the data graph
      await rdfManager.emitAllSubjects("urn:vg:data");

      // small wait to let any asynchronous flush complete (should be immediate but be tolerant)
      await new Promise((r) => setTimeout(r, 200));

      rdfManager.offSubjectsChange(handler);

      // Assertions: we expect at least one invocation
      expect(calls.length).toBeGreaterThan(0);

      // Find a call that contains our subject
      const found = calls.find((c) => Array.isArray(c.subjects) && c.subjects.includes(subj));
      expect(found).toBeDefined();

      const first = found || calls[0];
      expect(first.subjects).toContain(subj);

      // emitted quads should include both ontology and data predicates
      const emitted = Array.isArray(first.quads) ? first.quads : [];
      const preds = emitted.map((q: any) => (q && q.predicate && (q.predicate as any).value) || "");
      expect(preds).toContain("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
      expect(preds).toContain("http://www.w3.org/2000/01/rdf-schema#label");
    },
    { timeout: 20000 },
  );
});
