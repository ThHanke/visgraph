import { describe, it, expect, vi } from "vitest";
import { DataFactory } from "n3";
import { useOntologyStore } from "../../../src/stores/ontologyStore";

const { namedNode } = DataFactory;

describe("discoverReferencedOntologies (async) triggers both ontology-driven and data-driven subject emissions", () => {
  it("schedules autoloads and causes emitAllSubjects and triggerSubjectUpdate to be invoked", async () => {
    const storeApi: any = (useOntologyStore as any);
    // Snapshot original state to restore later
    const original = { ...(storeApi.getState ? storeApi.getState() : {}) };

    // Shim requestIdleCallback to run tasks immediately (test environment may not have it)
    const origRIC = (globalThis as any).requestIdleCallback;
    (globalThis as any).requestIdleCallback = (fn: any) => {
      try { fn(); } catch (_) {}
    };

    try {
      // Insert a fake store that reports one owl:imports triple from the data graph
      // and also exposes a single data-graph quad so the code's post-load handler
      // that collects data-graph subjects will see at least one subject.
      const ontUrl = "http://example.org/test-ont";
      const fakeStore = {
        getQuads: (s: any, p: any, o: any, g: any) => {
          const OWL_IMPORTS = "http://www.w3.org/2002/07/owl#imports";
          // If predicate looks like owl:imports return a single import quad
          if (p && (p.value === OWL_IMPORTS || String(p) === OWL_IMPORTS)) {
            return [
              {
                subject: namedNode("http://example.org/source"),
                predicate: namedNode(OWL_IMPORTS),
                object: namedNode(ontUrl),
                graph: g || namedNode("urn:vg:data"),
              },
            ];
          }

          // If caller is explicitly asking for triples in the data graph, return a simple data quad
          try {
            const dataGraphUri = "urn:vg:data";
            const graphVal = g && (g.value || String(g));
            if (graphVal === dataGraphUri || String(g) === dataGraphUri) {
              return [
                {
                  subject: namedNode("http://example.org/data-node"),
                  predicate: namedNode("http://example.org/prop"),
                  object: namedNode("http://example.org/obj"),
                  graph: namedNode(dataGraphUri),
                },
              ];
            }
          } catch (_) {
            /* ignore */
          }

          // Otherwise, return no quads for simplicity
          return [];
        },
      };

      // Fake rdfManager that exposes getStore, emitAllSubjects and triggerSubjectUpdate spies
      const emitAllSubjectsSpy = vi.fn(async () => { /* no-op */ });
      const triggerSubjectUpdateSpy = vi.fn(async (subs: string[]) => { /* no-op */ });
      const fakeMgr = {
        getStore: () => fakeStore,
        emitAllSubjects: emitAllSubjectsSpy,
        triggerSubjectUpdate: triggerSubjectUpdateSpy,
      };

      // Install fake manager and reset loadedOntologies
      storeApi.setState({ rdfManager: fakeMgr, loadedOntologies: [] });

      // Mock loadOntology on the store to simulate successful autoload for the discovered candidate
      const mockLoadOntology = vi.fn(async (url: string, opts?: any) => {
        // Normalize to https for parity with normalizeUri in store implementation
        const norm = String(url || "").startsWith("http://") ? String(url).replace(/^http:\/\//i, "https://") : String(url);
        return { success: true, url: norm };
      });
      // Install mocked loadOntology
      storeApi.setState({ loadOntology: mockLoadOntology });

      // Call discovery in async mode so the code schedules background loads which should
      // invoke our mocked loadOntology and then call emitAllSubjects + triggerSubjectUpdate.
      const res = await (storeApi.getState() as any).discoverReferencedOntologies({
        graphName: "urn:vg:data",
        load: "async",
        timeoutMs: 2000,
      });

      // Basic expectations about discovery result
      expect(Array.isArray(res.candidates)).toBe(true);
      // The candidate should include the ontology URL (normalized to https by normalizeUri in store impl)
      const expectedNorm = ontUrl.startsWith("http://") ? ontUrl.replace(/^http:\/\//i, "https://") : ontUrl;
      expect(res.candidates).toContain(expectedNorm);

      // Allow scheduled background tasks to run (some scheduling uses setTimeout); give a small tick
      await new Promise((r) => setTimeout(r, 50));

      // The store's mocked loadOntology should have been invoked for the candidate
      expect(mockLoadOntology).toHaveBeenCalled();

      // Our fakeMgr.emitAllSubjects should have been called by the post-load handler
      expect(emitAllSubjectsSpy).toHaveBeenCalled();

      // Our fakeMgr.triggerSubjectUpdate should have been called with an array of data subjects (may be empty, but should be invoked)
      expect(triggerSubjectUpdateSpy).toHaveBeenCalled();

      // Optionally assert the trigger was called with an array argument
      const calledWith = triggerSubjectUpdateSpy.mock.calls[0] || [];
      expect(Array.isArray(calledWith[0])).toBe(true);
    } finally {
      // Restore requestIdleCallback
      try { (globalThis as any).requestIdleCallback = origRIC; } catch (_) {}
      // Restore original store state (best-effort)
      try {
        storeApi.setState({
          rdfManager: original.rdfManager || undefined,
          loadedOntologies: original.loadedOntologies || [],
          loadOntology: original.loadOntology,
        });
      } catch (_) {}
    }
  }, { timeout: 20000 });
});
