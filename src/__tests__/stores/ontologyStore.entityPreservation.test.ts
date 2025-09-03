/**
 * @fileoverview Unit test for specific bug: rdfs:label disappears when loading additional ontology
 * Tests the exact scenario described by the user
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useOntologyStore } from '../../stores/ontologyStore';

describe('OntologyStore - Entity Property Preservation Bug', () => {
  beforeEach(() => {
    // Reset the store before each test
    const store = useOntologyStore.getState();
    store.clearOntologies();
  });

  it('should preserve rdfs:label added to specimenLength entity when loading IOF ontology', async () => {
    const store = useOntologyStore.getState();

    // Step 1: Load initial demo dataset (simulating the length measurement tutorial)
    const demoDatasetRdf = `
      @prefix : <https://github.com/Mat-O-Lab/IOFMaterialsTutorial/> .
      @prefix iof: <https://spec.industrialontologies.org/ontology/core/Core/> .
      @prefix iof-qual: <https://spec.industrialontologies.org/ontology/qualities/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

      :SpecimenLength a iof-qual:Length ;
          iof:masuredByAtSomeTime :Caliper .

      :Caliper a iof-mat:MeasurementDevice .
    `;

    await store.loadOntologyFromRDF(demoDatasetRdf, undefined, false);

    // Verify initial dataset is loaded
    expect(store.currentGraph.nodes.length).toBeGreaterThan(0);
    
    // Find the SpecimenLength node
    const specimenLengthNode = store.currentGraph.nodes.find(
      node => node.data.uri === 'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength'
    );
    expect(specimenLengthNode).toBeDefined();

    // Step 2: User adds rdfs:label to specimenLength entity (simulating manual edit)
    const updatedNode = {
      ...specimenLengthNode!,
      data: {
        ...specimenLengthNode!.data,
        literalProperties: [
          ...(specimenLengthNode!.data.literalProperties || []),
          {
            key: 'rdfs:label',
            value: 'Specimen Length Property',
            type: 'xsd:string'
          }
        ]
      }
    };

    // Update the graph with the new property
    const updatedNodes = store.currentGraph.nodes.map(node => 
      node.id === specimenLengthNode!.id ? updatedNode : node
    );
    store.setCurrentGraph(updatedNodes, store.currentGraph.edges);

    // Update the RDF store as well (simulating what should happen when user edits)
    store.updateEntity(specimenLengthNode!.data.uri, {
      annotationProperties: [
        {
          propertyUri: 'rdfs:label',
          value: 'Specimen Length Property',
          type: 'xsd:string'
        }
      ]
    });

    // Verify the rdfs:label was added
    const nodeAfterEdit = store.currentGraph.nodes.find(
      node => node.data.uri === 'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength'
    );
    expect(nodeAfterEdit).toBeDefined();
    expect(nodeAfterEdit!.data.literalProperties).toBeDefined();
    const rdfsLabel = nodeAfterEdit!.data.literalProperties.find(
      prop => prop.key === 'rdfs:label'
    );
    expect(rdfsLabel).toBeDefined();
    expect(rdfsLabel!.value).toBe('Specimen Length Property');

    console.log('Before loading IOF ontology:');
    console.log('SpecimenLength node:', JSON.stringify(nodeAfterEdit, null, 2));

    // Step 3: Load IOF prefixed ontology (simulating "load ontology" function)
    const iofOntologyRdf = `
      @prefix iof: <https://spec.industrialontologies.org/ontology/core/Core/> .
      @prefix iof-mat: <https://spec.industrialontologies.org/ontology/materials/Materials/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .

      iof:MeasurementProcess a owl:Class ;
          rdfs:label "Measurement Process" .

      iof-mat:MeasurementDevice a owl:Class ;
          rdfs:label "Measurement Device" .

      iof:hasOutput a owl:ObjectProperty ;
          rdfs:label "has output" .
    `;

    // This should preserve existing graph changes
    await store.loadOntologyFromRDF(iofOntologyRdf, undefined, true);

    console.log('After loading IOF ontology:');
    console.log('Current graph nodes:', store.currentGraph.nodes.length);

    // Step 4: Verify that rdfs:label is still present on specimenLength
    const nodeAfterOntologyLoad = store.currentGraph.nodes.find(
      node => node.data.uri === 'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength'
    );

    console.log('SpecimenLength node after IOF load:', JSON.stringify(nodeAfterOntologyLoad, null, 2));

    expect(nodeAfterOntologyLoad).toBeDefined();
    expect(nodeAfterOntologyLoad!.data.literalProperties).toBeDefined();
    
    const preservedRdfsLabel = nodeAfterOntologyLoad!.data.literalProperties.find(
      prop => prop.key === 'rdfs:label'
    );
    
    // This is the bug - the rdfs:label should still be there but it disappears
    expect(preservedRdfsLabel).toBeDefined();
    expect(preservedRdfsLabel!.value).toBe('Specimen Length Property');

    // Also verify it's in the RDF store
    const rdfStore = store.rdfManager.getStore();
    const quads = rdfStore.getQuads(
      'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength',
      'http://www.w3.org/2000/01/rdf-schema#label',
      null,
      null
    );
    expect(quads.length).toBeGreaterThan(0);
    expect(quads[0].object.value).toBe('Specimen Length Property');
  });

  it('should update RDF store immediately when entity is modified', () => {
    const store = useOntologyStore.getState();

    const entityUri = 'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/SpecimenLength';
    
    // Update entity with rdfs:label
    store.updateEntity(entityUri, {
      annotationProperties: [
        {
          propertyUri: 'rdfs:label',
          value: 'Test Label',
          type: 'xsd:string'
        }
      ]
    });

    // Verify it's immediately in the RDF store
    const rdfStore = store.rdfManager.getStore();
    const quads = rdfStore.getQuads(
      entityUri,
      'http://www.w3.org/2000/01/rdf-schema#label',
      null,
      null
    );
    
    expect(quads.length).toBe(1);
    expect(quads[0].object.value).toBe('Test Label');
  });

  it('should preserve all entity updates when merging graphs during ontology load', async () => {
    const store = useOntologyStore.getState();

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
    store.updateEntity('http://example.com/entity1', {
      annotationProperties: [
        { propertyUri: 'rdfs:label', value: 'Updated Label', type: 'xsd:string' },
        { propertyUri: 'rdfs:comment', value: 'Updated Comment', type: 'xsd:string' },
        { propertyUri: 'dc:description', value: 'New Description', type: 'xsd:string' }
      ]
    });

    // Update the graph to reflect changes
    const updatedNodes = [{
      ...initialNodes[0],
      data: {
        ...initialNodes[0].data,
        literalProperties: [
          { key: 'rdfs:label', value: 'Updated Label', type: 'xsd:string' },
          { key: 'rdfs:comment', value: 'Updated Comment', type: 'xsd:string' },
          { key: 'dc:description', value: 'New Description', type: 'xsd:string' }
        ]
      }
    }];
    store.setCurrentGraph(updatedNodes, []);

    // Load new ontology with preservation
    const newOntologyRdf = `
      @prefix ex: <http://example.com/new/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

      ex:newEntity a ex:NewClass ;
          rdfs:label "New Entity" .
    `;

    await store.loadOntologyFromRDF(newOntologyRdf, undefined, true);

    // Verify original entity still has all its properties
    const preservedEntity = store.currentGraph.nodes.find(
      node => node.data.uri === 'http://example.com/entity1'
    );

    expect(preservedEntity).toBeDefined();
    expect(preservedEntity!.data.literalProperties).toHaveLength(3);
    
    const labelProp = preservedEntity!.data.literalProperties.find(p => p.key === 'rdfs:label');
    const commentProp = preservedEntity!.data.literalProperties.find(p => p.key === 'rdfs:comment');
    const descProp = preservedEntity!.data.literalProperties.find(p => p.key === 'dc:description');

    expect(labelProp?.value).toBe('Updated Label');
    expect(commentProp?.value).toBe('Updated Comment');
    expect(descProp?.value).toBe('New Description');
  });
});