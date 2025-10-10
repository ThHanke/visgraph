import { describe, it, expect } from "vitest";
import { useAppConfigStore } from "../../stores/appConfigStore";
import { useOntologyStore } from "../../stores/ontologyStore";
import { rdfManager } from "../../utils/rdfManager";
import { computeTermDisplay } from "../../utils/termUtils";
import { FIXTURES } from "../fixtures/rdfFixtures";

/**
 * Debug test: run loadAdditionalOntologies using appConfigStore.config.additionalOntologies
 * and capture namespace snapshots + computeTermDisplay outputs.
 *
 * This is a non-invasive debug that logs runtime state so we can see why configured
 * additional ontologies may not appear in the UI or why prefixes are missing.
 */
describe("debug: loadAdditionalOntologies runtime snapshot", () => {
  it("runs autoload from app config and logs namespaces + loadedOntologies", async () => {
    // reset stores for a clean run
    {
      (useAppConfigStore.getState().resetToDefaults || (() => {}))();
    }
    {
      (useOntologyStore.getState().clearOntologies || (() => {}))();
    }

    // Read configured additionalOntologies from app config
    const cfg = useAppConfigStore.getState().config || {};
    let list = Array.isArray(cfg.additionalOntologies) ? cfg.additionalOntologies.slice() : [];

    // If none configured, populate a reasonable set from fixtures so we can exercise the flow.
    if (!list || list.length === 0) {
      list = [
        "https://www.w3.org/TR/vocab-org/",
        "http://xmlns.com/foaf/0.1/",
        "https://spec.industrialontologies.org/ontology/core/Core/",
      ];
      // Also include a fixture URL that maps to local fixtures (vitest will resolve via fixtures code paths)
      // Note: some tests use FIXTURES keys as URLs in fetch mocks; include one to exercise inline-load path.
      list.push("https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/example.ttl");
    }

    console.debug("[DEBUG] appConfig.additionalOntologies (used list):", list);

    // Run loadAdditionalOntologies with progress callback
    await useOntologyStore.getState().loadAdditionalOntologies(list, (p, m) => {
      {
        console.debug(`[DEBUG] loadAdditionalOntologies progress ${p}%: ${m}`);
      }
    });

    // After load, capture rdfManager namespaces
    try {
      const mgr = useOntologyStore.getState().getRdfManager();
      const ns = mgr && typeof mgr.getNamespaces === "function" ? mgr.getNamespaces() : {};
      console.debug("[DEBUG] rdfManager.getNamespaces()", ns);
    } catch (e) {
      console.error("[DEBUG] failed to read rdfManager.getNamespaces()", e);
    }

    // Capture loadedOntologies state
    try {
      const loaded = useOntologyStore.getState().loadedOntologies || [];
      console.debug("[DEBUG] loadedOntologies:", loaded.map((o: any) => ({ url: o.url, namespaces: o.namespaces })));
    } catch (e) {
      console.error("[DEBUG] failed to read loadedOntologies", e);
    }

    // Compute term display for common IRIs
    try {
      const mgr = useOntologyStore.getState().getRdfManager();
      const samples = [
        "http://www.w3.org/2002/07/owl#Class",
        "http://xmlns.com/foaf/0.1/Person",
        "http://example.org/test#MyClass",
      ];
      for (const s of samples) {
        try {
          const td = computeTermDisplay(String(s), mgr as any);
          console.debug("[DEBUG] computeTermDisplay", s, "=>", td);
        } catch (err) {
          console.error("[DEBUG] computeTermDisplay failed for", s, err);
        }
      }
    } catch (e) {
      console.error("[DEBUG] computeTermDisplay error", e);
    }

    // Final: ensure the test completes successfully (this is just a debug runner)
    expect(true).toBe(true);
  }, 20000);
});
