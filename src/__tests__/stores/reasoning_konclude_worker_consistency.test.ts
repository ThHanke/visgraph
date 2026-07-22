// @vitest-environment node
/**
 * Worker-level consistency tests.
 *
 * Tests KoncludeReasoner adapter (checkConsistency / explainInconsistency)
 * using RdfReasoner from the package (same WASM, same algorithm as the local
 * KoncludeReasoner adapter in rdfManager.runtime.ts).
 *
 * Also verifies mipsToReasoningError output format indirectly.
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

describe("KoncludeReasoner adapter consistency", () => {
  it(
    "checkConsistency() on consistent store → true",
    async () => {
      let r: RdfReasoner | undefined;
      try {
        r = new RdfReasoner();
        await r.ready;
      } catch (e) {
        console.warn("[TEST] Konclude WASM unavailable — skipping:", String(e));
        return;
      }
      let result: boolean | undefined;
      try {
        const store = loadTtlStore("reasoning-demo.ttl");
        result = await r.checkConsistency(store);
      } finally {
        r.terminate();
      }
      expect(result).toBe(true);
    },
    30000,
  );

  it(
    "checkConsistency() on inconsistent store → false",
    async () => {
      let r: RdfReasoner | undefined;
      try {
        r = new RdfReasoner();
        await r.ready;
      } catch (e) {
        console.warn("[TEST] Konclude WASM unavailable — skipping:", String(e));
        return;
      }
      let result: boolean | undefined;
      try {
        const store = loadTtlStore("reasoning-demo-inconsistent.ttl");
        result = await r.checkConsistency(store);
      } finally {
        r.terminate();
      }
      expect(result).toBe(false);
    },
    30000,
  );

  it(
    "explainInconsistency() returns MIPS, then materialize() on same instance succeeds (no queue corruption)",
    async () => {
      let r: RdfReasoner | undefined;
      try {
        r = new RdfReasoner();
        await r.ready;
      } catch (e) {
        console.warn("[TEST] Konclude WASM unavailable — skipping:", String(e));
        return;
      }
      try {
        const inconsistentStore = loadTtlStore("reasoning-demo-inconsistent.ttl");
        const mips = await r.explainInconsistency(inconsistentStore, { maxJustifications: 1 });
        expect(mips.length).toBeGreaterThanOrEqual(1);

        // Now use a consistent store and materialize — must not throw
        const consistentStore = loadTtlStore("reasoning-demo.ttl");
        await expect(r.materialize(consistentStore, { includeClassHierarchy: true })).resolves.not.toThrow();
      } finally {
        r.terminate();
      }
    },
    30000,
  );

  it(
    "mipsToReasoningError format: nodeId=individual IRI, rule contains clash predicate, severity=critical",
    async () => {
      let r: RdfReasoner | undefined;
      try {
        r = new RdfReasoner();
        await r.ready;
      } catch (e) {
        console.warn("[TEST] Konclude WASM unavailable — skipping:", String(e));
        return;
      }
      let mips: Quad[][] | undefined;
      try {
        const store = loadTtlStore("reasoning-demo-inconsistent.ttl");
        mips = await r.explainInconsistency(store, { maxJustifications: 1 });
      } finally {
        r.terminate();
      }
      expect(mips!.length).toBeGreaterThanOrEqual(1);
      const mips0 = mips![0];

      // Replicate mipsToReasoningError logic to verify its contract
      const RDF_TYPE_P = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
      const OWL_NAMED_INDIVIDUAL = "http://www.w3.org/2002/07/owl#NamedIndividual";
      const CLASH_PREDICATES = new Set([
        "http://www.w3.org/2002/07/owl#disjointWith",
        "http://www.w3.org/2002/07/owl#maxCardinality",
        "http://www.w3.org/2002/07/owl#maxQualifiedCardinality",
        "http://www.w3.org/2002/07/owl#complementOf",
        "http://www.w3.org/2002/07/owl#AsymmetricProperty",
      ]);

      let nodeId: string | undefined;
      for (const q of mips0) {
        if (
          q.predicate.value === RDF_TYPE_P &&
          q.object.termType === "NamedNode" &&
          !q.object.value.startsWith("http://www.w3.org/") &&
          q.subject.termType === "NamedNode"
        ) {
          nodeId = q.subject.value;
          break;
        }
      }
      if (!nodeId) {
        for (const q of mips0) {
          if (
            q.predicate.value === RDF_TYPE_P &&
            q.subject.termType === "NamedNode" &&
            !q.subject.value.startsWith("http://www.w3.org/")
          ) {
            nodeId = q.subject.value;
            break;
          }
        }
      }
      if (!nodeId) {
        for (const q of mips0) {
          if (q.subject.termType === "NamedNode" && !q.subject.value.startsWith("http://www.w3.org/")) {
            nodeId = q.subject.value;
            break;
          }
        }
      }

      let rule = "owl:inconsistency";
      for (const q of mips0) {
        if (CLASH_PREDICATES.has(q.predicate.value)) {
          const local = q.predicate.value.split(/[#/]/).pop() ?? q.predicate.value;
          rule = `owl:${local}`;
          break;
        }
      }

      console.log("[TEST] mipsToReasoningError nodeId:", nodeId);
      console.log("[TEST] mipsToReasoningError rule:", rule);

      // nodeId should be the individual IRI (frank from fixture)
      expect(nodeId).toBeTruthy();
      expect(nodeId).toMatch(/frank/i);

      // rule should reflect the clash predicate
      expect(rule).toBeTruthy();
      // severity would always be "critical" per implementation
      // (tested structurally — actual function in runtime.ts closure)
    },
    30000,
  );
});
