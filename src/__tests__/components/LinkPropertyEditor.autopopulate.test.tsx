import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { LinkPropertyEditor } from "../../components/Canvas/LinkPropertyEditor";

/**
 * Verifies that LinkPropertyEditor/AutoComplete will display suggestions
 * derived from the ontology store (fat-map) when the editor is opened.
 */

describe("LinkPropertyEditor autocomplete population from fat-map", () => {
  it("shows availableProperties/entityIndex suggestions in the object property AutoComplete", async () => {
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
      <LinkPropertyEditor
        open={true}
        onOpenChange={noop}
        linkData={{ operation: "create", data: {} }}
        sourceNode={{ iri: "http://example.org/test#s" }}
        targetNode={{ iri: "http://example.org/test#t" }}
        onSave={noop}
      />
    );

    // The LinkPropertyEditor passes autoOpen={open} to AutoComplete, so suggestions
    // should be visible without additional interaction. Wait for the seeded suggestion.
    await waitFor(() => {
      expect(screen.getByText("prop one")).toBeTruthy();
    });

    // Cleanup store
    {
      useOntologyStore.getState().clearOntologies();
    }
  });
});
