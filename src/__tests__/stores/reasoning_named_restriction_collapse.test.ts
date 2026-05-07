// @vitest-environment node

/**
 * OWL restriction classification regression test.
 *
 * Verifies that two OWL restrictions sharing owl:onProperty but with DIFFERENT
 * owl:someValuesFrom fillers do NOT collapse into an equivalentClass pair, and
 * that ABox individuals are classified into exactly the classes whose restriction
 * fillers they satisfy.
 *
 * Three variants:
 *   - Named restriction nodes (ex:R1, ex:R2) via applyBatch
 *   - Blank restriction nodes (_:b0, _:b1) via applyBatch — skolemized to urn:vg:bnode: in store
 *   - Blank restriction nodes via loadRDFIntoGraph (Turtle) — also skolemized
 *
 * All variants must produce identical correct results.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initRdfManagerWorker } from "../utils/initRdfManagerWorker";
import { rdfManager } from "../../utils/rdfManager";
import { DataFactory } from "n3";
import { RDF_TYPE } from "../../constants/vocabularies";

const { namedNode, blankNode, quad } = DataFactory;

const DATA_GRAPH = "urn:vg:data";
const INFERRED_GRAPH = "urn:vg:inferred";
const EX = "http://example.org/collapse-test#";

const NS_OWL = "http://www.w3.org/2002/07/owl#";
const RDF_TYPE_NODE = namedNode(RDF_TYPE);
const OWL_RESTRICTION = namedNode(`${NS_OWL}Restriction`);
const OWL_ON_PROPERTY = namedNode(`${NS_OWL}onProperty`);
const OWL_SOME_VALUES_FROM = namedNode(`${NS_OWL}someValuesFrom`);
const OWL_EQUIVALENT_CLASS = namedNode(`${NS_OWL}equivalentClass`);
const OWL_NAMED_INDIVIDUAL_NODE = namedNode(`${NS_OWL}NamedIndividual`);

// ---------------------------------------------------------------------------
// Fetch shim — serve local rule files, pass everything else to real fetch
// ---------------------------------------------------------------------------
let origFetch: typeof globalThis.fetch;

function installFetchShim() {
  origFetch = (globalThis as any).fetch;
  (globalThis as any).fetch = async (input: any, init?: any) => {
    try {
      const urlStr = String(input ?? "");
      if (urlStr.includes("/reasoning-rules/")) {
        const name = urlStr.replace(/^.*\/reasoning-rules\//, "");
        const filePath = resolve("public/reasoning-rules", name);
        const text = readFileSync(filePath, "utf8");
        return {
          ok: true,
          status: 200,
          text: async () => text,
          headers: { get: (k: string) => (k?.toLowerCase() === "content-type" ? "text/n3" : null) },
        };
      }
    } catch (_) {
      // fall through
    }
    if (typeof origFetch === "function") return origFetch(input, init);
    throw new Error(`No fetch available for: ${input}`);
  };
}

function uninstallFetchShim() {
  (globalThis as any).fetch = origFetch;
}

// ---------------------------------------------------------------------------
// Helper: fetch all inferred quads
// ---------------------------------------------------------------------------
async function getInferredQuads(): Promise<Array<{ s: string; p: string; o: string }>> {
  const page = await rdfManager.fetchQuadsPage({
    graphName: INFERRED_GRAPH,
    offset: 0,
    limit: 10000,
    serialize: true,
  });
  return (page?.items ?? []).map((q: any) => ({
    s: q.subject?.value ?? q.subject,
    p: q.predicate?.value ?? q.predicate,
    o: q.object?.value ?? q.object,
  }));
}

function inferredIncludes(
  quads: Array<{ s: string; p: string; o: string }>,
  s: string,
  p: string,
  o: string,
): boolean {
  return quads.some((q) => q.s === s && q.p === p && q.o === o);
}

// ---------------------------------------------------------------------------
// Shared TBox+ABox helpers
// ---------------------------------------------------------------------------

async function seedNamedNodeGraph() {
  const R1 = namedNode(`${EX}R1`);
  const R2 = namedNode(`${EX}R2`);
  const ClassA = namedNode(`${EX}ClassA`);
  const ClassB = namedNode(`${EX}ClassB`);
  const hasPart = namedNode(`${EX}hasPart`);
  const FillerA = namedNode(`${EX}FillerA`);
  const FillerB = namedNode(`${EX}FillerB`);
  const ind1 = namedNode(`${EX}ind1`);
  const p1 = namedNode(`${EX}p1`);

  await rdfManager.applyBatch(
    {
      adds: [
        // R1 = someValuesFrom FillerA
        quad(R1, RDF_TYPE_NODE, OWL_RESTRICTION),
        quad(R1, OWL_ON_PROPERTY, hasPart),
        quad(R1, OWL_SOME_VALUES_FROM, FillerA),
        // R2 = someValuesFrom FillerB — same property, different filler
        quad(R2, RDF_TYPE_NODE, OWL_RESTRICTION),
        quad(R2, OWL_ON_PROPERTY, hasPart),
        quad(R2, OWL_SOME_VALUES_FROM, FillerB),
        // ClassA ≡ R1, ClassB ≡ R2
        quad(ClassA, OWL_EQUIVALENT_CLASS, R1),
        quad(ClassB, OWL_EQUIVALENT_CLASS, R2),
        // ABox: ind1 hasPart p1; p1 type FillerA only
        quad(ind1, RDF_TYPE_NODE, OWL_NAMED_INDIVIDUAL_NODE),
        quad(ind1, hasPart, p1),
        quad(p1, RDF_TYPE_NODE, FillerA),
      ],
      removes: [],
    },
    DATA_GRAPH,
  );
}

async function seedBlankNodeGraph() {
  const b0 = blankNode("b0");
  const b1 = blankNode("b1");
  const ClassA = namedNode(`${EX}ClassA`);
  const ClassB = namedNode(`${EX}ClassB`);
  const hasPart = namedNode(`${EX}hasPart`);
  const FillerA = namedNode(`${EX}FillerA`);
  const FillerB = namedNode(`${EX}FillerB`);
  const ind1 = namedNode(`${EX}ind1`);
  const p1 = namedNode(`${EX}p1`);

  await rdfManager.applyBatch(
    {
      adds: [
        quad(b0, RDF_TYPE_NODE, OWL_RESTRICTION),
        quad(b0, OWL_ON_PROPERTY, hasPart),
        quad(b0, OWL_SOME_VALUES_FROM, FillerA),
        quad(b1, RDF_TYPE_NODE, OWL_RESTRICTION),
        quad(b1, OWL_ON_PROPERTY, hasPart),
        quad(b1, OWL_SOME_VALUES_FROM, FillerB),
        quad(ClassA, OWL_EQUIVALENT_CLASS, b0),
        quad(ClassB, OWL_EQUIVALENT_CLASS, b1),
        quad(ind1, RDF_TYPE_NODE, OWL_NAMED_INDIVIDUAL_NODE),
        quad(ind1, hasPart, p1),
        quad(p1, RDF_TYPE_NODE, FillerA),
      ],
      removes: [],
    },
    DATA_GRAPH,
  );
}

// ---------------------------------------------------------------------------
// Shared assertion logic
// ---------------------------------------------------------------------------
async function assertCorrectClassification(label: string) {
  const quads = await getInferredQuads();

  console.log(`[TEST] All inferred quads (${label}):`);
  for (const q of quads) console.log(" ", q.s, q.p, q.o);

  const classA = `${EX}ClassA`;
  const classB = `${EX}ClassB`;
  const ind1 = `${EX}ind1`;
  const equivClass = OWL_EQUIVALENT_CLASS.value;
  const rdfType = RDF_TYPE;

  // No spurious ClassA ≡ ClassB equivalence
  const spuriousEquiv =
    inferredIncludes(quads, classA, equivClass, classB) ||
    inferredIncludes(quads, classB, equivClass, classA);
  expect(spuriousEquiv).toBe(false);

  // ind1 correctly classified as ClassA via cls-svf1
  expect(inferredIncludes(quads, ind1, rdfType, classA)).toBe(true);

  // ind1 must NOT be classified as ClassB (p1 only satisfies FillerA, not FillerB)
  expect(inferredIncludes(quads, ind1, rdfType, classB)).toBe(false);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("OWL restriction classification — no collapse (regression guard)", () => {
  beforeEach(async () => {
    await initRdfManagerWorker();
    await rdfManager.clear();
    installFetchShim();
  });

  afterEach(() => {
    uninstallFetchShim();
  });

  it("NAMED NODES — no collapse; ind1 typed as ClassA only", async () => {
    await seedNamedNodeGraph();

    const result = await rdfManager.runReasoning({ rulesets: ["owl-rl.n3"] });

    if ((result.meta as any)?.ruleQuadCount === 0) {
      console.warn("[TEST] No rule quads loaded — skipping");
      return;
    }

    expect(result.status).toBe("completed");
    await assertCorrectClassification("named-node");
  });

  it("BLANK NODES via applyBatch — skolemized to urn:vg:bnode:; no collapse; ind1 typed as ClassA only", async () => {
    await seedBlankNodeGraph();

    // Blank nodes are skolemized at write time — verify no _: subjects in store
    const dataPage = await rdfManager.fetchQuadsPage({ graphName: DATA_GRAPH, limit: 10000 });
    const dataQuads = dataPage?.items ?? [];
    const hasRawBnode = dataQuads.some((q: any) => (q.subject?.value ?? q.subject ?? "").startsWith("_:"));
    expect(hasRawBnode).toBe(false);
    const hasSkolem = dataQuads.some((q: any) => (q.subject?.value ?? q.subject ?? "").startsWith("urn:vg:bnode:"));
    expect(hasSkolem).toBe(true);

    const result = await rdfManager.runReasoning({ rulesets: ["owl-rl.n3"] });

    if ((result.meta as any)?.ruleQuadCount === 0) {
      console.warn("[TEST] No rule quads loaded — skipping");
      return;
    }

    expect(result.status).toBe("completed");
    await assertCorrectClassification("blank-node-batch");
  });

  it("BLANK NODES via loadRDFIntoGraph (Turtle) — skolemized; no collapse; ind1 typed as ClassA only; export de-skolemizes", async () => {
    const turtle = `
@prefix ex: <http://example.org/collapse-test#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

ex:ClassA owl:equivalentClass [
    rdf:type owl:Restriction ;
    owl:onProperty ex:hasPart ;
    owl:someValuesFrom ex:FillerA
] .

ex:ClassB owl:equivalentClass [
    rdf:type owl:Restriction ;
    owl:onProperty ex:hasPart ;
    owl:someValuesFrom ex:FillerB
] .

ex:ind1 rdf:type owl:NamedIndividual ;
    ex:hasPart ex:p1 .

ex:p1 rdf:type ex:FillerA .
`;
    await rdfManager.loadRDFIntoGraph(turtle, DATA_GRAPH, "text/turtle");

    // Blank nodes from Turtle parsing are skolemized — verify
    const dataPage = await rdfManager.fetchQuadsPage({ graphName: DATA_GRAPH, limit: 10000 });
    const dataQuads = dataPage?.items ?? [];
    const hasRawBnode = dataQuads.some((q: any) => (q.subject?.value ?? q.subject ?? "").startsWith("_:"));
    expect(hasRawBnode).toBe(false);
    const hasSkolem = dataQuads.some((q: any) => (q.subject?.value ?? q.subject ?? "").startsWith("urn:vg:bnode:"));
    expect(hasSkolem).toBe(true);

    const result = await rdfManager.runReasoning({ rulesets: ["owl-rl.n3"] });

    if ((result.meta as any)?.ruleQuadCount === 0) {
      console.warn("[TEST] No rule quads loaded — skipping");
      return;
    }

    expect(result.status).toBe("completed");
    await assertCorrectClassification("loadRdf-blank-node");

    // Export round-trip: urn:vg:bnode: IRIs must be de-skolemized back to blank nodes
    const exported = await rdfManager.exportToTurtle(DATA_GRAPH);
    expect(exported).not.toContain("urn:vg:bnode:");
    expect(exported).toMatch(/_:[\w]+/);
  });
});
