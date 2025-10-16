import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { CanvasToolbar } from "../../components/Canvas/CanvasToolbar";
import { FIXTURES } from "../fixtures/rdfFixtures";

/**
 * Ensure the Add Node dialog's Class Type selector is populated from RDF fixture data
 * loaded into the ontology store (fat-map). This verifies the toolbar merges parsed
 * classes into the classEntities used by EntityAutocomplete.
 */

describe("CanvasToolbar Add Node dialog - class type population", () => {
  it("loads RDF fixture and shows classes in the Add Node Class Type selector", async () => {
    const store = useOntologyStore.getState();

    // Clear any previous state
    {
      if (typeof store.clearOntologies === "function") store.clearOntologies();
    }

    // Load the fixture RDF into the ontology store (persist as ontology so namespaces/classes are registered)
      try {
        await store.loadOntologyFromRDF(FIXTURES["autocomplete_test_data"], undefined, true);
        // Reconcile the store so availableClasses / availableProperties are rebuilt from the RDF store
        try {
          await store.updateFatMap(undefined);
        } catch (_) {
          void 0;
        }
      } catch (e) {
      // If loading fails, surface the reason for test debugging
      // but continue to attempt the rest of the test — the assertion will fail cleanly.
       
      console.error("Failed to load fixture RDF:", e);
    }

    const noop = () => {};
    render(
      <CanvasToolbar
        onAddNode={noop}
        onToggleLegend={noop}
        showLegend={false}
        onExport={noop}
        viewMode="abox"
        onViewModeChange={noop}
        availableEntities={[]}
      />
    );

    // Open the Add Node dialog
    const addBtn = screen.getByRole("button", { name: /add node/i });
    fireEvent.click(addBtn);

    // The EntityAutocomplete renders its input inside a popover that must be opened.
    // Find the autocomplete trigger (a button with role="combobox") and click it to reveal the input.
    const combo = await screen.findByRole("combobox");
    fireEvent.click(combo);

    // The Class Type trigger shows the placeholder text; locate the command input directly.
    // Some test environments render the input without a separate trigger element, so query the input by placeholder.
    // Be permissive with the placeholder text to accommodate minor wording changes in the UI.
    const input = await screen.findByPlaceholderText(/search.*classes/i);
    // ensure the input is focused/visible; leave value empty to show all options
    fireEvent.change(input, { target: { value: "" } });

    // Wait for the class label from the fixture to appear
    await waitFor(() => {
      expect(screen.getByText("MyClass Label")).toBeTruthy();
    });

    // Cleanup
    { if (typeof store.clearOntologies === "function") store.clearOntologies(); }
  });
});
