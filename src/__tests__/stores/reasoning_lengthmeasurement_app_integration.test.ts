import { describe, it, expect, beforeEach } from "vitest";
import { initRdfManagerWorker } from "../utils/initRdfManagerWorker";
import { getQuadCount, findQuads, waitForOperation } from "../utils/testHelpers";
import { DataFactory } from "n3";
import { useOntologyStore } from "../../../src/stores/ontologyStore";
import { useAppConfigStore } from "../../../src/stores/appConfigStore";
import { OWL, RDF, RDFS } from "../../constants/vocabularies";

const { namedNode } = DataFactory;

beforeEach(async () => {
  await initRdfManagerWorker();
});

describe("reasoning (app integration) with LengthMeasurement ttl", () => {
  it(
    "uses the real app codepath: load data, load referenced ontologies, run reasoning (OWL-RL) and report results",
    async () => {
      // make background tasks run synchronously in tests
      const origRIC = (globalThis as any).requestIdleCallback;
      (globalThis as any).requestIdleCallback = (fn: any) => {
        try {
          fn();
        } catch (_) {
          /* ignore */
        }
      };

      try {
        const dataUrl = encodeURI(
          "https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/refs/heads/main/LengthMeasurement.ttl",
        );

        // Use the module-level rdfManager to mirror the real app runtime instance.
        const ontologyApi: any = useOntologyStore as any;
        const ontologyState = ontologyApi.getState();
        const modMgr = await import("../../../src/utils/rdfManager");
        const rdfMgr = modMgr && (modMgr as any).rdfManager ? (modMgr as any).rdfManager : null;
        if (!rdfMgr) throw new Error("No module-level RDF manager available");

        // clear manager state for deterministic run (best-effort)
        try {
          if (typeof rdfMgr.clear === "function") rdfMgr.clear();
        } catch (_) {/* noop */}

        // Ensure app config explicitly requests owl-rl.n3 ruleset and enables autoload to mimic app startup
        try {
          if (useAppConfigStore && typeof useAppConfigStore.getState === "function") {
            try {
              const appCfg = useAppConfigStore.getState();
              // Restore the app rulesets so the N3 reasoner runs with configured rules (best-practice + owl-rl)
              appCfg.setReasoningRulesets(["best-practice.n3","owl-rl.n3"]);
              // keep persisted autoload enabled so ontologies are still preloaded
              if (typeof appCfg.setPersistedAutoload === "function") {
                try { appCfg.setPersistedAutoload(true); } catch (_) { /* ignore */ }
              }
              console.debug("[TEST] app config setReasoningRulesets + persistedAutoload");
            } catch (e) {
              console.debug("[TEST] setReasoningRulesets/setPersistedAutoload failed:", String(e));
            }
          }
        } catch (e) {
          console.debug("[TEST] app config access failed:", String(e));
        }

        // Best-effort: pre-load core ontologies that the real app autoloads on startup so reasoning sees the same TBox.
        try {
          const coreOntos = [
            OWL.namespace,
            RDF.namespace,
            RDFS.namespace,
          ];
          if (typeof ontologyState.loadAdditionalOntologies === "function") {
            try {
              await ontologyState.loadAdditionalOntologies(coreOntos, (p:number,m:string) => console.debug("[TEST] preload ontologies progress", p, m));
              console.debug("[TEST] preloaded core ontologies via loadAdditionalOntologies");
            } catch (loadErr) {
              console.debug("[TEST] preload core ontologies failed (continuing):", String(loadErr));
            }
          } else if (typeof ontologyState.loadOntology === "function") {
            for (const o of coreOntos) {
              try {
                await ontologyState.loadOntology(o, { autoload: true });
              } catch (e) {
                console.debug("[TEST] loadOntology(core) failed (continuing):", o, String(e));
              }
            }
          }
        } catch (e) {
          console.debug("[TEST] core ontologies pre-load failed (continuing):", String(e));
        }

        // Install a fetch shim that serves local rule files from public/reasoning-rules when runReasoning fetches them
        const origFetch = (globalThis as any).fetch;
        try {
          const fs = await import("fs");
          (globalThis as any).fetch = async (input: any, init?: any) => {
            try {
              const urlStr = String(input || "");
              if (urlStr.includes("/reasoning-rules/")) {
                const name = urlStr.replace(/^.*\/reasoning-rules\//, "");
                const filePath = `public/reasoning-rules/${name}`;
                if ((fs as any).existsSync(filePath)) {
                  const text = (fs as any).readFileSync(filePath, "utf8");
                  return {
                    ok: true,
                    text: async () => text,
                    status: 200,
                    headers: {
                      get: (k: string) => (k && k.toLowerCase() === "content-type" ? "text/n3" : null),
                    },
                  };
                }
              }
            } catch (_) {
              // fall through to original fetch
            }
            if (typeof origFetch === "function") return origFetch(input, init);
            throw new Error("No fetch available to handle request");
          };
        } catch (e) {
          console.debug("[TEST] unable to install local rules fetch shim:", String(e));
        }

        // Try to use fixture if present, otherwise load remote URL via manager
        const fs = await import("fs");
        const fixturePath = "src/__tests__/fixtures/LengthMeasurement.ttl";
        if ((fs as any).existsSync(fixturePath)) {
          const content = (fs as any).readFileSync(fixturePath, "utf8");
          if (typeof ontologyState.loadOntologyFromRDF === "function") {
            await ontologyState.loadOntologyFromRDF(content, undefined, false, "urn:vg:data", "LengthMeasurement.ttl");
            console.debug("[TEST] loaded data via loadOntologyFromRDF fixture:", fixturePath);
          } else if (typeof rdfMgr.loadRDFFromUrl === "function") {
            await rdfMgr.loadRDFFromUrl(dataUrl, "urn:vg:data", { timeoutMs: 60000, useWorker: false });
          } else {
            throw new Error("No loader available to load fixture");
          }
        } else {
          // Load remote TTL via manager (main-thread parse)
          await rdfMgr.loadRDFFromUrl(dataUrl, "urn:vg:data", { timeoutMs: 60000, useWorker: false });
          console.debug("[TEST] loaded data via remote URL:", dataUrl);
        }

        // Discover referenced ontologies and load them synchronously so they are present before reasoning
        try {
          const disc = await ontologyState.discoverReferencedOntologies({
            graphName: "urn:vg:data",
            load: "sync",
            timeoutMs: 60000,
          });
          console.debug("[TEST] discoverReferencedOntologies returned:", disc && (disc as any).candidates ? (disc as any).candidates.length : "no-candidates");
        } catch (e) {
          console.debug("[TEST] discoverReferencedOntologies(sync) failed:", String(e));
        }

        // Snapshot counts before reasoning (for diagnostics)
        try {
          const totalBefore = await getQuadCount();
          const dataBefore = await getQuadCount("urn:vg:data");
          const ontBefore = await getQuadCount("urn:vg:ontologies");
          console.debug("[TEST] triple counts before reasoning", { totalBefore, dataBefore, ontBefore });
        } catch (_) {/* noop */}

        // Invoke the existing reasoning pipeline (real app code)
        // Wait for ontology graph population before running reasoning. Some referenced ontologies may take time to load.
        async function waitForGraph(minCount = 1, timeoutMs = 60000, pollMs = 500) {
          // Stronger manager-aware waiter:
          // - Wait until parsingInProgress === false AND reconcileInProgress is null/false (no reconcile happening).
          // - Also ensure subjectChangeBuffer is empty and subjectFlushTimer is not set (no pending subject emissions).
          // - After manager is idle, wait a conservative grace period and return current ontology graph count.
          const start = Date.now();
          const mgr: any = rdfMgr;
          const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

          // Step A: wait for manager flags to indicate idle
          while (Date.now() - start < timeoutMs) {
            try {
              const parsing = !!mgr && !!mgr.parsingInProgress;
              const reconcileInFlight = !!mgr && !!(mgr.reconcileInProgress);
              const subjectBufferNotEmpty = !!mgr && mgr.subjectChangeBuffer && mgr.subjectChangeBuffer.size > 0;
              const subjectTimerActive = !!mgr && !!mgr.subjectFlushTimer;
              if (!parsing && !reconcileInFlight && !subjectBufferNotEmpty && !subjectTimerActive) {
                break;
              }
            } catch (_) {
              // ignore and continue polling
            }
            await sleep(pollMs);
          }

          // Step B: conservative grace to ensure any final writes complete
          await sleep(2000);

          // Step C: return authoritative count from manager store
          try {
            const count = await getQuadCount("urn:vg:ontologies");
            return count;
          } catch (_) {
            return 0;
          }
        }

        console.debug("[TEST] waiting for ontologies to populate (up to 60s)...");
        const ontCount = await waitForGraph(1, 60000, 500);
        console.debug("[TEST] ontologies count after wait:", ontCount);

        const t0 = Date.now();
        // Pass the RDFManager instance (not just the underlying store) because the app runtime
        // invokes the reasoner with the manager and some reasoner behaviors rely on manager APIs.
        const result = await rdfMgr.runReasoning();
        const duration = Date.now() - t0;

        // restore original fetch
        try {
          (globalThis as any).fetch = origFetch;
        } catch (_) {/* noop */}

        // Count persisted inferred triples
        const inferredCount = await getQuadCount("urn:vg:inferred");
        const inferredFromResult = Array.isArray(result && (result as any).inferences) ? (result as any).inferences.length : 0;

        // Emit diagnostics
        console.debug("[TEST] reasoning result.status:", result && (result as any).status);
        console.debug("[TEST] reasoning duration ms:", duration);
        console.debug("[TEST] inferredCount (urn:vg:inferred):", inferredCount);
        console.debug("[TEST] result.inferences.length:", inferredFromResult);
        console.debug("[TEST] result.errors:", result && (result as any).errors);
        console.debug("[TEST] result.warnings:", result && (result as any).warnings);

        // Basic assertion: reasoning completed (we rely on the real app code)
        expect(result && (result as any).status).toBe("completed");

        // Log final triple totals
        try {
          const totalAfter = await getQuadCount();
          console.debug("[TEST] triple counts after reasoning", { totalAfter });
        } catch (_) {/* noop */}
      } finally {
        try {
          (globalThis as any).requestIdleCallback = origRIC;
        } catch (_) {/* noop */}
      }
    },
    120000,
  );
});
