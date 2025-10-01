import { describe, test, expect, beforeEach } from "vitest";
import { buildRegistryFromManager, persistRegistryToStore } from "../../utils/namespaceRegistry";
import { useOntologyStore } from "../../stores/ontologyStore";

describe("namespaceRegistry helpers", () => {
  beforeEach(() => {
    // Clear any previously persisted registry
    try {
      useOntologyStore.getState().setNamespaceRegistry([]);
    } catch (_) { void 0; }
  });

  test("buildRegistryFromManager builds registry and derives palette entries", () => {
    const fakeMgr = {
      getNamespaces: () => ({
        ex: "http://example.com/",
        foaf: "http://xmlns.com/foaf/0.1/",
      }),
    };

    const registry = buildRegistryFromManager(fakeMgr, (prefixes: string[]) => {
      // deterministic palette for test
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

  test("persistRegistryToStore writes registry into ontology store", () => {
    const registry = [
      { prefix: "ex", namespace: "http://example.com/", color: "#abc" },
      { prefix: "foaf", namespace: "http://xmlns.com/foaf/0.1/", color: "#def" },
    ];
    // ensure empty initially
    useOntologyStore.getState().setNamespaceRegistry([]);

    // persist
    persistRegistryToStore(registry);

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
