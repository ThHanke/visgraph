// @vitest-environment node
/**
 * Konclude OWL DL reasoning test using the public/reasoning-demo.ttl ontology.
 *
 * Tests that Konclude infers the full OWL DL hierarchy and ABox entailments.
 *
 * Uses RdfReasoner directly (bypasses the rdfManager worker pipeline) so it
 * runs in Node.js without SharedArrayBuffer / browser Worker setup.
 *
 * v0.3.0 API:
 *   classify(store)  — TBox only (direct subClassOf chain + owl:Thing)
 *   materialize(store, { includeClassHierarchy: true }) — full DL output (TBox + ABox)
 */
import { describe, it, expect } from "vitest";
import { RdfReasoner, INFERRED_GRAPH_IRI } from "rdf-reasoner-konclude";
import * as N3 from "n3";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EX = "http://example.com/reasoning-demo#";
const RDFS_SUB_CLASS_OF = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

function loadDemoStore(): N3.Store {
  const ttlPath = path.resolve(__dirname, "../../../public/reasoning-demo.ttl");
  const ttlContent = fs.readFileSync(ttlPath, "utf-8");
  const store = new N3.Store();
  const parser = new N3.Parser({ format: "text/turtle" });
  store.addQuads(parser.parse(ttlContent));
  return store;
}

describe("Konclude DL reasoning: reasoning-demo.ttl", () => {
  it(
    "classify() returns TBox-only direct taxonomy",
    async () => {
      let reasoner: RdfReasoner | undefined;
      try {
        reasoner = new RdfReasoner();
        await reasoner.ready;
      } catch (e) {
        console.warn(
          "[TEST] Konclude WASM unavailable in this environment — skipping:",
          String(e),
        );
        return;
      }

      const store = loadDemoStore();
      try {
        await reasoner.classify(store);
      } finally {
        reasoner.terminate();
      }

      const inferredGraph = N3.DataFactory.namedNode(INFERRED_GRAPH_IRI);
      const inferred = store.getQuads(null, null, null, inferredGraph);

      console.log("[TEST] classify() inferred triple count:", inferred.length);
      console.log(
        "[TEST] classify() triples:",
        inferred.map(
          (q) => `${q.subject.value.replace(EX, "ex:")} ${q.predicate.value.split("#")[1] ?? q.predicate.value} ${q.object.value.replace(EX, "ex:")}`,
        ),
      );

      // Person subClassOf owl:Thing — NOT in source, inferred (all OWL classes subclass owl:Thing)
      const OWL_THING = "http://www.w3.org/2002/07/owl#Thing";
      expect(
        inferred.some(
          (q) =>
            q.subject.value === `${EX}Person` &&
            q.predicate.value === RDFS_SUB_CLASS_OF &&
            q.object.value === OWL_THING,
        ),
      ).toBe(true);

      // v0.6.9+: echoed source triples are no longer returned — Employee subClassOf Person
      // is asserted in source, so it must NOT appear in inferred graph.
      expect(
        inferred.some(
          (q) =>
            q.subject.value === `${EX}Employee` &&
            q.predicate.value === RDFS_SUB_CLASS_OF &&
            q.object.value === `${EX}Person`,
        ),
      ).toBe(false);

      // Lock in count — v0.6.9 returns 12 genuinely new triples, 0 echoed
      const sourceKeys = new Set(
        store
          .getQuads(null, null, null, N3.DataFactory.defaultGraph())
          .map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`),
      );
      const echoed = inferred.filter((q) =>
        sourceKeys.has(`${q.subject.value} ${q.predicate.value} ${q.object.value}`),
      );
      console.log("[TEST] classify() echoed:", echoed.length, "| genuinely new:", inferred.length - echoed.length);
      expect(inferred.length).toBe(12);
      expect(echoed.length).toBe(0);
    },
    30000,
  );

  it(
    "materialize() surfaces full DL output: TBox + ABox entailments",
    async () => {
      let reasoner: RdfReasoner | undefined;
      try {
        reasoner = new RdfReasoner();
        await reasoner.ready;
      } catch (e) {
        console.warn("[TEST] Konclude WASM unavailable — skipping:", String(e));
        return;
      }

      const store = loadDemoStore();
      try {
        await reasoner.materialize(store, { includeClassHierarchy: true });
      } finally {
        reasoner.terminate();
      }

      const inferredGraph = N3.DataFactory.namedNode(INFERRED_GRAPH_IRI);
      const inferred = store.getQuads(null, null, null, inferredGraph);

      console.log("[TEST] materialize() inferred triple count:", inferred.length);

      // TBox: Person subClassOf owl:Thing
      const OWL_THING = "http://www.w3.org/2002/07/owl#Thing";
      expect(
        inferred.some(
          (q) =>
            q.subject.value === `${EX}Person` &&
            q.predicate.value === RDFS_SUB_CLASS_OF &&
            q.object.value === OWL_THING,
        ),
      ).toBe(true);

      // ABox: subClassOf chain — alice is Executive, infer Manager/Employee/Person
      expect(inferred.some((q) => q.subject.value === `${EX}alice` && q.predicate.value === RDF_TYPE && q.object.value === `${EX}Manager`)).toBe(true);
      expect(inferred.some((q) => q.subject.value === `${EX}alice` && q.predicate.value === RDF_TYPE && q.object.value === `${EX}Employee`)).toBe(true);
      expect(inferred.some((q) => q.subject.value === `${EX}alice` && q.predicate.value === RDF_TYPE && q.object.value === `${EX}Person`)).toBe(true);

      // ABox: subPropertyOf — hasFriend infers knows
      expect(inferred.some((q) => q.subject.value === `${EX}alice` && q.predicate.value === `${EX}knows` && q.object.value === `${EX}bob`)).toBe(true);

      // ABox: inverseOf — manages infers isManagedBy
      expect(inferred.some((q) => q.subject.value === `${EX}carol` && q.predicate.value === `${EX}isManagedBy` && q.object.value === `${EX}alice`)).toBe(true);
      expect(inferred.some((q) => q.subject.value === `${EX}bob` && q.predicate.value === `${EX}isManagedBy` && q.object.value === `${EX}dave`)).toBe(true);

      // ABox: SymmetricProperty — isColleagueOf reverse
      expect(inferred.some((q) => q.subject.value === `${EX}carol` && q.predicate.value === `${EX}isColleagueOf` && q.object.value === `${EX}bob`)).toBe(true);

      // ABox: TransitiveProperty — carol hasSupervisor alice (via bob)
      expect(inferred.some((q) => q.subject.value === `${EX}carol` && q.predicate.value === `${EX}hasSupervisor` && q.object.value === `${EX}alice`)).toBe(true);

      // ABox: domain inference — dave type Manager (from dave manages bob; manages domain Manager)
      expect(inferred.some((q) => q.subject.value === `${EX}dave` && q.predicate.value === RDF_TYPE && q.object.value === `${EX}Manager`)).toBe(true);
      // ABox: range inference — bob type Manager (from carol hasSupervisor bob; hasSupervisor range Manager)
      expect(inferred.some((q) => q.subject.value === `${EX}bob` && q.predicate.value === RDF_TYPE && q.object.value === `${EX}Manager`)).toBe(true);

      // Group 1 — Restrictions
      expect(inferred.some((q) => q.subject.value === `${EX}alice` && q.predicate.value === RDF_TYPE && q.object.value === `${EX}ProjectContributor`),
        "alice rdf:type ProjectContributor (alice worksOn projectAlpha; projectAlpha type Project)").toBe(true);
      expect(inferred.some((q) => q.subject.value === `${EX}carol` && q.predicate.value === RDF_TYPE && q.object.value === `${EX}ProjectContributor`),
        "carol rdf:type ProjectContributor (carol worksOn projectAlpha)").toBe(true);
      expect(inferred.some((q) => q.subject.value === `${EX}carol` && q.predicate.value === RDF_TYPE && q.object.value === `${EX}DirectReport`),
        "carol rdf:type DirectReport (carol isManagedBy alice via inverseOf; hasValue ex:alice)").toBe(true);

      // Group 2 — Cardinality
      expect(inferred.some((q) => q.subject.value === `${EX}dave` && q.predicate.value === RDF_TYPE && q.object.value === `${EX}TeamLead`),
        "dave rdf:type TeamLead (intersectionOf: manages some Manager ∩ manages some Employee; dave manages bob=inferred Manager and eve=Employee)").toBe(true);

      // Group 4 — Advanced expressivity
      expect(inferred.some((q) => q.subject.value === `${EX}carol` && q.predicate.value === `${EX}hasGrandManager` && q.object.value === `${EX}alice`),
        "carol ex:hasGrandManager ex:alice (propertyChainAxiom: carol→bob→alice via hasSupervisor)").toBe(true);
      expect(inferred.some((q) => q.subject.value === `${EX}alice` && q.predicate.value === RDF_TYPE && q.object.value === `${EX}LeadershipTeam`),
        "alice rdf:type LeadershipTeam (equivalentClass unionOf Executive+Manager)").toBe(true);
      expect(inferred.some((q) => q.subject.value === `${EX}dave` && q.predicate.value === RDF_TYPE && q.object.value === `${EX}LeadershipTeam`),
        "dave rdf:type LeadershipTeam (dave is inferred Manager)").toBe(true);
      expect(inferred.some((q) => q.subject.value === `${EX}aliceCEO` && q.predicate.value === RDF_TYPE && q.object.value === `${EX}Executive`),
        "aliceCEO rdf:type Executive (sameAs ex:alice propagates alice's types)").toBe(true);

      // Lock in totals — v0.6.9 returns 53 genuinely new triples, 0 echoed
      const sourceKeys = new Set(
        store
          .getQuads(null, null, null, N3.DataFactory.defaultGraph())
          .map((q) => `${q.subject.value} ${q.predicate.value} ${q.object.value}`),
      );
      const echoed = inferred.filter((q) =>
        sourceKeys.has(`${q.subject.value} ${q.predicate.value} ${q.object.value}`),
      );
      console.log("[TEST] materialize() echoed:", echoed.length, "| genuinely new:", inferred.length - echoed.length);
      expect(inferred.length).toBe(53);
      expect(echoed.length).toBe(0);
    },
    30000,
  );
});
