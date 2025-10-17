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
        namespaceRegistry: [
          { prefix: "ex", namespace: "http://example.com/", color: "" },
          { prefix: "dcterms", namespace: "http://purl.org/dc/terms/", color: "" },
          { prefix: "owl", namespace: "http://www.w3.org/2002/07/owl#", color: "" },
          { prefix: "rdfs", namespace: "http://www.w3.org/2000/01/rdf-schema#", color: "" },
        ],
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
  return {
    ReactFlowProvider: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
    useConnection: () => null,
    useUpdateNodeInternals: () => () => {},
    Handle: (props: any) => React.createElement("div", props, null),
    Position: { Left: "left", Right: "right" },
  };
});

import { RDFNode } from "../../components/Canvas/RDFNode";
import { ReactFlowProvider } from "@xyflow/react";

describe("CustomOntologyNode (owl:Ontology) display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders title, badge and subtitle from computeTermDisplay and annotationProperties", async () => {
    // Build quads that represent the node and its annotations (data graph)
    const quads = [
      {
        subject: { value: "http://example.com/ontology1" },
        predicate: { value: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" },
        object: { value: "http://www.w3.org/2002/07/owl#Ontology", termType: "NamedNode" },
        graph: { value: "urn:vg:data" },
      },
      {
        subject: { value: "http://example.com/ontology1" },
        predicate: { value: "http://www.w3.org/2000/01/rdf-schema#label" },
        object: { value: "My Ontology", termType: "Literal", datatype: { value: "http://www.w3.org/2001/XMLSchema#string" } },
        graph: { value: "urn:vg:data" },
      },
      {
        subject: { value: "http://example.com/ontology1" },
        predicate: { value: "http://purl.org/dc/terms/license" },
        object: { value: "CC-BY", termType: "Literal", datatype: { value: "http://www.w3.org/2001/XMLSchema#string" } },
        graph: { value: "urn:vg:data" },
      },
      {
        subject: { value: "http://example.com/ontology1" },
        predicate: { value: "http://purl.org/dc/terms/creator" },
        object: { value: "Alice", termType: "Literal", datatype: { value: "http://www.w3.org/2001/XMLSchema#string" } },
        graph: { value: "urn:vg:data" },
      },
    ];

    const registry = [
      { prefix: "ex", namespace: "http://example.com/", color: "#7DD3FC" },
      { prefix: "dcterms", namespace: "http://purl.org/dc/terms/", color: "#A7F3D0" },
      { prefix: "owl", namespace: "http://www.w3.org/2002/07/owl#", color: "" },
      { prefix: "rdfs", namespace: "http://www.w3.org/2000/01/rdf-schema#", color: "" },
    ];

    const { default: mapQuadsToDiagram } = await import("../../components/Canvas/core/mappingHelpers");
    const diagram = mapQuadsToDiagram(quads, { registry, availableProperties: [], availableClasses: [] });
    const mappedNode = (diagram.nodes || []).find((n: any) => String(n.id) === "http://example.com/ontology1");
    expect(mappedNode).toBeTruthy();

    // Wrap in ReactFlow provider so hooks like useConnection work in tests.
    render(
      React.createElement(
        ReactFlowProvider,
        null,
        React.createElement(RDFNode as any, { id: "node-1", data: mappedNode!.data, selected: false })
      )
    );

    // Title should show the prefixed IRI (ex:ontology1) or fallback to the full IRI
    const headerElem = screen.queryByText("ex:ontology1") || screen.queryByText("http://example.com/ontology1");
    expect(headerElem).toBeTruthy();

    // Badge should display the meaningful type prefixed (owl:Ontology) or fallback to full IRI
    const badge = screen.queryByText("owl:Ontology") || screen.queryByText("http://www.w3.org/2002/07/owl#Ontology");
    expect(badge).toBeTruthy();

    // Subtitle (human-friendly) must prefer rdfs:label and now is composed with the meaningful type.
    // Expect the composed subtitle like: "My Ontology is a owl:Ontology" or a reasonable fallback
    const subtitleElem =
      screen.queryByText("My Ontology is a owl:Ontology") ||
      screen.queryByText("My Ontology is a http://www.w3.org/2002/07/owl#Ontology") ||
      screen.queryByText("My Ontology");
    expect(subtitleElem).toBeTruthy();

    // Annotations list should include the license and creator entries (prefixed or short)
    // The component renders property terms using toPrefixed when possible; accept prefixed or full-IRI forms.
    const licenseTerm = screen.queryByText("dcterms:license") || screen.queryByText("http://purl.org/dc/terms/license");
    const creatorTerm = screen.queryByText("dcterms:creator") || screen.queryByText("http://purl.org/dc/terms/creator");
    expect(licenseTerm).toBeTruthy();
    expect(creatorTerm).toBeTruthy();

    // And their values should be present
    expect(screen.getByText("CC-BY")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();
  });
});
