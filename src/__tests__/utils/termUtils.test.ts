import { test, expect, beforeEach } from "vitest";
import { rdfManager } from "../../utils/rdfManager";
import { computeTermDisplay } from "../../utils/termUtils";
import { FIXTURES } from "../fixtures/rdfFixtures";
import { useOntologyStore } from "../../stores/ontologyStore";

beforeEach(() => {
  // start from a clean manager and ontology store for each test
  rdfManager.clear();
  useOntologyStore.getState().setNamespaceRegistry([]);
  useOntologyStore.setState({ availableClasses: [], availableProperties: [] });
});

test("computeTermDisplay produces expected fields for absolute IRI loaded from fixture", async () => {
  // Load the fixture that declares ex: <http://example.com/>
  const ttl = FIXTURES["http://example.com/basic/john"];
  expect(ttl).toBeTruthy();

  // load into a test graph and wait for parse to finish
  await rdfManager.loadRDFIntoGraph(ttl, "urn:test");

  // Use an explicit registry for deterministic behavior (fixture declares ex:)
  const registry = [{ prefix: "ex", namespace: "http://example.com/", color: "#000000" }];
  useOntologyStore.getState().setNamespaceRegistry(registry);
  useOntologyStore.setState({ availableClasses: [{ iri: "http://example.com/john_doe", label: "John Doe", namespace: "http://example.com/", properties: [], restrictions: {} }] });

  // compute display for the full IRI using explicit registry and fat-map label
  const iri = "http://example.com/john_doe";
  const info = computeTermDisplay(iri);
  console.log("----- TEST LOG (absolute IRI) -----");
  console.log("Fixture (TTL):\n", ttl);
  console.log("Input IRI:", iri);
  console.log("Output TermDisplayInfo:", info);
  console.log("----- END TEST LOG -----");

  expect(info).toBeTruthy();
  expect(info.iri).toBe(iri);
  expect(info.prefixed).toBe("ex:john_doe");
  expect(info.short).toBe("john_doe");
  expect(Array.isArray(info.tooltipLines)).toBe(true);
  expect(info.tooltipLines).toContain("john_doe");
  expect(info.label).toBe("John Doe");
  expect(info.labelSource).toBe("fatmap");
});

test("computeTermDisplay accepts a prefixed name and returns same resolved IRI/display", async () => {
  // Ensure manager has prefixes from fixture (parser exercised)
  const ttl = FIXTURES["http://example.com/basic/john"];
  await rdfManager.loadRDFIntoGraph(ttl, "urn:test2");

  // Use explicit registry for expansion/lookup (fixture-known)
  const registry2 = [{ prefix: "ex", namespace: "http://example.com/", color: "#000000" }];
  useOntologyStore.getState().setNamespaceRegistry(registry2);
  useOntologyStore.setState({ availableClasses: [{ iri: "http://example.com/john_doe", label: "John Doe", namespace: "http://example.com/", properties: [], restrictions: {} }] });
  const pref = "ex:john_doe";
  const info = computeTermDisplay(pref);
  console.log("----- TEST LOG (prefixed input) -----");
  console.log("Fixture (TTL):\n", ttl);
  console.log("Input prefixed:", pref);
  console.log("Output TermDisplayInfo:", info);
  console.log("----- END TEST LOG -----");

  expect(info).toBeTruthy();
  expect(info.iri).toBe("http://example.com/john_doe");
  expect(info.prefixed).toBe("ex:john_doe");
  expect(info.short).toBe("john_doe");
  expect(info.label).toBe("John Doe");
  expect(info.labelSource).toBe("fatmap");
});

test("computeTermDisplay handles default ':' prefix declared in a fixture", async () => {
  // Define a TTL that declares the default (empty) prefix ":" -> http://example.org/
  const ttlDefault = `
    @prefix : <http://example.org/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

    :LocalThing a :SomeClass ;
      rdfs:label "Local Thing" .
  `;
  await rdfManager.loadRDFIntoGraph(ttlDefault, "urn:test-default");

  // Prefer an explicit registry for the default prefix declared in the fixture
  const registryDefault = [{ prefix: "", namespace: "http://example.org/", color: "#000000" }];
  useOntologyStore.getState().setNamespaceRegistry(registryDefault);
  useOntologyStore.setState({ availableClasses: [{ iri: "http://example.org/LocalThing", label: "Local Thing", namespace: "http://example.org/", properties: [], restrictions: {} }] });

  // Test using absolute IRI (use explicit registry)
  const abs = "http://example.org/LocalThing";
  const infoAbs = computeTermDisplay(abs);
  console.log("----- TEST LOG (default prefix absolute IRI) -----");
  console.log("Fixture (TTL):\n", ttlDefault);
  console.log("Input absolute IRI:", abs);
  console.log("Output TermDisplayInfo:", infoAbs);
  console.log("----- END TEST LOG -----");

  expect(infoAbs).toBeTruthy();
  // Expect the prefixed form to use the default ':' prefix (i.e., ':LocalThing')
  expect(infoAbs.prefixed).toBe(":LocalThing");
  expect(infoAbs.short).toBe("LocalThing");
  expect(infoAbs.label).toBe("Local Thing");
  expect(infoAbs.labelSource).toBe("fatmap");

  // Also test passing the prefixed short form as input
  const prefLocal = ":LocalThing";
  const infoPref = computeTermDisplay(prefLocal);
  console.log("----- TEST LOG (default prefix prefixed input) -----");
  console.log("Input prefixed:", prefLocal);
  console.log("Output TermDisplayInfo:", infoPref);
  console.log("----- END TEST LOG -----");

  expect(infoPref).toBeTruthy();
  expect(infoPref.iri).toBe(abs);
  expect(infoPref.prefixed).toBe(":LocalThing");
  expect(infoPref.short).toBe("LocalThing");
  expect(infoPref.label).toBe("Local Thing");
  expect(infoPref.labelSource).toBe("fatmap");
});
