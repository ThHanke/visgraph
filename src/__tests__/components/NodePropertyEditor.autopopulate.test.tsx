import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { NodePropertyEditor } from "../../components/Canvas/NodePropertyEditor";

/**
 * Verifies that NodePropertyEditor/AutoComplete will display suggestions
 * derived from the ontology store (fat-map) when the component's annotation
 * property selector is used.
 */

describe("NodePropertyEditor autocomplete population from fat-map", () => {
  it.skip("shows availableProperties/entityIndex suggestions in the property AutoComplete", async () => {
    // Seed the ontology store fat-map entries
    {
      useOntologyStore.setState({
        availableProperties: [
          { iri: "http://example.org/test#propOne", label: "prop one", namespace: "http://example.org/test#" },
        ],
        entityIndex: {
          suggestions: [
            { iri: "http://example.org/test#propOne", label: "prop one", display: "prop one display" },
          ],
        },
      } as any);
    }

    const noop = () => {};
    render(
      <NodePropertyEditor
        open={true}
        onOpenChange={noop}
        nodeData={{ data: { annotationProperties: [] } }}
        onSave={noop}
        availableEntities={[]}
      />
    );

    // Click "Add Property" to render an AutoComplete instance for the new property
    const addBtn = screen.getByRole("button", { name: /add property/i });
    fireEvent.click(addBtn);

    // There may be multiple comboboxes (type selector, property selector). The newly added property
    // combobox is rendered after clicking Add Property; find all comboboxes and click the last one.
    const combos = screen.getAllByRole("combobox");
    expect(combos.length).toBeGreaterThanOrEqual(1);
    const propertyCombo = combos[combos.length - 1];
    fireEvent.click(propertyCombo);

    // After opening the combobox, wait for the suggestion to appear directly.
    await waitFor(() => {
      expect(screen.getByText("prop one")).toBeTruthy();
    });

    // Cleanup store
    {
      useOntologyStore.getState().clearOntologies();
    }
  });
});
