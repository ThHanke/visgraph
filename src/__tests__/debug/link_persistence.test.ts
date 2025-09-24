import { beforeEach, describe, expect, it } from 'vitest';
import { rdfManager } from '../../utils/rdfManager';
import { DataFactory } from 'n3';
const { namedNode, literal, quad } = DataFactory;

describe('link persistence should not remove unrelated annotation triples', () => {
  beforeEach(() => {
    // start each test with a clean store
    rdfManager.clear();
  });

  it('adding a new object-property triple must not delete existing annotation triples on the object', async () => {
    const dataGraph = 'urn:vg:data';
    const objIri = 'http://example.org/test-node-2';
    const subjIri = 'http://example.org/test-node-1';
    const annotationPred = 'http://purl.org/dc/elements/1.1/title';
    const annotationValue = 'Original Title';
    const predForEdge = 'http://example.org/hasRelation';

    // 1) add an annotation triple for the target/object node
    const ttlAnnotation = `<${objIri}> <${annotationPred}> "${annotationValue}" .\n`;
    await rdfManager.loadRDFIntoGraph(ttlAnnotation, dataGraph, 'text/turtle');

    // verify annotation present
    const store = rdfManager.getStore();
    const subjTerm = namedNode(String(objIri));
    const predTerm = namedNode(String(annotationPred));
    const g = namedNode(dataGraph);
    const foundAnnotation = store.getQuads(subjTerm, predTerm, null, g) || [];
    expect(foundAnnotation.length).toBeGreaterThan(0);

    // 2) simulate creating a link (source -> predicate -> object)
    const ttlEdge = `<${subjIri}> <${predForEdge}> <${objIri}> .\n`;
    await rdfManager.loadRDFIntoGraph(ttlEdge, dataGraph, 'text/turtle');

    // 3) After adding the edge, the object's annotation triple must still exist
    const foundAfter = store.getQuads(subjTerm, predTerm, null, g) || [];
    expect(foundAfter.length).toBeGreaterThan(0);

    // Extra sanity: the new edge triple should be present as well
    const edgePredTerm = namedNode(String(predForEdge));
    const edgeFound = store.getQuads(namedNode(String(subjIri)), edgePredTerm, namedNode(String(objIri)), g) || [];
    expect(edgeFound.length).toBeGreaterThan(0);
  });
});
