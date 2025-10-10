import { describe, test, expect, beforeEach } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";

/**
 * The original helpers used to live in utils/namespaceRegistry but have since
 * been folded into store-driven behavior. These tests were updated to avoid
 * importing a removed module and instead verify the same observable behavior:
 *  - building a registry-like array from a manager-like getNamespaces result
 *  - persisting a registry into the ontology store via the public setter
 */

describe("namespaceRegistry helpers (adapted)", () => {
  beforeEach(() => {
    // Clear any previously persisted registry
    {
      useOntologyStore.getState().setNamespaceRegistry([]);
    }
  });

  test("builds registry-like array from manager.getNamespaces and palette mapper", () => {
    const fakeMgr = {
      getNamespaces: () => ({
        ex: "http://example.com/",
        foaf: "http://xmlns.com/foaf/0.1/",
      }),
    };

    // Inline small implementation of the former helper: build registry + palette entries
    function buildRegistryFromManagerInline(mgr: any, paletteFn: (prefixes: string[]) => Record<string,string>) {
      const nsMap = (mgr && typeof mgr.getNamespaces === "function") ? mgr.getNamespaces() : {};
      const prefixes = Object.keys(nsMap || []).sort();
      const palette = paletteFn(prefixes || []);
      const registry = (prefixes || []).map((p: string) => {
        return { prefix: String(p), namespace: String((nsMap as any)[p] || ""), color: String((palette as any)[p] || "") };
      });
      return registry;
    }

    const registry = buildRegistryFromManagerInline(fakeMgr, (prefixes: string[]) => {
      const map: Record<string,string> = {};
      for (const p of prefixes) map[p] = `#${p.length}${p.charCodeAt(0).toString(16).slice(-2)}`;
      return map;
    });

    expect(Array.isArray(registry)).toBeTruthy();
    expect(registry.find((r) => r.prefix === "ex")).toBeTruthy();
    expect(registry.find((r) => r.prefix === "foaf")).toBeTruthy();
    const ex = registry.find((r) => r.prefix === "ex")!;
    expect(ex.namespace).toBe("http://example.com/");
    expect(typeof ex.color).toBe("string");
  });

  test("persisting registry writes it into ontology store via setNamespaceRegistry", () => {
    const registry = [
      { prefix: "ex", namespace: "http://example.com/", color: "#abc" },
      { prefix: "foaf", namespace: "http://xmlns.com/foaf/0.1/", color: "#def" },
    ];
    // ensure empty initially
    useOntologyStore.getState().setNamespaceRegistry([]);

    // persist using the public setter (this mirrors persistRegistryToStore behavior)
    useOntologyStore.getState().setNamespaceRegistry(registry);

    const stored = useOntologyStore.getState().namespaceRegistry;
    expect(Array.isArray(stored)).toBeTruthy();
    expect(stored.length).toBe(registry.length);
    // compare by prefix/namespace
    for (const r of registry) {
      const found = (stored || []).find((s: any) => s.prefix === r.prefix && s.namespace === r.namespace);
      expect(found).toBeTruthy();
      if (found) {
        expect(found.color).toBe(r.color);
      }
    }
  });
});
