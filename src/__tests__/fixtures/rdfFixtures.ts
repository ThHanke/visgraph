/**
 * Centralized RDF fixtures for tests.
 * Export a FIXTURES mapping URL -> Turtle content so tests and test-setup can import it.
 */

export const FIXTURES: Record<string, string> = {
  foaf_test_data: `
    @prefix foaf: <http://xmlns.com/foaf/0.1/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
    @prefix : <http://example.org/> .

    foaf:Person a owl:Class ;
        rdfs:label "Person" .
    foaf:Organization a owl:Class ;
        rdfs:label "Organization" .
    foaf:name a owl:DatatypeProperty ;
        rdfs:label "name" .

    # Provide memberOf property metadata (domain/range) so tests expecting
    # domain/range triples (for reasoning) find them in the fixture.
    foaf:memberOf a rdf:Property ;
        rdfs:domain foaf:Person ;
        rdfs:range foaf:Organization .
  `,

  "https://www.w3.org/TR/vocab-org/": `
    @prefix org: <https://www.w3.org/TR/vocab-org/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix : <http://example.org/> .

    org:Organization a rdfs:Class .
  `,

  // IOF core and materials fixtures to cover tests that reference those prefixes/URLs
  "https://spec.industrialontologies.org/ontology/core/Core/": `
    @prefix iof: <https://spec.industrialontologies.org/ontology/core/Core/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

    iof:MeasurementProcess a owl:Class ;
        rdfs:label "Measurement Process" .

    # Add a small specimen triple so tests that expect an iof:Specimen occurrence
    # find a matching object when this fixture is loaded (keeps fixtures self-contained).
    <http://example.com/subject> rdf:type iof:Specimen .
  `,

  // IOF URL variant used in some tests (contains a specimen triple)
  "https://spec.industrialontologies.org/iof/ontology/core/Core/": `
    @prefix iof: <https://spec.industrialontologies.org/iof/ontology/core/Core/> .
    @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

    <http://example.com/subject> rdf:type iof:Specimen .
  `,

  "https://spec.industrialontologies.org/ontology/materials/Materials/": `
    @prefix iof-mat: <https://spec.industrialontologies.org/ontology/materials/Materials/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

    iof-mat:MeasurementDevice a rdfs:Class ;
        rdfs:label "Measurement Device" .
  `,

  "https://spec.industrialontologies.org/ontology/qualities/": `
    @prefix iof-qual: <https://spec.industrialontologies.org/ontology/qualities/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

    iof-qual:Length a rdfs:Class .
  `,

  // Demo graph entries used by tests (github IOF materials tutorial) and startupFileUrl variants
  "https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/example.ttl": `
    @prefix iof-qual: <https://spec.industrialontologies.org/ontology/qualities/> .
    @prefix : <https://github.com/Mat-O-Lab/IOFMaterialsTutorial/> .
    :SpecimenLength a iof-qual:Length .
    :Caliper a <https://spec.industrialontologies.org/ontology/materials/Materials/MeasurementDevice> .
  `,

  // Additional demo snippet used by some tests (contains :Specimen subject)
  "https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/main/specimen.ttl": `
    @prefix : <https://github.com/Mat-O-Lab/IOFMaterialsTutorial/> .
    @prefix iof: <https://spec.industrialontologies.org/ontology/core/Core/> .
    @prefix iof-mat: <https://spec.industrialontologies.org/ontology/materials/Materials/> .
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix iof-qual: <https://spec.industrialontologies.org/ontology/qualities/> .

    :Specimen a owl:NamedIndividual,
            iof-mat:Specimen ;
        iof:hasQuality :SpecimenLength ;
        iof:isInputOf :LengthMeasurementProcess .

    # Define the referenced SpecimenLength so tests that load this fixture alone
    # have the associated triples present in the RDF store.
    :SpecimenLength a iof-qual:Length ;
        rdfs:label "Specimen Length" .
  `,

  "https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/refs/heads/main/LengthMeasurement.ttl": `
    @prefix : <https://github.com/Mat-O-Lab/IOFMaterialsTutorial/> .
    @prefix iof-qual: <https://spec.industrialontologies.org/ontology/qualities/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

    :SpecimenLength a iof-qual:Length ;
        rdfs:label "Specimen Length" .
  `,

  // Local/example fixtures used by many tests
  "http://example.com/basic/john": `
    @prefix ex: <http://example.com/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

    ex:john_doe a ex:Person ;
        rdfs:label "John Doe" .
  `,

  "http://example.com/initial/entity1": `
    @prefix ex: <http://example.com/> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

    ex:entity1 a ex:TestClass .
  `,

  "http://example.com/additional/thing": `
    @prefix owl: <http://www.w3.org/2002/07/owl#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

    owl:Thing a owl:Class ;
        rdfs:label "Thing" .
  `,

  "http://example.com/new-org": `
    @prefix foaf: <http://xmlns.com/foaf/0.1/> .
    @prefix ex: <http://example.com/> .

    ex:newPerson a foaf:Person ;
      foaf:name "Jane Smith" ;
      foaf:email "jane@example.com" .

    ex:newOrg a foaf:Organization ;
      foaf:name "New Company" .
  `,
};
