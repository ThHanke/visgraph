import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { LinkPropertyEditor } from "../../components/Canvas/LinkPropertyEditor";

/**
 * Sanity test: seed ontology store with a specific availableProperties + entityIndex suggestion
 * and verify the LinkPropertyEditor / AutoComplete consumes it and displays the expected label.
 *
 * This is a focused consumer-level test that ensures suggestions seeded into the store
 * are surfaced in the editor dropdown.
 */

describe("AutoComplete / LinkPropertyEditor seeded suggestions", () => {
  it("renders a seeded availableProperties/entityIndex suggestion in the AutoComplete", async () => {
    // Seed the ontology store fat-map entries and entityIndex suggestions
    {
      useOntologyStore.setState({
        availableProperties: [
          {
            iri: "http://example.org/test#propSeed",
            label: "Prop Seed",
            namespace: "http://example.org/test#",
          },
        ],
        entityIndex: {
          suggestions: [
            {
              iri: "http://example.org/test#propSeed",
              label: "Prop Seed",
              display: "Prop Seed display",
            },
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

    // Wait for the seeded suggestion label to appear in the editor's autocomplete
    await waitFor(() => {
      expect(screen.getByText("Prop Seed")).toBeTruthy();
    });

    // Cleanup store
    {
      try {
        const st = useOntologyStore.getState();
        if (typeof st.clearOntologies === "function") {
          st.clearOntologies();
        } else {
          // minimal cleanup fallback
          useOntologyStore.setState({
            availableProperties: [],
            availableClasses: [],
            entityIndex: undefined,
          } as any);
        }
      } catch (_) {
        // ignore cleanup failures
      }
    }
  });
});
