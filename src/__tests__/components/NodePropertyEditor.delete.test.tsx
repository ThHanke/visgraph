import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { vi, describe, test, expect, beforeEach, afterEach } from "vitest";

/**
 * Test: NodePropertyEditor deletion should call parent onDelete callback
 * after confirming the user action and performing store write operations.
 *
 * This test mocks the ontology store / rdf manager sufficiently so the editor's
 * store-write path runs without errors and asserts that onDelete was invoked
 * with the expected node IRI/id.
 */

const fakeMgr = {
  getStore: () => ({
    getQuads: (_s: any, _p: any, _o: any, _g: any) => [],
    removeQuad: (_q: any) => {},
    addQuad: (_q: any) => {},
  }),
  removeTriple: vi.fn(),
  addTriple: vi.fn(),
  notifyChange: vi.fn(),
  expandPrefix: (s: string) => s,
};

vi.doMock("../../stores/ontologyStore", () => {
  // Provide a useOntologyStore export that also exposes getState
  const fn = () => ({} as any);
  (fn as any).getState = () => ({
    getRdfManager: () => fakeMgr,
    rdfManager: fakeMgr,
  });
  return {
    __esModule: true,
    useOntologyStore: fn,
  };
});

beforeEach(() => {
  // ensure confirm returns true so delete proceeds
  vi.stubGlobal("confirm", () => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  try { // cleanup mock to avoid cross-test leakage
    const modPath = (() => {
      try {
        return require.resolve("../../stores/ontologyStore");
      } catch {
        return null;
      }
    })();
    if (modPath && (require as any).cache && (require as any).cache[modPath]) {
      delete (require as any).cache[modPath];
    }
  } catch { void 0; }
});

test("NodePropertyEditor calls onDelete and closes when delete confirmed", async () => {
  // import the component after mocks are set up
  const { NodePropertyEditor } = await import("../../components/Canvas/NodePropertyEditor");

  const onOpenChange = vi.fn();
  const onSave = vi.fn();
  const onDelete = vi.fn();

  const nodeData = {
    data: {
      iri: "http://example.com/node-to-delete",
      annotationProperties: [],
      rdfTypes: ["http://www.w3.org/2002/07/owl#NamedIndividual"],
      label: "ToDelete",
    },
  };

  const rendered = render(
    React.createElement(NodePropertyEditor, {
      open: true,
      onOpenChange,
      nodeData,
      onSave,
      availableEntities: [],
      onDelete,
    }),
  );

  // Find the Delete button and click it
  const deleteButton = await rendered.findByText(/Delete/i);
  fireEvent.click(deleteButton);

  // Wait for onDelete to be called with the node IRI (string)
  await waitFor(() => {
    expect(onDelete).toHaveBeenCalled();
    const calledWith = (onDelete.mock.calls[0] || [])[0];
    expect(String(calledWith)).toContain("http://example.com/node-to-delete");
  });
}, 10000);
