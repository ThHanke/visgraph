// @vitest-environment node

/**
 * Inference-graph persistence test.
 *
 * Verifies that triples derived by the N3 Reasoner are correctly written to
 * the `urn:vg:inferred` named graph in the permanent store after runReasoning().
 *
 * Data: a simple rdfs:subClassOf hierarchy + one instance.
 * Rule: owl-rl.n3 includes RDFS subclass propagation.
 * Expected inference: ex:inst1 a ex:B  (from ex:inst1 a ex:A, ex:A rdfs:subClassOf ex:B)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initRdfManagerWorker } from "../utils/initRdfManagerWorker";
import { rdfManager } from "../../utils/rdfManager";
import { getQuadCount } from "../utils/testHelpers";

// ---------------------------------------------------------------------------
// Inline fixture: minimal Turtle with a subclass hierarchy and one instance
// ---------------------------------------------------------------------------
const TURTLE_FIXTURE = `
@prefix ex:   <http://example.org/infer#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

ex:A rdfs:subClassOf ex:B .
ex:inst1 a ex:A .
`.trim();

const DATA_GRAPH = "urn:vg:data";

// ---------------------------------------------------------------------------
// Fetch shim: serves local rule files from public/reasoning-rules/
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
          headers: { get: (k: string) => (k?.toLowerCase() === "content-type" ? "text/n3" : null) },
        };
      }
    } catch (_) {
      // fall through to original fetch
    }
    if (typeof origFetch === "function") return origFetch(input, init);
    throw new Error(`No fetch available for: ${input}`);
  };
}

function uninstallFetchShim() {
  (globalThis as any).fetch = origFetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("inference persistence to urn:vg:inferred", () => {
  beforeEach(async () => {
    await initRdfManagerWorker();
    rdfManager.clear();
    await new Promise((r) => setTimeout(r, 100));
    installFetchShim();
  });

  afterEach(() => {
    uninstallFetchShim();
  });

  it("persists inferred triples to urn:vg:inferred after runReasoning", async () => {
    // Load the test data
    await rdfManager.loadRDFIntoGraph(TURTLE_FIXTURE, DATA_GRAPH, "text/turtle");
    await new Promise((r) => setTimeout(r, 200));

    const dataBefore = await getQuadCount(DATA_GRAPH);
    expect(dataBefore).toBeGreaterThan(0);

    // Run OWL-RL reasoning (includes rdfs:subClassOf propagation)
    const result = await rdfManager.runReasoning({ rulesets: ["owl-rl.n3"] });

    expect(result.status).toBe("completed");

    // Skip if the ruleset couldn't be loaded (e.g. CI without local files)
    if ((result.meta as any)?.ruleQuadCount === 0) {
      console.warn("[TEST] Skipping persistence assertion: no rule quads loaded");
      return;
    }

    const inferredCount = await getQuadCount("urn:vg:inferred");
    expect(inferredCount).toBeGreaterThan(0);
  }, 30000);
});
