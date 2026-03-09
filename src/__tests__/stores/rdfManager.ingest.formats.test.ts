// @vitest-environment node

/**
 * Multi-format ingest tests for the shared importSerialized code path.
 *
 * All three ingest routes (URL query param, load ontology dialog, load from file)
 * converge on rdfManager.loadRDFIntoGraph → worker importSerialized command.
 * These tests exercise that path for every format supported by rdf-parse v4.
 *
 * Formats covered: Turtle, N3, N-Triples, N-Quads, TriG, JSON-LD, RDF/XML
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test, expect, beforeEach } from "vitest";
import { initRdfManagerWorker } from "../utils/initRdfManagerWorker";
import { rdfManager } from "../../utils/rdfManager";

const fixture = (name: string) =>
  readFileSync(resolve(__dirname, "../fixtures", name), "utf-8");

describe("rdfManager multi-format ingest (importSerialized)", () => {
  beforeEach(async () => {
    await initRdfManagerWorker();
    rdfManager.clear();
    await new Promise((r) => setTimeout(r, 100));
  });

  const GRAPH = "urn:vg:test:ingest";

  async function ingest(content: string, mimeType: string) {
    await rdfManager.loadRDFIntoGraph(content, GRAPH, mimeType);
    await new Promise((r) => setTimeout(r, 300));
    const counts = await rdfManager.getGraphCounts();
    return counts[GRAPH] ?? 0;
  }

  test("Turtle (.ttl)", async () => {
    const count = await ingest(fixture("ingest-test.ttl"), "text/turtle");
    expect(count).toBeGreaterThan(0);
  });

  test("N3 (.n3)", async () => {
    const count = await ingest(fixture("ingest-test.n3"), "text/n3");
    expect(count).toBeGreaterThan(0);
  });

  test("N-Triples (.nt)", async () => {
    const count = await ingest(fixture("ingest-test.nt"), "application/n-triples");
    expect(count).toBeGreaterThan(0);
  });

  test("N-Quads (.nq)", async () => {
    // N-Quads contain an inline named graph; quads land in the named graph inside the file,
    // not in GRAPH. We verify at least the store accepted the content without error.
    await rdfManager.loadRDFIntoGraph(fixture("ingest-test.nq"), GRAPH, "application/n-quads");
    await new Promise((r) => setTimeout(r, 300));
    const counts = await rdfManager.getGraphCounts();
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    expect(total).toBeGreaterThan(0);
  });

  test("TriG (.trig)", async () => {
    // TriG content embeds its own named graph; counts land in that graph.
    await rdfManager.loadRDFIntoGraph(fixture("ingest-test.trig"), GRAPH, "application/trig");
    await new Promise((r) => setTimeout(r, 300));
    const counts = await rdfManager.getGraphCounts();
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    expect(total).toBeGreaterThan(0);
  });

  test("JSON-LD (.jsonld)", async () => {
    const count = await ingest(fixture("ingest-test.jsonld"), "application/ld+json");
    expect(count).toBeGreaterThan(0);
  });

  test("RDF/XML (.rdf)", async () => {
    const count = await ingest(fixture("ingest-test.rdf"), "application/rdf+xml");
    expect(count).toBeGreaterThan(0);
  });
});
