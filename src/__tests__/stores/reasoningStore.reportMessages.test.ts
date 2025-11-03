import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { DataFactory } from "n3";
import { useReasoningStore } from "../../stores/reasoningStore";
import { ReasoningReportModal } from "../../components/Canvas/ReasoningReportModal";

const { namedNode, quad } = DataFactory;

describe("Reasoning store -> report messages integration", () => {
  beforeEach(() => {
    // reset store state between tests
    try {
      useReasoningStore.setState({ currentReasoning: null, reasoningHistory: [] } as any, true);
    } catch (_) {
      // ignore
    }
  });

  it("populates warnings/messages from inferred facts (fallback RDFS inference)", async () => {
    // Build a minimal rdfStore-like object that exposes getQuads.
    // Include a domain declaration for a property and an instance using that property
    // so the fallback inference pass will produce an rdf:type inference.
    const propIri = "http://example.com/prop";
    const classIri = "http://example.com/MyClass";
    const instanceIri = "http://example.com/instance1";
    const inferredGraph = namedNode("urn:vg:inferred");

    const quads = [
      // property rdfs:domain MyClass in any graph (ontology)
      quad(namedNode(propIri), namedNode("http://www.w3.org/2000/01/rdf-schema#domain"), namedNode(classIri), namedNode("urn:vg:ontologies")),
      // instance uses the property in the data graph
      quad(namedNode(instanceIri), namedNode(propIri), namedNode("http://example.com/obj1"), namedNode("urn:vg:data")),
    ];

    const fakeStore = {
      getQuads: (_s: any, _p: any, _o: any, _g: any) => {
        // return the full set so the reasoning fallback sees both domain + usage triples
        return quads;
      },
      addQuad: (_q: any) => {},
    };

    // Run reasoning (uses fallback RDFS pass if n3 reasoner not available)
    const result = await useReasoningStore.getState().startReasoning([], [], fakeStore as any);

    expect(result).toBeTruthy();
    // Should produce at least one inference-derived warning/message
    expect(Array.isArray(result.warnings)).toBeTruthy();
    const hasInferenceMessage = result.warnings.some((w) => /Inferred[: ]/i.test(w.message) || /inferred triple/i.test(w.message));
    expect(hasInferenceMessage).toBeTruthy();
  });

  it("ReasoningReportModal renders inference messages in the UI", async () => {
    // Prepare a reasoning result in the store similar to what startReasoning would produce.
    const sampleResult = {
      id: "test-1",
      timestamp: Date.now(),
      status: "completed",
      duration: 10,
      errors: [],
      warnings: [
        { nodeId: "http://example.com/instance1", message: "Inferred: http://example.com/instance1 http://example.com/prop http://example.com/obj1 (confidence=70%)", rule: "inference", severity: "info" },
      ],
      inferences: [
        { type: "relationship", subject: "http://example.com/instance1", predicate: "http://example.com/prop", object: "http://example.com/obj1", confidence: 0.7 },
      ],
      inferredQuads: [
        { subject: "http://example.com/instance1", predicate: "http://example.com/prop", object: "http://example.com/obj1", graph: "urn:vg:inferred" },
      ],
    } as any;

    useReasoningStore.setState({ currentReasoning: sampleResult, reasoningHistory: [sampleResult] } as any, true);

    render(<ReasoningReportModal open={true} onOpenChange={() => {}} />);

    // The Summary / Inferences tab is active by default; switch to Inferences tab if needed by querying.
    // Look for the inference message text in the rendered dialog.
    await waitFor(() => {
      expect(screen.getByText(/Inferred:/i)).toBeTruthy();
    });

    // Also ensure the inferred triples table is present and shows the triple
    await waitFor(() => {
      expect(screen.getByText(/http:\/\/example.com\/instance1/)).toBeTruthy();
      expect(screen.getByText(/http:\/\/example.com\/prop/)).toBeTruthy();
      expect(screen.getByText(/http:\/\/example.com\/obj1/)).toBeTruthy();
    });
  });
});
