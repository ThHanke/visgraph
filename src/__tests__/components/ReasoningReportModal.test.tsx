import { describe, it, expect } from "vitest";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { ReasoningReportModal } from "../../components/Canvas/ReasoningReportModal";
import type { ReasoningResult } from "../../utils/rdfManager";

describe("ReasoningReportModal", () => {
  it("renders warnings, inferences, and metadata from the provided reasoning result", async () => {
    const sampleResult: ReasoningResult = {
      id: "test-1",
      timestamp: Date.now(),
      status: "completed",
      duration: 10,
      errors: [],
      warnings: [
        {
          nodeId: "http://example.com/instance1",
          message:
            "Inferred: http://example.com/instance1 http://example.com/prop http://example.com/obj1 (confidence=70%)",
          rule: "inference",
          severity: "info",
        },
      ],
      inferences: [
        {
          type: "relationship",
          subject: "http://example.com/instance1",
          predicate: "http://example.com/prop",
          object: "http://example.com/obj1",
          confidence: 0.7,
        },
      ],
      inferredQuads: [
        {
          subject: "http://example.com/instance1",
          predicate: "http://example.com/prop",
          object: "http://example.com/obj1",
          graph: "urn:vg:inferred",
        },
      ],
      meta: { usedReasoner: true },
    };

    render(
      <ReasoningReportModal
        open={true}
        onOpenChange={() => {}}
        currentReasoning={sampleResult}
        reasoningHistory={[sampleResult]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Reasoning Report/i)).toBeTruthy();
      expect(screen.getByText(/Inferred:/i)).toBeTruthy();
      expect(
        screen.getByText(/http:\/\/example.com\/instance1/),
      ).toBeTruthy();
      expect(screen.getByText(/http:\/\/example.com\/prop/)).toBeTruthy();
      expect(screen.getByText(/http:\/\/example.com\/obj1/)).toBeTruthy();
    });
  });

  it("shows empty state when no reasoning result is provided", async () => {
    render(
      <ReasoningReportModal
        open={true}
        onOpenChange={() => {}}
        currentReasoning={null}
        reasoningHistory={[]}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText(/No reasoning results available/i),
      ).toBeTruthy();
    });
  });
});
