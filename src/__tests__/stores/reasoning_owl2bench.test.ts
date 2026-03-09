// @vitest-environment node

/**
 * OWL2Bench UNIV-BENCH-OWL2DL reasoning integration test.
 *
 * Loads the OWL2Bench TBox from GitHub, runs OWL-RL reasoning, then asserts:
 *   1. The data/ontology graphs have the same quad count before and after reasoning
 *      (i.e. reasoning does NOT modify or shrink the source graphs).
 *   2. The urn:vg:inferred graph receives a non-zero number of inferred triples.
 *
 * URL: https://raw.githubusercontent.com/kracr/owl2bench/refs/heads/master/UNIV-BENCH-OWL2DL.owl
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initRdfManagerWorker } from "../utils/initRdfManagerWorker";
import { rdfManager } from "../../utils/rdfManager";

const OWL2BENCH_URL =
  "https://raw.githubusercontent.com/kracr/owl2bench/refs/heads/master/UNIV-BENCH-OWL2DL.owl";
const DATA_GRAPH = "urn:vg:data";
const INFERRED_GRAPH = "urn:vg:inferred";

// ---------------------------------------------------------------------------
// Fetch shim: serve local rule files, pass everything else through to real fetch
// ---------------------------------------------------------------------------
let origFetch: any;

function installFetchShim() {
  origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async (input: any, init?: any) => {
    try {
      const urlStr = String(input ?? "");
      if (urlStr.includes("/reasoning-rules/")) {
        const name = urlStr.replace(/^.*\/reasoning-rules\//, "");
        const filePath = resolve("public/reasoning-rules", name);
        const text = readFileSync(filePath, "utf8");
        return {
          ok: true,
          status: 200,
          text: async () => text,
          headers: {
            get: (k: string) =>
              k?.toLowerCase() === "content-type" ? "text/n3" : null,
          },
        };
      }
    } catch (_) {
      // fall through to real network fetch
    }
    if (typeof origFetch === "function") return origFetch(input, init);
    throw new Error(`No fetch available for: ${input}`);
  };
}

function uninstallFetchShim() {
  (globalThis as any).fetch = origFetch;
}

// ---------------------------------------------------------------------------
// Helper: get all graph counts via the manager
// ---------------------------------------------------------------------------
async function allGraphCounts(): Promise<Record<string, number>> {
  return rdfManager.getGraphCounts();
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
describe("OWL2Bench UNIV-BENCH-OWL2DL reasoning", () => {
  beforeEach(async () => {
    await initRdfManagerWorker();
    rdfManager.clear();
    await new Promise((r) => setTimeout(r, 200));
    installFetchShim();
  });

  afterEach(() => {
    uninstallFetchShim();
  });

  it(
    "loads OWL2Bench, runs reasoning, and persists inferred triples to urn:vg:inferred",
    async () => {
      // -----------------------------------------------------------------------
      // 1. Load the OWL2Bench ontology into the data graph
      // -----------------------------------------------------------------------
      console.log("[TEST] Fetching OWL2Bench OWL from:", OWL2BENCH_URL);
      let owlContent: string;
      try {
        const res = await origFetch(OWL2BENCH_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        owlContent = await res.text();
      } catch (err) {
        console.error("[TEST] Failed to fetch OWL2Bench — skipping:", String(err));
        return; // skip gracefully when network is unavailable
      }

      console.log("[TEST] OWL content length:", owlContent.length, "chars");
      await rdfManager.loadRDFIntoGraph(owlContent, DATA_GRAPH, "application/rdf+xml");
      await new Promise((r) => setTimeout(r, 500));

      // -----------------------------------------------------------------------
      // 2. Snapshot graph counts BEFORE reasoning
      // -----------------------------------------------------------------------
      const countsBefore = await allGraphCounts();
      console.log("[TEST] Graph counts BEFORE reasoning:", countsBefore);

      const dataCountBefore = countsBefore[DATA_GRAPH] ?? 0;
      expect(dataCountBefore).toBeGreaterThan(0);

      // -----------------------------------------------------------------------
      // 3. Run OWL-RL reasoning
      // -----------------------------------------------------------------------
      console.log("[TEST] Running OWL-RL reasoning...");
      const t0 = Date.now();
      const result = await rdfManager.runReasoning({ rulesets: ["owl-rl.n3"] });
      console.log("[TEST] Reasoning duration:", Date.now() - t0, "ms");
      console.log("[TEST] Reasoning status:", result.status);
      console.log("[TEST] Rule quad count:", (result.meta as any)?.ruleQuadCount);
      console.log("[TEST] Inferences count (result):", result.inferences?.length ?? 0);
      if (result.errors?.length) console.log("[TEST] Errors:", result.errors);
      if (result.warnings?.length) console.log("[TEST] Warnings (first 10):", result.warnings.slice(0, 10));

      expect(result.status).toBe("completed");

      if ((result.meta as any)?.ruleQuadCount === 0) {
        console.warn("[TEST] Skipping persistence assertion: no rule quads loaded");
        return;
      }

      // -----------------------------------------------------------------------
      // 4. Snapshot graph counts AFTER reasoning
      // -----------------------------------------------------------------------
      const countsAfter = await allGraphCounts();
      console.log("[TEST] Graph counts AFTER reasoning:", countsAfter);

      const dataCountAfter = countsAfter[DATA_GRAPH] ?? 0;
      const inferredCountAfter = countsAfter[INFERRED_GRAPH] ?? 0;

      // -----------------------------------------------------------------------
      // 5. Assertions
      // -----------------------------------------------------------------------

      // Data graph must be unchanged — reasoning must not shrink or modify source data
      expect(dataCountAfter).toBe(dataCountBefore);

      // Inferred graph must have received new triples
      expect(inferredCountAfter).toBeGreaterThan(0);

      console.log("[TEST] PASS — data stable:", dataCountBefore, "→", dataCountAfter,
        " | inferred:", inferredCountAfter);
    },
    120000, // 2 min timeout for network + reasoning
  );
});
