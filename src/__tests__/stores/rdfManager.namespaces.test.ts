import { it, expect } from "vitest";
import { RDFManager } from "../../utils/rdfManager";

it("recomputes namespaces from Turtle loaded into the store", async () => {
  const rdfManager = new RDFManager();

  const turtle = `
    @prefix ex: <http://example.com/> .
    ex:entity a ex:Type ;
      ex:label "Test" .
  `;

  // Load Turtle into the N3 store
  await rdfManager.loadRDFIntoGraph(turtle, "urn:vg:data");

  // The RDFManager debounces namespace recomputation (default ~100ms).
  // Wait a short time to allow the async recompute to run.
  await new Promise((res) => setTimeout(res, 250));

  const ns = rdfManager.getNamespaces();

  // Ensure the prefix from the Turtle was discovered
  expect(ns).toHaveProperty("ex");
  expect(ns["ex"]).toBe("http://example.com/");
});
