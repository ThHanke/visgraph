import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { AutoComplete } from "../../components/ui/AutoComplete";
import { shortLocalName } from "../../utils/termUtils";

/**
 * This test loads a small in-memory OWL/Turtle ontology into the ontology store,
 * then builds an options array and asserts the AutoComplete component returns
 * the expected matches for Class, ObjectProperty and AnnotationProperty label lookups.
 */

const TEST_TTL = `
  @prefix : <http://example.org/test#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix owl: <http://www.w3.org/2002/07/owl#> .
  @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

  :MyClass a owl:Class ;
    rdfs:label "MyClass Label" .

  :hasPart a owl:ObjectProperty ;
    rdfs:label "has part" .

  :noteProp a owl:AnnotationProperty ;
    rdfs:label "note property" .

  # an entry where only the IRI contains 'special' (label doesn't), used to assert IRI matching
  :specialIRIProperty a owl:ObjectProperty ;
    rdfs:label "OtherLabel" .
`;

describe("AutoComplete with ontology-loaded options", () => {
  it("returns class, object property and annotation property hits by label (label-first)", async () => {
    const store = useOntologyStore.getState();

    // Ensure clean slate for the store
    {
      if (typeof store.clearOntologies === "function") store.clearOntologies();
    }

    // Load the test TTL into the ontology store (this populates the RDF manager)
    await store.loadOntologyFromRDF(TEST_TTL, undefined, false);

    // Build options array for AutoComplete (mimic shape used in the app)
    const opts = [
      {
        value: "http://example.org/test#MyClass",
        label: "MyClass Label",
        description: "Class from test ontology",
      },
      {
        value: "http://example.org/test#hasPart",
        label: "has part",
        description: "Object property from test ontology",
      },
      {
        value: "http://example.org/test#noteProp",
        label: "note property",
        description: "Annotation property from test ontology",
      },
      {
        value: "http://example.org/test#specialIRIProperty",
        label: "OtherLabel",
        description: "IRI-only match candidate",
      },
    ];

    // Render the AutoComplete component
    render(
      <AutoComplete
        options={opts}
        value={undefined}
        onValueChange={() => {}}
        placeholder="Properties"
      />
    );

    // Open the popover by clicking the combobox trigger
    const trigger = screen.getByRole("combobox");
    fireEvent.click(trigger);

    // Type part of the Class label and assert the label appears in suggestions
    const input = await screen.findByPlaceholderText("Search properties...");
    fireEvent.change(input, { target: { value: "MyClass" } });

    await waitFor(() => {
      expect(screen.getByText("MyClass Label")).toBeTruthy();
    });

    // Now type substring for the object property label
    fireEvent.change(input, { target: { value: "has" } });
    await waitFor(() => {
      expect(screen.getByText("has part")).toBeTruthy();
    });

    // Now type substring for the annotation property label
    fireEvent.change(input, { target: { value: "note" } });
    await waitFor(() => {
      expect(screen.getByText("note property")).toBeTruthy();
    });

    // Finally, type a substring that only appears in an IRI (specialIRIProperty)
    fireEvent.change(input, { target: { value: "specialIRIProperty" } });
    await waitFor(() => {
      // The UI may render the primary line in different forms depending on registry handling:
      // - ":shortName" when default namespace is used
      // - "shortName" when trimmed
      // - the full IRI when no prefixing is applied
      const shortened = shortLocalName("http://example.org/test#specialIRIProperty");
      const candidates = [
        `:${shortened}`,
        shortened,
        "specialIRIProperty",
        "http://example.org/test#specialIRIProperty",
      ];
      const found = candidates.some((t) => {
        try {
          return !!screen.queryByText(t);
        } catch {
          return false;
        }
      });
      expect(found).toBeTruthy();
      // Also ensure the secondary label is present
      expect(screen.getByText("OtherLabel")).toBeTruthy();
    });

    // Cleanup: clear ontologies to avoid leakage into other tests
    {
      if (typeof store.clearOntologies === "function") store.clearOntologies();
    }
  });
});
