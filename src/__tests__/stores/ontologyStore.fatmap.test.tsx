/// <reference types="vitest" />
import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { rdfManager } from "../../utils/rdfManager";
import { useOntologyStore } from "../../stores/ontologyStore";
import { LinkPropertyEditor } from "../../components/Canvas/LinkPropertyEditor";

describe("ontologyStore fat-map (RDF -> availableProperties) integration", () => {
  const propIri = "http://example.com/test#myProp";
  const propLabel = "My Test Prop";

  beforeEach(() => {
    // Ensure a clean RDF store & ontology state
    rdfManager.clear();
    useOntologyStore.getState().clearOntologies();
  });

  it("adds a store-discovered property to availableProperties and LinkPropertyEditor sees it", async () => {
    // Write the property (type + label) into the RDF store using rdfManager.updateNode
    rdfManager.updateNode(propIri, {
      rdfTypes: ["owl:ObjectProperty"],
      annotationProperties: [
        { propertyUri: "rdfs:label", value: propLabel, type: "xsd:string" },
      ],
    });

    // Wait for the store to reflect the new property
    await waitFor(() => {
      const ap = useOntologyStore.getState().availableProperties || [];
      const found = ap.find((p) => p.iri === propIri || p.label === propLabel);
      if (!found) throw new Error("availableProperties not updated yet");
    }, { timeout: 2000 });

    // Assert store contains it
    const found = useOntologyStore.getState().availableProperties.find(
      (p) => p.iri === propIri || p.label === propLabel
    );
    expect(found).toBeTruthy();
    expect(found!.label).toBe(propLabel);

    // Render the LinkPropertyEditor and ensure its AutoComplete includes the property
    render(
      <LinkPropertyEditor
        open={true}
        onOpenChange={() => {}}
        linkData={{ id: "edge-1", data: {} }}
        sourceNode={{ iri: "http://example.com/node1" }}
        targetNode={{ iri: "http://example.com/node2" }}
        onSave={() => {}}
      />
    );

    // Wait for the option to be rendered (label or fallback to IRI)
    await waitFor(() => {
      const byLabel = screen.queryByText(propLabel);
      const byIri = screen.queryByText(propIri);
      if (!byLabel && !byIri) {
        throw new Error("AutoComplete option not found");
      }
    }, { timeout: 2000 });
  });
});
