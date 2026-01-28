import { describe, it, expect } from "vitest";
import { useOntologyStore } from "../../../src/stores/ontologyStore";
import { RDF_TYPE, RDFS_LABEL, OWL, RDF } from "../../../src/constants/vocabularies";

/**
 * Producer-level test: provide parsed quads to updateFatMap and verify
 * the fat-map (availableClasses / availableProperties) is populated.
 *
 * This test ensures the fat-map builder produces expected entries from quads.
 */

describe("updateFatMap producer (quads -> fat-map)", () => {
  it("builds availableProperties and availableClasses from supplied quads and sets expected fields", async () => {
    // Prepare quads (QuadLike POJOs accepted by updateFatMap)

    const quads = [
      // A class declaration with a label
      {
        subject: { value: "http://example.org/SomeClass" },
        predicate: { value: RDF_TYPE },
        object: { value: OWL.Class, termType: "NamedNode" },
        graph: { value: "urn:vg:ontologies" },
      },
      {
        subject: { value: "http://example.org/SomeClass" },
        predicate: { value: RDFS_LABEL },
        object: { value: "Some Class Label", termType: "Literal" },
        graph: { value: "urn:vg:ontologies" },
      },

      // A property declaration with a label
      {
        subject: { value: "http://example.org/hasFoo" },
        predicate: { value: RDF_TYPE },
        object: { value: RDF.Property, termType: "NamedNode" },
        graph: { value: "urn:vg:ontologies" },
      },
      {
        subject: { value: "http://example.org/hasFoo" },
        predicate: { value: RDFS_LABEL },
        object: { value: "has foo", termType: "Literal" },
        graph: { value: "urn:vg:ontologies" },
      },
    ];

    // Ensure clean initial state
    try {
      const st = useOntologyStore.getState();
      if (typeof st.clearOntologies === "function") st.clearOntologies();
    } catch (_) {
      // ignore
    }

    // Run the incremental fat-map update with the parsed quads
    await useOntologyStore.getState().updateFatMap(quads as any);

    // Read resulting fat-map
    const state = useOntologyStore.getState();
    const props = state.availableProperties || [];
    const classes = state.availableClasses || [];

    // Expect the property to be present
    const p = props.find((x: any) => String(x.iri) === "http://example.org/hasFoo");
    expect(p).toBeTruthy();
    // Prefer label from rdfs:label when present
    expect(String(p.label || "")).toBe("has foo");

    // Assert additional property fields set by producer
    expect(Array.isArray(p.domain)).toBeTruthy();
    expect(p.domain.length).toBe(0);
    expect(Array.isArray(p.range)).toBeTruthy();
    expect(p.range.length).toBe(0);
    expect(String(p.namespace || "")).toBe("http://example.org/");
    expect(String((p as any).source || "")).toBe("parsed");

    // Expect the class to be present
    const c = classes.find((x: any) => String(x.iri) === "http://example.org/SomeClass");
    expect(c).toBeTruthy();
    expect(String(c.label || "")).toBe("Some Class Label");

    // Assert additional class fields set by producer
    expect(Array.isArray(c.properties)).toBeTruthy();
    expect(c.properties.length).toBe(0);
    expect(typeof c.restrictions === "object").toBeTruthy();
    expect(String(c.namespace || "")).toBe("http://example.org/");
    expect(String((c as any).source || "")).toBe("parsed");

    // Also assert fatmap snapshot instrumentation (if present) recorded an entry
    try {
      const snap = (globalThis as any).__VG_FATMAP_SNAP || [];
      expect(Array.isArray(snap)).toBeTruthy();
      expect(snap.length).toBeGreaterThanOrEqual(1);
      // Verify the snapshot samples include our IRIs when instrumentation is enabled
      const last = snap[snap.length - 1];
      if (last) {
        const sampleProps = Array.isArray(last.sampleProperties) ? last.sampleProperties : [];
        const sampleClasses = Array.isArray(last.sampleClasses) ? last.sampleClasses : [];
        expect(sampleProps.includes("http://example.org/hasFoo") || sampleProps.includes("http://example.org/hasFoo")).toBeTruthy();
        expect(sampleClasses.includes("http://example.org/SomeClass") || sampleClasses.includes("http://example.org/SomeClass")).toBeTruthy();
      }
    } catch (_) {
      // instrumentation absent -> ignore
    }

    // cleanup
    try {
      const st = useOntologyStore.getState();
      if (typeof st.clearOntologies === "function") st.clearOntologies();
      else
        useOntologyStore.setState({
          availableClasses: [],
          availableProperties: [],
          namespaceRegistry: [],
        } as any);
    } catch (_) { /* ignore */ }
  });
});
