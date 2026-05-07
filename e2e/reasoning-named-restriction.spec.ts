/**
 * Named-restriction MCP store inspection test.
 *
 * Seeds the exact same triples as the reasoning unit test (named-node variant)
 * via window.__mcpTools (addNode + addTriple), dumps the raw urn:vg:data quads,
 * runs reasoning, then checks ind1 classification.
 *
 * Purpose: verify that MCP tools write exactly the triples we expect and that
 * named restriction nodes reason correctly end-to-end in the live app.
 *
 * Requires: npm run dev (http://localhost:8080)
 */

import { test, expect, Page } from '@playwright/test';

const BASE_URL = process.env.VG_URL ?? 'http://localhost:8080';
const EX = 'http://example.org/collapse-test#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

async function waitForMcpTools(page: Page) {
  await page.waitForFunction(
    () => !!(window as any).__mcpTools && typeof (window as any).__mcpTools['addNode'] === 'function',
    { timeout: 20_000 },
  );
}

async function call(page: Page, tool: string, params: object) {
  return page.evaluate(
    ([t, p]) => (window as any).__mcpTools[t](p),
    [tool, params] as const,
  );
}

test('loadRdf blank-node restrictions: skolemized on canvas, reasoning classifies correctly', async ({ page }) => {
  await page.goto(BASE_URL);
  await waitForMcpTools(page);

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

  await call(page, 'loadRdf', { turtle });

  const linksResult = await call(page, 'getLinks', { limit: 500 }) as any;
  const dataQuads: Array<{ subject: string; predicate: string; object: string }> =
    linksResult?.data?.links ?? [];

  // No raw blank-node subjects in the store
  const rawBnodes = dataQuads.filter(q => q.subject.startsWith('_:'));
  expect(rawBnodes).toHaveLength(0);

  // Skolemized restriction nodes present
  const skolemNodes = dataQuads.filter(q => q.subject.startsWith('urn:vg:bnode:'));
  expect(skolemNodes.length).toBeGreaterThan(0);

  // Run reasoning and verify ind1 → ClassA only
  await call(page, 'runReasoning', { rulesets: ['owl-rl.n3'] });

  const details = await call(page, 'getNodeDetails', { iri: `${EX}ind1` }) as any;
  const types: string[] = details?.data?.types ?? [];

  expect(types).toContain(`${EX}ClassA`);
  expect(types).not.toContain(`${EX}ClassB`);
});

test('named restriction nodes: MCP seeds correct triples and reasoning classifies correctly', async ({ page }) => {
  await page.goto(BASE_URL);
  await waitForMcpTools(page);

  // ── Seed TBox: named restriction nodes ─────────────────────────────────

  // R1: someValuesFrom FillerA
  await call(page, 'addNode', { iri: `${EX}R1`, typeIri: `${OWL}Restriction` });
  await call(page, 'addTriple', { subjectIri: `${EX}R1`, predicateIri: `${OWL}onProperty`,      objectIri: `${EX}hasPart` });
  await call(page, 'addTriple', { subjectIri: `${EX}R1`, predicateIri: `${OWL}someValuesFrom`,  objectIri: `${EX}FillerA` });

  // R2: someValuesFrom FillerB (same onProperty, different filler)
  await call(page, 'addNode', { iri: `${EX}R2`, typeIri: `${OWL}Restriction` });
  await call(page, 'addTriple', { subjectIri: `${EX}R2`, predicateIri: `${OWL}onProperty`,      objectIri: `${EX}hasPart` });
  await call(page, 'addTriple', { subjectIri: `${EX}R2`, predicateIri: `${OWL}someValuesFrom`,  objectIri: `${EX}FillerB` });

  // ClassA ≡ R1, ClassB ≡ R2
  await call(page, 'addNode', { iri: `${EX}ClassA`, typeIri: `${OWL}Class` });
  await call(page, 'addNode', { iri: `${EX}ClassB`, typeIri: `${OWL}Class` });
  await call(page, 'addTriple', { subjectIri: `${EX}ClassA`, predicateIri: `${OWL}equivalentClass`, objectIri: `${EX}R1` });
  await call(page, 'addTriple', { subjectIri: `${EX}ClassB`, predicateIri: `${OWL}equivalentClass`, objectIri: `${EX}R2` });

  // ── Seed ABox ───────────────────────────────────────────────────────────

  // ind1 hasPart p1; p1 type FillerA only
  await call(page, 'addNode', { iri: `${EX}ind1`, typeIri: `${OWL}NamedIndividual` });
  await call(page, 'addNode', { iri: `${EX}p1`,   typeIri: `${EX}FillerA` });
  await call(page, 'addTriple', { subjectIri: `${EX}ind1`, predicateIri: `${EX}hasPart`, objectIri: `${EX}p1` });

  // ── Dump urn:vg:data to inspect what actually landed ───────────────────

  const linksResult = await call(page, 'getLinks', { limit: 500 }) as any;
  const dataQuads: Array<{ subject: string; predicate: string; object: string }> =
    linksResult?.data?.links ?? [];

  console.log('[TEST] urn:vg:data quads after seeding:');
  for (const q of dataQuads) console.log(' ', q.subject, q.predicate, q.object);

  // Verify key triples are present
  const has = (s: string, p: string, o: string) =>
    dataQuads.some(q => q.subject === s && q.predicate === p && q.object === o);

  expect(has(`${EX}R1`, `${RDF}type`,             `${OWL}Restriction`)).toBe(true);
  expect(has(`${EX}R1`, `${OWL}onProperty`,        `${EX}hasPart`)).toBe(true);
  expect(has(`${EX}R1`, `${OWL}someValuesFrom`,    `${EX}FillerA`)).toBe(true);
  expect(has(`${EX}R2`, `${RDF}type`,             `${OWL}Restriction`)).toBe(true);
  expect(has(`${EX}R2`, `${OWL}onProperty`,        `${EX}hasPart`)).toBe(true);
  expect(has(`${EX}R2`, `${OWL}someValuesFrom`,    `${EX}FillerB`)).toBe(true);
  expect(has(`${EX}ClassA`, `${OWL}equivalentClass`, `${EX}R1`)).toBe(true);
  expect(has(`${EX}ClassB`, `${OWL}equivalentClass`, `${EX}R2`)).toBe(true);
  expect(has(`${EX}p1`, `${RDF}type`,             `${EX}FillerA`)).toBe(true);
  expect(has(`${EX}ind1`, `${EX}hasPart`,          `${EX}p1`)).toBe(true);

  // ── Run OWL-RL reasoning ────────────────────────────────────────────────

  const reasoningResult = await call(page, 'runReasoning', { rulesets: ['owl-rl.n3'] });
  console.log('[TEST] Reasoning result:', JSON.stringify(reasoningResult));

  // ── Inspect ind1 after reasoning ────────────────────────────────────────

  const details = await call(page, 'getNodeDetails', { iri: `${EX}ind1` }) as any;
  console.log('[TEST] ind1 details after reasoning:', JSON.stringify(details));

  const types: string[] = details?.data?.types ?? [];
  console.log('[TEST] ind1 inferred types:', types);

  // ind1 must be classified as ClassA (has FillerA filler)
  expect(types).toContain(`${EX}ClassA`);

  // ind1 must NOT be classified as ClassB (no FillerB filler)
  expect(types).not.toContain(`${EX}ClassB`);
});
