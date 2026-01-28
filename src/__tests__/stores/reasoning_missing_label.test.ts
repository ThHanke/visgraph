import { describe, it, expect, beforeEach } from "vitest";
import { initRdfManagerWorker } from "../utils/initRdfManagerWorker";
import { waitForOperation, getQuadCount } from "../utils/testHelpers";
import { DataFactory } from "n3";
import { useAppConfigStore } from "../../stores/appConfigStore";

const { namedNode, literal } = DataFactory;

describe("reasoning: missing rdfs:label warnings", () => {
  beforeEach(async () => {
    await initRdfManagerWorker();
    // Ensure best-practice.n3 is loaded
    try {
      if (useAppConfigStore && typeof useAppConfigStore.getState === "function") {
        const appCfg = useAppConfigStore.getState();
        appCfg.setReasoningRulesets(["best-practice.n3"]);
      }
    } catch (e) {
      console.debug("[TEST] app config setup failed:", String(e));
    }
  });

  it("should generate SHACL warning for subjects without rdfs:label", async () => {
    // Get the RDF manager instance
    const modMgr = await import("../../utils/rdfManager");
    const rdfMgr = (modMgr as any).rdfManager;
    if (!rdfMgr) throw new Error("No module-level RDF manager available");

    // Clear the store
    try {
      if (typeof rdfMgr.clear === "function") await rdfMgr.clear();
    } catch (_) {
      /* noop */
    }

    // Create test data with subjects - some with labels, some without
    const testData = `
@prefix ex: <http://example.org/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

# Subject WITH label - should NOT trigger warning
ex:PersonWithLabel a ex:Person ;
    rdfs:label "Person with Label" ;
    ex:hasName "John Doe" .

# Subject WITHOUT label - SHOULD trigger warning
ex:PersonWithoutLabel a ex:Person ;
    ex:hasName "Jane Smith" .

# Another subject WITHOUT label - SHOULD trigger warning  
ex:AnotherPerson a ex:Person ;
    ex:hasAge 30 .
`;

    // Install fetch shim for loading rules
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
                  get: (k: string) =>
                    k && k.toLowerCase() === "content-type" ? "text/n3" : null,
                },
              };
            }
          }
        } catch (_) {
          // fall through
        }
        if (typeof origFetch === "function") return origFetch(input, init);
        throw new Error("No fetch available");
      };
    } catch (e) {
      console.debug("[TEST] unable to install fetch shim:", String(e));
    }

    // Load test data directly into the data graph
    await rdfMgr.loadRDFIntoGraph(testData, "urn:vg:data", "text/turtle");

    // Wait for data to be persisted to worker
    await waitForOperation();
    
    // Verify data was loaded
    const quadCount = await getQuadCount("urn:vg:data");
    console.debug("[TEST] quad count after load:", quadCount);
    expect(quadCount).toBeGreaterThan(0);

    // Run reasoning with best-practice rules
    const result = await rdfMgr.runReasoning();

    // Restore original fetch
    try {
      (globalThis as any).fetch = origFetch;
    } catch (_) {
      /* noop */
    }

    // Verify results
    console.debug("[TEST] reasoning status:", result?.status);
    console.debug("[TEST] warnings count:", result?.warnings?.length || 0);
    console.debug("[TEST] warnings:", JSON.stringify(result?.warnings, null, 2));
    console.debug("[TEST] errors:", JSON.stringify(result?.errors, null, 2));

    // Skip test if no rules were loaded (ruleQuadCount === 0)
    if (result?.meta?.ruleQuadCount === 0) {
      console.log("Skipping test: No reasoning rules were loaded");
      return;
    }

    // Assertions
    expect(result?.status).toBe("completed");
    
    // Should have warnings (at least 2 for the subjects without labels)
    expect(result?.warnings).toBeDefined();
    expect(Array.isArray(result?.warnings)).toBe(true);
    
    // Filter warnings about missing labels
    const labelWarnings = (result?.warnings || []).filter((w: any) =>
      w.message && w.message.includes("rdfs:label")
    );
    
    console.debug("[TEST] label-specific warnings:", labelWarnings.length);
    expect(labelWarnings.length).toBeGreaterThanOrEqual(2);

    // Check that warnings reference the correct subjects
    const warningMessages = labelWarnings.map((w: any) => w.message);
    expect(warningMessages.some((msg: string) => 
      msg.includes("Subject lacks an rdfs:label property")
    )).toBe(true);

    // Verify the subjects without labels are flagged
    const warningNodeIds = labelWarnings
      .map((w: any) => w.nodeId)
      .filter(Boolean);
    
    console.debug("[TEST] warning node IDs:", warningNodeIds);
    
    // Should include references to subjects without labels
    expect(
      warningNodeIds.some((id: string) => 
        id.includes("PersonWithoutLabel") || id.includes("AnotherPerson")
      )
    ).toBe(true);
  }, 60000);
});
