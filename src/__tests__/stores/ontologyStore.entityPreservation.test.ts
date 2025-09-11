/**
 * @fileoverview Unit test for specific bug: rdfs:label disappears when loading additional ontology
 * Tests the exact scenario described by the user
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useOntologyStore } from '../../stores/ontologyStore';
import { FIXTURES } from '../fixtures/rdfFixtures';

describe('OntologyStore - Entity Property Preservation Bug', () => {
  beforeEach(() => {
    // Reset the store before each test
    const store = useOntologyStore.getState();
    store.clearOntologies();
  });

  it('should preserve rdfs:label on an entity when loading an additional ontology', async () => {
    const store = useOntologyStore.getState();

    // Step 1: Load initial demo dataset (simulating the length measurement tutorial)
    const demoDatasetRdf = FIXTURES['https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/specimen.ttl'];

    await store.loadOntologyFromRDF(demoDatasetRdf, undefined, false);

    // Use RDF store directly to assert the initial entity exists
    const rdfStore = store.rdfManager.getStore();
    const specimenUri = 'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength';
    const initialQuads = rdfStore.getQuads(specimenUri, null, null, null);
    expect(initialQuads.length).toBeGreaterThan(0);

    // Step 2: Simulate user adding rdfs:label via the public API (updateNode)
    store.updateNode(specimenUri, {
      annotationProperties: [
        {
          propertyUri: 'rdfs:label',
          value: 'Specimen Length Property',
          type: 'xsd:string'
        }
      ]
    });

    // Verify the rdfs:label was added to the RDF store
    const labelQuadsBefore = rdfStore.getQuads(
      specimenUri,
      'http://www.w3.org/2000/01/rdf-schema#label',
      null,
      null
    );
    expect(labelQuadsBefore.length).toBeGreaterThan(0);
    expect(labelQuadsBefore[0].object.value).toBe('Specimen Length Property');

    // Step 3: Load IOF ontology (should preserve existing graph changes)
    const iofOntologyRdf = FIXTURES['https://spec.industrialontologies.org/ontology/core/Core/'];
    await store.loadOntologyFromRDF(iofOntologyRdf, undefined, true);

    // Verify rdfs:label is still present in the RDF store after ontology load
    const labelQuadsAfter = rdfStore.getQuads(
      specimenUri,
      'http://www.w3.org/2000/01/rdf-schema#label',
      null,
      null
    );
    expect(labelQuadsAfter.length).toBeGreaterThan(0);
    expect(labelQuadsAfter[0].object.value).toBe('Specimen Length Property');
  });

  it('should update RDF store immediately when entity is modified', () => {
    const store = useOntologyStore.getState();
    const rdfStore = store.rdfManager.getStore();

    const entityUri = 'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength';

    // Update entity with rdfs:label
    store.updateNode(entityUri, {
      annotationProperties: [
        {
          propertyUri: 'rdfs:label',
          value: 'Test Label',
          type: 'xsd:string'
        }
      ]
    });

    // Verify it's immediately in the RDF store
    const quads = rdfStore.getQuads(
      entityUri,
      'http://www.w3.org/2000/01/rdf-schema#label',
      null,
      null
    );

    expect(quads.length).toBeGreaterThan(0);
    expect(quads[0].object.value).toBe('Test Label');
  });

  it('should preserve all entity updates when merging graphs during ontology load', async () => {
    const store = useOntologyStore.getState();
    const rdfStore = store.rdfManager.getStore();

    // Create initial graph with an entity
    const initialNodes = [{
      id: 'entity1',
      data: {
        uri: 'http://example.com/entity1',
        classType: 'Length',
        namespace: 'iof-qual',
        literalProperties: [
          { key: 'rdfs:label', value: 'Original Label', type: 'xsd:string' },
          { key: 'rdfs:comment', value: 'Original Comment', type: 'xsd:string' }
        ]
      }
    }];

    store.setCurrentGraph(initialNodes, []);

    // Update entity in RDF store (simulating user edits)
    store.updateNode('http://example.com/entity1', {
      annotationProperties: [
        { propertyUri: 'rdfs:label', value: 'Updated Label', type: 'xsd:string' },
        { propertyUri: 'rdfs:comment', value: 'Updated Comment', type: 'xsd:string' },
        { propertyUri: 'dc:description', value: 'New Description', type: 'xsd:string' }
      ]
    });

    // Load new ontology with preservation
    const newOntologyRdf = FIXTURES['foaf_test_data'] + `
@prefix ex: <http://example.com/new/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

ex:newEntity a ex:NewClass ;
  rdfs:label "New Entity" .
`;
    await store.loadOntologyFromRDF(newOntologyRdf, undefined, true);

    // Verify original entity still has all its properties in the RDF store
    const labelQuads = rdfStore.getQuads('http://example.com/entity1', 'http://www.w3.org/2000/01/rdf-schema#label', null, null);
    const commentQuads = rdfStore.getQuads('http://example.com/entity1', 'http://www.w3.org/2000/01/rdf-schema#comment', null, null);
    const descQuads = rdfStore.getQuads('http://example.com/entity1', 'http://purl.org/dc/elements/1.1/description', null, null);

    expect(labelQuads.length).toBeGreaterThan(0);
    expect(commentQuads.length).toBeGreaterThan(0);
    expect(descQuads.length).toBeGreaterThan(0);

    expect(labelQuads[0].object.value).toBe('Updated Label');
    expect(commentQuads[0].object.value).toBe('Updated Comment');
    expect(descQuads[0].object.value).toBe('New Description');
  });
});
