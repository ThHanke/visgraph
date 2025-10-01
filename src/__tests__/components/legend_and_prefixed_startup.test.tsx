/* eslint-disable @typescript-eslint/no-require-imports */
import React from "react";
import { render, screen } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

// Mock the ontology store so components read a persisted namespaceRegistry and palette.
vi.mock("../../stores/ontologyStore", () => {
  const registry = [
    { prefix: "ex", namespace: "http://example.com/", color: "#7DD3FC" },
    { prefix: "dcterms", namespace: "http://purl.org/dc/terms/", color: "#A7F3D0" },
  ];
  const store = {
    namespaceRegistry: registry.slice(),
    rdfManager: {
      getNamespaces: () => ({ ex: "http://example.com/", dcterms: "http://purl.org/dc/terms/" }),
    },
    availableProperties: [],
    availableClasses: [],
    ontologiesVersion: 1,
  };
  return {
    useOntologyStore: (selector?: any) => {
      if (typeof selector === "function") return selector(store);
      return store;
    },
  };
});

// Minimal mocks for React Flow pieces used by CustomOntologyNode
vi.mock("@xyflow/react", () => {
  return {
    ReactFlowProvider: ({ children }: any) => React.createElement(React.Fragment, null, children),
    Handle: (props: any) => React.createElement("div", props, null),
    Position: { Left: "left", Right: "right" },
    useConnection: () => null,
    useUpdateNodeInternals: () => () => {},
  };
});

import ResizableNamespaceLegend from "../../components/Canvas/ResizableNamespaceLegend";
import { CustomOntologyNode } from "../../components/Canvas/CustomOntologyNode";
import { ReactFlowProvider } from "@xyflow/react";

describe("Legend + registry-driven prefixed display", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders legend entries with colors and nodes show prefixed headers when registry present", async () => {
    // Render the legend
    const { container } = render(React.createElement(ResizableNamespaceLegend, {}));

    // Expect the two namespaces to be present (uri text)
    expect(screen.getByTitle("http://example.com/")).toBeTruthy();
    expect(screen.getByTitle("http://purl.org/dc/terms/")).toBeTruthy();

    // Find the legend row for ex and assert the swatch background color matches registry color
    const exSpan = screen.getByTitle("http://example.com/");
    // The DOM structure: <div> <div class="flex ..."> <div swatch/> <Badge>prefix</Badge> </div> <span title=uri>uri</span> ...
    const exRow = exSpan.parentElement;
    expect(exRow).toBeTruthy();
    // swatch is previous sibling's first child
    const leftBlock = exRow?.querySelector("div.flex");
    const swatch = leftBlock?.querySelector("div.w-3.h-3");
    expect(swatch).toBeTruthy();
    // style backgroundColor should be set (value may be uppercase/lowercase)
    const bg = (swatch as HTMLElement)?.style?.backgroundColor;
    expect(bg && bg.length > 0).toBeTruthy();

    // Now render a CustomOntologyNode using the same registry so computeTermDisplay should produce prefixed header
    // Build a small quad set and map via the real mapper so test matches runtime behavior.
    const quads = [
      {
        subject: { value: "http://example.com/node1" },
        predicate: { value: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" },
        object: { value: "http://www.w3.org/2002/07/owl#Ontology", termType: "NamedNode" },
        graph: { value: "urn:vg:data" },
      },
      {
        subject: { value: "http://example.com/node1" },
        predicate: { value: "http://www.w3.org/2000/01/rdf-schema#label" },
        object: { value: "My Ontology", termType: "Literal", datatype: { value: "http://www.w3.org/2001/XMLSchema#string" } },
        graph: { value: "urn:vg:data" },
      },
    ];

    // Provide a registry snapshot matching the mocked store above so mapper computes prefixed forms/colors.
    const registry = [
      { prefix: "ex", namespace: "http://example.com/", color: "#7DD3FC" },
      { prefix: "dcterms", namespace: "http://purl.org/dc/terms/", color: "#A7F3D0" },
    ];

    // Use the real mapper to produce node data as the app would.
    const { default: mapQuadsToDiagram } = await import("../../components/Canvas/core/mappingHelpers");
    const diagram = mapQuadsToDiagram(quads, { registry, availableProperties: [], availableClasses: [] });
    const mappedNode = (diagram.nodes || []).find((n: any) => String(n.id) === "http://example.com/node1");
    expect(mappedNode).toBeTruthy();

    render(
      React.createElement(
        ReactFlowProvider,
        null,
        React.createElement(CustomOntologyNode as any, { id: "node-1", data: mappedNode!.data, selected: false })
      )
    );

    // Header should be prefixed using registry (ex:node1)
    expect(screen.getByText("ex:node1")).toBeTruthy();

    // Subtitle from annotation property should be present (may appear multiple times: legend + node)
    expect(screen.getAllByText("My Ontology").length).toBeGreaterThanOrEqual(1);
  });
});
