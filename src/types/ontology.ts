/**
 * @fileoverview Type definitions for ontology-related data structures
 * Provides comprehensive TypeScript interfaces for RDF/OWL ontology components,
 * knowledge graph entities, and related metadata.
 */

/**
 * Represents a namespace mapping in an ontology
 */
export interface NamespaceMap {
  /** The namespace prefix (e.g., 'foaf', 'owl') */
  prefix: string;
  /** The full URI of the namespace */
 iri: string;
}

/**
 * Represents an ontology class definition
 */
export interface OntologyClass {
  /** Unique identifier/URI for the class */
 iri: string;
  /** Human-readable label for the class */
  label: string;
  /** Namespace prefix this class belongs to */
  namespace: string;
  /** Array of property URIs associated with this class */
  properties: string[];
  /** Class restrictions and constraints */
  restrictions: Record<string, any>;
  /** Optional description of the class */
  description?: string;
  /** Parent classes (superclasses) */
  superClasses?: string[];
  /** Child classes (subclasses) */
  subClasses?: string[];
}

/**
 * Represents an object property in an ontology
 */
export interface ObjectProperty {
  /** Unique identifier/URI for the property */
 iri: string;
  /** Human-readable label for the property */
  label: string;
  /** Array of valid domain classes for this property */
  domain: string[];
  /** Array of valid range classes for this property */
  range: string[];
  /** Namespace prefix this property belongs to */
  namespace: string;
  /** Optional description of the property */
  description?: string;
  /** Whether this property is functional */
  isFunctional?: boolean;
  /** Whether this property is inverse functional */
  isInverseFunctional?: boolean;
  /** Whether this property is transitive */
  isTransitive?: boolean;
  /** Whether this property is symmetric */
  isSymmetric?: boolean;
}

/**
 * Represents an annotation property in an ontology
 */
export interface AnnotationProperty {
  /** Unique identifier/URI for the annotation property */
 iri: string;
  /** Human-readable label for the annotation property */
  label: string;
  /** Namespace prefix this property belongs to */
  namespace: string;
  /** Optional description of the annotation property */
  description?: string;
}

/**
 * Represents a loaded ontology with all its components
 */
export interface LoadedOntology {
  /** URL or identifier where the ontology was loaded from */
  url: string;
  /** Display name for the ontology */
  name?: string;
  /** All classes defined in this ontology */
  classes: OntologyClass[];
  /** All object properties defined in this ontology */
  properties: ObjectProperty[];
  /** All annotation properties defined in this ontology */
  annotationProperties?: AnnotationProperty[];
  /** Namespace mappings used in this ontology */
  namespaces: Record<string, string>;
  /** Metadata about the ontology */
  metadata?: {
    version?: string;
    description?: string;
    creator?: string;
    created?: Date;
    modified?: Date;
  };
}

/**
 * Represents a validation error in the knowledge graph
 */
export interface ValidationError {
  /** ID of the entity (node/edge) that has the error */
  nodeId: string;
  /** Human-readable error message */
  message: string;
  /** Severity level of the error */
  severity: 'error' | 'warning' | 'info';
  /** Type of validation that failed */
  type?: 'domain' | 'range' | 'cardinality' | 'type' | 'syntax';
  /** Suggested fix for the error */
  suggestion?: string;
}

/**
 * Represents a literal property value on an entity
 */
export interface LiteralProperty {
  /** Property URI or name */
  key: string;
  /** The literal value */
  value: string;
  /** Data type of the literal (e.g., 'xsd:string', 'xsd:integer') */
  datatype?: string;
  /** Language tag for string literals */
  language?: string;
}

/**
 * Represents an annotation property value on an entity
 */
export interface AnnotationPropertyValue {
  /** Annotation property URI */
  property: string;
  /** The annotation value */
  value: string;
  /** Data type of the annotation value */
  datatype?: string;
  /** Language tag for string annotation values */
  language?: string;
}

/**
 * Available entity types in the knowledge graph
 */
export type EntityType = 'class' | 'individual' | 'property' | 'annotation';

/**
 * Available RDF types for entities
 */
export type RDFType = 
  | 'owl:Class' 
  | 'owl:NamedIndividual' 
  | 'owl:ObjectProperty' 
  | 'owl:DatatypeProperty'
  | 'owl:AnnotationProperty'
  | 'rdfs:Class'
  | 'rdf:Property';

/**
 * Represents an entity in the knowledge graph (for autocomplete and UI)
 */
export interface KnowledgeGraphEntity {
  /** Unique URI identifier */
 iri: string;
  /** Human-readable label */
  label: string;
  /** Namespace prefix */
  namespace: string;
  /** RDF type of the entity */
  rdfType: RDFType;
  /** Entity type category */
  entityType?: EntityType;
  /** Optional description */
  description?: string;
  /** Additional RDF types */
  rdfTypes?: string[];
}

/**
 * Represents progress information for long-running operations
 */
export interface LoadingProgress {
  /** Current progress percentage (0-100) */
  progress: number;
  /** Current operation message */
  message: string;
  /** Current step number */
  step?: number;
  /** Total number of steps */
  totalSteps?: number;
}

/**
 * Configuration options for loading ontologies
 */
export interface OntologyLoadOptions {
  /** Progress callback function */
  onProgress?: (progress: LoadingProgress) => void;
  /** Whether to merge with existing ontologies or replace */
  merge?: boolean;
  /** Custom namespace mappings to use */
  customNamespaces?: Record<string, string>;
  /** Whether to validate the ontology after loading */
  validate?: boolean;
}

/**
 * Export format options for knowledge graphs
 */
export type ExportFormat = 'turtle' | 'owl-xml' | 'json-ld' | 'rdf-xml' | 'n3';

/**
 * View modes for the knowledge graph visualization
 */
export type ViewMode = 'abox' | 'tbox' | 'mixed';

/**
 * Color scheme for namespace visualization
 */
export interface NamespaceColorScheme {
  /** Background color */
  background: string;
  /** Text color */
  text: string;
  /** Border color */
  border: string;
  /** Accent color */
  accent: string;
}