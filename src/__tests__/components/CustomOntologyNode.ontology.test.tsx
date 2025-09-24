import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the ontology store to provide a minimal rdfManager and other values the component reads.
vi.mock("../../stores/ontologyStore", () => {
  return {
    useOntologyStore: (selector?: any) => {
      const nsMap = {
        ex: "http://example.com/",
        owl: "http://www.w3.org/2002/07/owl#",
        rdfs: "http://www.w3.org/2000/01/rdf-schema#",
        dcterms: "http://purl.org/dc/terms/",
      };
      const rdfManager = {
        getNamespaces: () => nsMap,
        // expandPrefix is optional; keep a simple implementation for safety in tests
        expandPrefix: (pref: string) => {
          const [p, local] = String(pref).split(":");
          if (nsMap[p]) return nsMap[p] + local;
          return pref;
        },
      };
      const store = {
        rdfManager,
        ontologiesVersion: 1,
        availableClasses: [],
        availableProperties: [],
      };
      // When a selector function is passed, call it with the store object (Zustand-like)
      if (typeof selector === "function") return selector(store);
      return store;
    },
  };
});

// Mock the palette hook used by the component to keep output deterministic.
vi.mock("../../components/Canvas/core/namespacePalette", () => {
  return {
    usePaletteFromRdfManager: () => ({}),
  };
});

vi.mock("@xyflow/react", () => {
  const React = require("react");
  return {
    ReactFlowProvider: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    useConnection: () => null,
    useUpdateNodeInternals: () => () => {},
    Handle: (props: any) => React.createElement("div", props, null),
    Position: { Left: "left", Right: "right" },
  };
});

import { CustomOntologyNode } from "../../components/Canvas/CustomOntologyNode";
import { ReactFlowProvider } from "@xyflow/react";

describe("CustomOntologyNode (owl:Ontology) display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders title, badge and subtitle from computeTermDisplay and annotationProperties", () => {
    const nodeData = {
      iri: "http://example.com/ontology1",
      classType: "http://www.w3.org/2002/07/owl#Ontology",
      rdfTypes: ["http://www.w3.org/2002/07/owl#Ontology"],
      annotationProperties: [
        {
          propertyUri: "http://www.w3.org/2000/01/rdf-schema#label",
          value: "My Ontology",
        },
        {
          propertyUri: "http://purl.org/dc/terms/license",
          value: "CC-BY",
        },
        {
          propertyUri: "http://purl.org/dc/terms/creator",
          value: "Alice",
        },
      ],
    };

    // Wrap in ReactFlow provider so hooks like useConnection work in tests.
    render(
      React.createElement(
        ReactFlowProvider,
        null,
        React.createElement(CustomOntologyNode as any, { id: "node-1", data: nodeData, selected: false })
      )
    );

    // Title should show the prefixed IRI (ex:ontology1)
    expect(screen.getByText("ex:ontology1")).toBeTruthy();

    // Badge should display the meaningful type prefixed (owl:Ontology)
    expect(screen.getByText("owl:Ontology")).toBeTruthy();

    // Subtitle (human-friendly) must prefer rdfs:label (may also appear as an annotation value)
    const subtitleMatches = screen.getAllByText("My Ontology");
    expect(subtitleMatches.length).toBeGreaterThanOrEqual(1);

    // Annotations list should include the license and creator entries (prefixed or short)
    // The component renders property terms using toPrefixed when possible; expect dcterms:license and dcterms:creator
    expect(screen.getByText("dcterms:license")).toBeTruthy();
    expect(screen.getByText("dcterms:creator")).toBeTruthy();

    // And their values should be present
    expect(screen.getByText("CC-BY")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();
  });
});
