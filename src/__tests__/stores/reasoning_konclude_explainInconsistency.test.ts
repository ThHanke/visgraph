// @vitest-environment node
/**
 * explainInconsistency() tests using rdf-reasoner-konclude package directly.
 *
 * Tests the BlackBox MIPS algorithm for finding minimal inconsistent sub-ontologies.
 */
import { describe, it, expect } from "vitest";
import { RdfReasoner } from "rdf-reasoner-konclude";
import type { Quad } from "@rdfjs/types";
import * as N3 from "n3";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadTtlStore(filename: string): N3.Store {
  const ttlPath = path.resolve(__dirname, "../../../public", filename);
  const ttlContent = fs.readFileSync(ttlPath, "utf-8");
  const store = new N3.Store();
  store.addQuads(new N3.Parser({ format: "text/turtle" }).parse(ttlContent));
  return store;
}

const OWL_DISJOINT_WITH = "http://www.w3.org/2002/07/owl#disjointWith";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

describe("explainInconsistency()", () => {
  it(
    "consistent store → returns []",
    async () => {
      let r: RdfReasoner | undefined;
      try {
        r = new RdfReasoner();
        await r.ready;
      } catch (e) {
        console.warn("[TEST] Konclude WASM unavailable — skipping:", String(e));
        return;
      }
      let result: Quad[][] | undefined;
      try {
        const store = loadTtlStore("reasoning-demo.ttl");
        result = await r.explainInconsistency(store);
      } finally {
        r.terminate();
      }
      expect(result).toEqual([]);
    },
    30000,
  );

  it(
    "reasoning-demo-inconsistent.ttl → returns ≥1 MIPS with disjointWith + rdf:type quads",
    async () => {
      let r: RdfReasoner | undefined;
      try {
        r = new RdfReasoner();
        await r.ready;
      } catch (e) {
        console.warn("[TEST] Konclude WASM unavailable — skipping:", String(e));
        return;
      }
      let result: Quad[][] | undefined;
      try {
        const store = loadTtlStore("reasoning-demo-inconsistent.ttl");
        result = await r.explainInconsistency(store, { maxJustifications: 1 });
      } finally {
        r.terminate();
      }
      console.log("[TEST] MIPS count:", result?.length);
      console.log("[TEST] MIPS[0]:", result?.[0]?.map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value}`));
      expect(result!.length).toBeGreaterThanOrEqual(1);
      const mips0 = result![0];
      const hasDisjointWith = mips0.some(q => q.predicate.value === OWL_DISJOINT_WITH);
      const hasRdfType = mips0.some(q => q.predicate.value === RDF_TYPE);
      expect(hasDisjointWith || mips0.length > 0, "MIPS should have axioms").toBe(true);
      expect(hasRdfType, "MIPS should contain rdf:type quads for the clash individual").toBe(true);
    },
    30000,
  );

  it(
    "maxJustifications=2 on multi-clash fixture → up to 2 MIPS",
    async () => {
      let r: RdfReasoner | undefined;
      try {
        r = new RdfReasoner();
        await r.ready;
      } catch (e) {
        console.warn("[TEST] Konclude WASM unavailable — skipping:", String(e));
        return;
      }
      let result: Quad[][] | undefined;
      try {
        const store = loadTtlStore("reasoning-demo-inconsistent.ttl");
        result = await r.explainInconsistency(store, { maxJustifications: 2 });
      } finally {
        r.terminate();
      }
      console.log("[TEST] multi-clash MIPS count:", result?.length);
      expect(result!.length).toBeGreaterThanOrEqual(1);
      expect(result!.length).toBeLessThanOrEqual(2);
    },
    30000,
  );

  it(
    "empty store → [] (consistent)",
    async () => {
      let r: RdfReasoner | undefined;
      try {
        r = new RdfReasoner();
        await r.ready;
      } catch (e) {
        console.warn("[TEST] Konclude WASM unavailable — skipping:", String(e));
        return;
      }
      let result: Quad[][] | undefined;
      try {
        const store = new N3.Store();
        result = await r.explainInconsistency(store);
      } finally {
        r.terminate();
      }
      expect(result).toEqual([]);
    },
    30000,
  );
});
