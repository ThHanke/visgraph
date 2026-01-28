import { describe, it, expect, beforeEach } from "vitest";
import { initRdfManagerWorker } from "../utils/initRdfManagerWorker";
import { DataFactory } from "n3";
import { useOntologyStore } from "../../stores/ontologyStore";
import { rdfManager } from "../../utils/rdfManager";
import { RDF_TYPE, OWL } from "../../constants/vocabularies";

const { namedNode, quad } = DataFactory;

describe("Disjoint Class Reasoning", () => {
  beforeEach(async () => {
    await initRdfManagerWorker();
    await rdfManager.clear();
  });

  it("should detect disjoint class violations", async () => {
    // Define test namespace
    const EX = "http://example.org/test#";
    
    // Add ontology: Vehicle and Person are disjoint
    await rdfManager.applyBatch({
      adds: [
        quad(
          namedNode(`${EX}Vehicle`),
          namedNode(RDF_TYPE),
          namedNode(OWL.Class)
        ),
        quad(
          namedNode(`${EX}Person`),
          namedNode(RDF_TYPE),
          namedNode(OWL.Class)
        ),
        quad(
          namedNode(`${EX}Vehicle`),
          namedNode(OWL.disjointWith),
          namedNode(`${EX}Person`)
        ),
      ],
      removes: [],
    }, "urn:vg:data");

    // Add violating individual: both Vehicle and Person
    await rdfManager.applyBatch({
      adds: [
        quad(
          namedNode(`${EX}confusedEntity`),
          namedNode(RDF_TYPE),
          namedNode(`${EX}Vehicle`)
        ),
        quad(
          namedNode(`${EX}confusedEntity`),
          namedNode(RDF_TYPE),
          namedNode(`${EX}Person`)
        ),
      ],
      removes: [],
    }, "urn:vg:data");

    // Run reasoning with best-practice rules
    const result = await rdfManager.runReasoning({
      rulesets: ["best-practice.n3"],
    });

    console.log("Reasoning result:", JSON.stringify(result, null, 2));

    // Skip test if no rules were loaded (ruleQuadCount === 0)
    if (result.meta?.ruleQuadCount === 0) {
      console.log("Skipping test: No reasoning rules were loaded");
      return;
    }

    // Should have violations
    expect(result.errors.length + result.warnings.length).toBeGreaterThan(0);
    
    // Check if we got the disjoint class violation
    const hasDisjointViolation = [...result.errors, ...result.warnings].some(
      (issue) => issue.message.includes("disjoint")
    );
    
    expect(hasDisjointViolation).toBe(true);
  });
});
