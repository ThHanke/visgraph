import { describe, it, expect, beforeEach } from "vitest";
import { DataFactory } from "n3";
import { useOntologyStore } from "../../stores/ontologyStore";
import { rdfManager } from "../../utils/rdfManager";

const { namedNode, quad } = DataFactory;

describe("Disjoint Class Reasoning", () => {
  beforeEach(async () => {
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
          namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
          namedNode("http://www.w3.org/2002/07/owl#Class")
        ),
        quad(
          namedNode(`${EX}Person`),
          namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
          namedNode("http://www.w3.org/2002/07/owl#Class")
        ),
        quad(
          namedNode(`${EX}Vehicle`),
          namedNode("http://www.w3.org/2002/07/owl#disjointWith"),
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
          namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
          namedNode(`${EX}Vehicle`)
        ),
        quad(
          namedNode(`${EX}confusedEntity`),
          namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"),
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

    // Should have violations
    expect(result.errors.length + result.warnings.length).toBeGreaterThan(0);
    
    // Check if we got the disjoint class violation
    const hasDisjointViolation = [...result.errors, ...result.warnings].some(
      (issue) => issue.message.includes("disjoint")
    );
    
    expect(hasDisjointViolation).toBe(true);
  });
});
