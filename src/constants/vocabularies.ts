/**
 * Centralized W3C and standard RDF/OWL/SHACL vocabulary constants
 * 
 * This file provides a single source of truth for commonly used URIs
 * from W3C standards to avoid string literal duplication across the codebase.
 */

// ============================================================================
// RDF (Resource Description Framework)
// https://www.w3.org/1999/02/22-rdf-syntax-ns
// ============================================================================

export const RDF = {
  namespace: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  type: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
  Property: "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property",
} as const;

// ============================================================================
// RDFS (RDF Schema)
// https://www.w3.org/2000/01/rdf-schema
// ============================================================================

export const RDFS = {
  namespace: "http://www.w3.org/2000/01/rdf-schema#",
  label: "http://www.w3.org/2000/01/rdf-schema#label",
  comment: "http://www.w3.org/2000/01/rdf-schema#comment",
  seeAlso: "http://www.w3.org/2000/01/rdf-schema#seeAlso",
} as const;

// ============================================================================
// OWL (Web Ontology Language)
// https://www.w3.org/2002/07/owl
// ============================================================================

export const OWL = {
  namespace: "http://www.w3.org/2002/07/owl#",
  Class: "http://www.w3.org/2002/07/owl#Class",
  ObjectProperty: "http://www.w3.org/2002/07/owl#ObjectProperty",
  DatatypeProperty: "http://www.w3.org/2002/07/owl#DatatypeProperty",
  AnnotationProperty: "http://www.w3.org/2002/07/owl#AnnotationProperty",
  NamedIndividual: "http://www.w3.org/2002/07/owl#NamedIndividual",
  Ontology: "http://www.w3.org/2002/07/owl#Ontology",
  imports: "http://www.w3.org/2002/07/owl#imports",
} as const;

// ============================================================================
// XSD (XML Schema Datatypes)
// https://www.w3.org/2001/XMLSchema
// ============================================================================

export const XSD = {
  namespace: "http://www.w3.org/2001/XMLSchema#",
  string: "http://www.w3.org/2001/XMLSchema#string",
  integer: "http://www.w3.org/2001/XMLSchema#integer",
  boolean: "http://www.w3.org/2001/XMLSchema#boolean",
  decimal: "http://www.w3.org/2001/XMLSchema#decimal",
  dateTime: "http://www.w3.org/2001/XMLSchema#dateTime",
  date: "http://www.w3.org/2001/XMLSchema#date",
} as const;

// ============================================================================
// SHACL (Shapes Constraint Language)
// https://www.w3.org/ns/shacl
// ============================================================================

export const SHACL = {
  namespace: "http://www.w3.org/ns/shacl#",
  ValidationResult: "http://www.w3.org/ns/shacl#ValidationResult",
  focusNode: "http://www.w3.org/ns/shacl#focusNode",
  resultMessage: "http://www.w3.org/ns/shacl#resultMessage",
  resultSeverity: "http://www.w3.org/ns/shacl#resultSeverity",
  Violation: "http://www.w3.org/ns/shacl#Violation",
  Warning: "http://www.w3.org/ns/shacl#Warning",
  Info: "http://www.w3.org/ns/shacl#Info",
} as const;

// ============================================================================
// Convenience exports for commonly used URIs
// ============================================================================

export const RDF_TYPE = RDF.type;
export const RDFS_LABEL = RDFS.label;
export const OWL_NAMED_INDIVIDUAL = OWL.NamedIndividual;
export const OWL_ONTOLOGY = OWL.Ontology;
export const OWL_IMPORTS = OWL.imports;
export const XSD_STRING = XSD.string;
