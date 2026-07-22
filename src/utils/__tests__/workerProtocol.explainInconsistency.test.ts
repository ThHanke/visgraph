// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  validateRdfWorkerCommandInput,
  RDF_WORKER_COMMANDS,
} from "../rdfManager.workerProtocol";

describe("explainInconsistency worker command", () => {
  it("is a registered command", () => {
    expect(RDF_WORKER_COMMANDS).toContain("explainInconsistency");
  });

  it("accepts an empty/undefined payload", () => {
    expect(() => validateRdfWorkerCommandInput("explainInconsistency", undefined)).not.toThrow();
    expect(() => validateRdfWorkerCommandInput("explainInconsistency", {})).not.toThrow();
  });

  it("accepts a numeric maxJustifications", () => {
    expect(() => validateRdfWorkerCommandInput("explainInconsistency", { maxJustifications: 3 })).not.toThrow();
  });

  it("rejects a non-numeric maxJustifications", () => {
    expect(() => validateRdfWorkerCommandInput("explainInconsistency", { maxJustifications: "x" })).toThrow();
  });
});

describe("validate worker command", () => {
  it("is a registered command", () => {
    expect(RDF_WORKER_COMMANDS).toContain("validate");
  });
  it("accepts undefined payload, rejects a payload", () => {
    expect(() => validateRdfWorkerCommandInput("validate", undefined)).not.toThrow();
    expect(() => validateRdfWorkerCommandInput("validate", {})).toThrow();
  });
});
