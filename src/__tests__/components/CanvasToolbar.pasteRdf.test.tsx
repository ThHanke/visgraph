import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { describe, test, expect, vi, beforeEach } from "vitest";
import { useOntologyStore } from "../../../src/stores/ontologyStore";
import { CanvasToolbar } from "../../../src/components/Canvas/CanvasToolbar";
import { initRdfManagerWorker } from "../utils/initRdfManagerWorker";

describe("CanvasToolbar Paste RDF -> loadOntologyFromRDF", () => {
  beforeEach(async () => {
    await initRdfManagerWorker();
    // reset store mocks between tests
    useOntologyStore.setState({ loadOntologyFromRDF: undefined } as any);
  });

  test("calls loadOntologyFromRDF with ontology graph when user pastes RDF and clicks Load RDF", async () => {
    const mockLoadFromRdf = vi.fn(async (_rdf: string, _onProgress?: any, _preserve?: boolean, graphName?: string) => {
      // simulate small delay
      return Promise.resolve();
    });

    // inject the mock into the zustand store used by the component
    useOntologyStore.setState({ loadOntologyFromRDF: mockLoadFromRdf } as any);

    const props = {
      onAddNode: () => {},
      onToggleLegend: () => {},
      showLegend: false,
      onExport: () => Promise.resolve(),
      onLoadFile: undefined,
      viewMode: "abox" as const,
      onViewModeChange: () => {},
      onLayoutChange: undefined,
      currentLayout: "horizontal",
      layoutEnabled: false,
      onToggleLayoutEnabled: undefined,
      availableEntities: [],
    };

    const { getByPlaceholderText, getByText } = render(<CanvasToolbar {...props} />);
 
    // Open the "Load Ontology" dialog (textarea is inside that dialog)
    const openDialogBtn = getByText("Load Ontology");
    fireEvent.click(openDialogBtn);
 
    // Wait for the dialog textarea to be available, then interact
    const pasteArea = await waitFor(() =>
      getByPlaceholderText(
        "Paste Turtle / RDF/XML / JSON-LD here to register its prefixes and optionally load it as an ontology"
      ) as HTMLTextAreaElement
    );
    const sampleRdf = '@prefix ex: <http://example.org/> . ex:Thing a ex:Class .';
 
    // simulate user pasting RDF
    fireEvent.change(pasteArea, { target: { value: sampleRdf } });
 
    // click the Load RDF button
    const loadButton = getByText("Load RDF");
    fireEvent.click(loadButton);

    // assert the store function was invoked with the graphName set to urn:vg:ontologies
    await waitFor(() => {
      expect(mockLoadFromRdf).toHaveBeenCalled();
      const callArgs = mockLoadFromRdf.mock.calls[0];
      expect(callArgs[0]).toBe(sampleRdf);
      // 4th parameter is graphName
      expect(callArgs[3]).toBe("urn:vg:ontologies");
    });
  });
});
