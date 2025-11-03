/// <reference types="vitest" />
import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { DataFactory } from "n3";
import { useReasoningStore } from "../../stores/reasoningStore";
import { ReasoningReportModal } from "../../components/Canvas/ReasoningReportModal";
import { rdfManager } from "../../utils/rdfManager";

const { namedNode, quad } = DataFactory;

describe("Reasoning store -> report messages integration", () => {
  beforeEach(() => {
    // reset store state between tests
    try {
      useReasoningStore.setState({ currentReasoning: null, reasoningHistory: [] } as any);
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

    // Instead of a fake store, use the app's rdfManager so reasoning persists into
    // the real N3 store (urn:vg:inferred) the same way the application does.
    // Clear prior content and populate the manager store with the test triples.
    try { rdfManager.clear(); } catch (_) { /* ignore */ }

    // property rdfs:domain MyClass in ontologies graph
    rdfManager.addTriple(propIri, "http://www.w3.org/2000/01/rdf-schema#domain", classIri, "urn:vg:ontologies");
    // instance uses the property in the data graph
    rdfManager.addTriple(instanceIri, propIri, "http://example.com/obj1", "urn:vg:data");

    // Run reasoning passing the rdfManager so the store used is the canonical one
    const result = await useReasoningStore.getState().startReasoning([], [], rdfManager as any);

    expect(result).toBeTruthy();
    // Should produce at least one inference in the inferences array (not mixed into warnings)
    expect(Array.isArray(result.inferences)).toBeTruthy();
    const hasInference = result.inferences.some((inf) => inf.subject === instanceIri && inf.predicate === propIri);
    expect(hasInference).toBeTruthy();
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

    useReasoningStore.setState({ currentReasoning: sampleResult, reasoningHistory: [sampleResult] } as any);

    render(<ReasoningReportModal open={true} onOpenChange={() => {}} />);

    // The Summary / Inferences tab is active by default; the modal shows messages.
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
