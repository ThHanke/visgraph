import { test, expect, beforeEach } from "vitest";
import { rdfManager } from "../../utils/rdfManager";
import { computeTermDisplay } from "../../utils/termUtils";
import { FIXTURES } from "../fixtures/rdfFixtures";

beforeEach(() => {
  // start from a clean manager for each test
  rdfManager.clear();
});

test("computeTermDisplay produces expected fields for absolute IRI loaded from fixture", async () => {
  // Load the fixture that declares ex: <http://example.com/>
  const ttl = FIXTURES["http://example.com/basic/john"];
  expect(ttl).toBeTruthy();

  // load into a test graph and wait for parse to finish
  await rdfManager.loadRDFIntoGraph(ttl, "urn:test");

  // ensure the namespace was registered
  const ns = rdfManager.getNamespaces();
  expect(ns["ex"]).toBe("http://example.com/");

  // compute display for the full IRI
  const iri = "http://example.com/john_doe";
  const info = computeTermDisplay(iri, rdfManager);
  console.log("----- TEST LOG (absolute IRI) -----");
  console.log("Fixture (TTL):\n", ttl);
  console.log("Input IRI:", iri);
  console.log("Output TermDisplayInfo:", info);
  console.log("----- END TEST LOG -----");

  expect(info).toBeTruthy();
  expect(info.iri).toBe(iri);
  expect(info.prefixed).toBe("ex:john_doe");
  expect(info.short).toBe("john_doe");
  expect(info.namespace).toBe("ex");
  expect(Array.isArray(info.tooltipLines)).toBe(true);
  expect(info.tooltipLines).toContain("john_doe");
  expect(info.label).toBe("John Doe");
  expect(info.labelSource).toBe("computed");
});

test("computeTermDisplay accepts a prefixed name and returns same resolved IRI/display", async () => {
  // Ensure manager has prefixes from fixture
  const ttl = FIXTURES["http://example.com/basic/john"];
  await rdfManager.loadRDFIntoGraph(ttl, "urn:test2");

  const pref = "ex:john_doe";
  const info = computeTermDisplay(pref, rdfManager);
  console.log("----- TEST LOG (prefixed input) -----");
  console.log("Fixture (TTL):\n", ttl);
  console.log("Input prefixed:", pref);
  console.log("Output TermDisplayInfo:", info);
  console.log("----- END TEST LOG -----");

  expect(info).toBeTruthy();
  expect(info.iri).toBe("http://example.com/john_doe");
  expect(info.prefixed).toBe("ex:john_doe");
  expect(info.short).toBe("john_doe");
  expect(info.namespace).toBe("ex");
  expect(info.label).toBe("John Doe");
  expect(info.labelSource).toBe("computed");
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

  // The parser should register the default prefix under the empty string key in namespaces
  const ns = rdfManager.getNamespaces();
  // ensure namespace mapping contains the default (may be under '' or other; check any matching URI)
  const hasDefault = Object.values(ns).some((v) => String(v).startsWith("http://example.org"));
  expect(hasDefault).toBe(true);

  // Test using absolute IRI
  const abs = "http://example.org/LocalThing";
  const infoAbs = computeTermDisplay(abs, rdfManager);
  console.log("----- TEST LOG (default prefix absolute IRI) -----");
  console.log("Fixture (TTL):\n", ttlDefault);
  console.log("Input absolute IRI:", abs);
  console.log("Output TermDisplayInfo:", infoAbs);
  console.log("----- END TEST LOG -----");

  expect(infoAbs).toBeTruthy();
  // Expect the prefixed form to use the default ':' prefix (i.e., ':LocalThing')
  expect(infoAbs.prefixed).toBe(":LocalThing");
  // The namespace field falls back to empty string when the prefix is the empty/default prefix
  expect(infoAbs.namespace).toBe("");
  expect(infoAbs.short).toBe("LocalThing");
  expect(infoAbs.label).toBe("Local Thing");
  expect(infoAbs.labelSource).toBe("computed");

  // Also test passing the prefixed short form as input
  const prefLocal = ":LocalThing";
  const infoPref = computeTermDisplay(prefLocal, rdfManager);
  console.log("----- TEST LOG (default prefix prefixed input) -----");
  console.log("Input prefixed:", prefLocal);
  console.log("Output TermDisplayInfo:", infoPref);
  console.log("----- END TEST LOG -----");

  expect(infoPref).toBeTruthy();
  expect(infoPref.iri).toBe(abs);
  expect(infoPref.prefixed).toBe(":LocalThing");
  expect(infoPref.short).toBe("LocalThing");
  expect(infoPref.namespace).toBe("");
  expect(infoPref.label).toBe("Local Thing");
  expect(infoPref.labelSource).toBe("computed");
});
