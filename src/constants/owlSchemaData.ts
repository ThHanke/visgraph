/**
 * OWL/RDFS/RDF meta-ontology axioms (domain and range declarations).
 *
 * These axioms are seeded into urn:vg:ontologies by the worker at startup so
 * that the fat-map reconciliation (buildFatMap / updateFatMap) automatically
 * produces ObjectProperty entries with correct domain[] and range[] data.
 * The mapper then derives TBOX_STRUCT_BOTH_SIDES and TBOX_STRUCT_SUBJ_ONLY
 * from that fat-map data — no hardcoded predicate lists in the mapper.
 *
 * Sources:
 *   https://www.w3.org/TR/owl2-rdf-based-semantics/ (OWL 2 meta-ontology)
 *   https://www.w3.org/TR/rdf-schema/ (RDFS meta-ontology)
 *   https://www.w3.org/TR/rdf-syntax-grammar/ (RDF meta-ontology)
 */

const RDF  = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS = "http://www.w3.org/2000/01/rdf-schema#";
const OWL  = "http://www.w3.org/2002/07/owl#";

export interface SchemaPredicateAxiom {
  predicate: string;
  domain?: string;
  range?: string;
}

export const OWL_SCHEMA_AXIOMS: readonly SchemaPredicateAxiom[] = [

  // ── RDFS structural predicates ────────────────────────────────────────────
  { predicate: `${RDFS}subClassOf`,    domain: `${RDFS}Class`,    range: `${RDFS}Class`   },
  { predicate: `${RDFS}subPropertyOf`, domain: `${RDF}Property`,  range: `${RDF}Property` },
  { predicate: `${RDFS}domain`,        domain: `${RDF}Property`,  range: `${RDFS}Class`   },
  { predicate: `${RDFS}range`,         domain: `${RDF}Property`,  range: `${RDFS}Class`   },

  // ── OWL class-expression predicates (both subject and object are TBox) ────
  { predicate: `${OWL}equivalentClass`,      domain: `${OWL}Class`,          range: `${OWL}Class`          },
  { predicate: `${OWL}disjointWith`,         domain: `${OWL}Class`,          range: `${OWL}Class`          },
  { predicate: `${OWL}complementOf`,         domain: `${OWL}Class`,          range: `${OWL}Class`          },
  { predicate: `${OWL}onProperty`,           domain: `${OWL}Restriction`,    range: `${RDF}Property`       },
  { predicate: `${OWL}allValuesFrom`,        domain: `${OWL}Restriction`,    range: `${RDFS}Class`         },
  { predicate: `${OWL}someValuesFrom`,       domain: `${OWL}Restriction`,    range: `${RDFS}Class`         },
  { predicate: `${OWL}onClass`,              domain: `${OWL}Restriction`,    range: `${OWL}Class`          },
  { predicate: `${OWL}onDataRange`,          domain: `${OWL}Restriction`,    range: `${RDFS}Datatype`      },
  { predicate: `${OWL}inverseOf`,            domain: `${OWL}ObjectProperty`, range: `${OWL}ObjectProperty` },
  { predicate: `${OWL}equivalentProperty`,   domain: `${RDF}Property`,       range: `${RDF}Property`       },
  { predicate: `${OWL}propertyDisjointWith`, domain: `${RDF}Property`,       range: `${RDF}Property`       },

  // ── OWL predicates where ONLY the subject is TBox ─────────────────────────
  //    (range is rdf:List of individuals, or an individual — not a class)
  { predicate: `${OWL}propertyChainAxiom`, domain: `${OWL}ObjectProperty`      },
  { predicate: `${OWL}hasValue`,           domain: `${OWL}Restriction`          },
  { predicate: `${OWL}intersectionOf`,     domain: `${OWL}Class`                },
  { predicate: `${OWL}unionOf`,            domain: `${OWL}Class`                },
  { predicate: `${OWL}oneOf`,              domain: `${OWL}Class`                },

  // ── OWL n-ary axiom predicates ────────────────────────────────────────────
  // owl:members is polymorphic: AllDisjointClasses/AllDisjointProperties (TBox) entry below;
  // owl:AllDifferent also uses owl:members (ABox) — handled specially in the mapper pre-scan.
  { predicate: `${OWL}members`,         domain: `${OWL}AllDisjointClasses`  },
  { predicate: `${OWL}distinctMembers`, domain: `${OWL}AllDifferent`        },
];

/**
 * W3C metaclass IRIs — the single source of truth for TBox classification.
 *
 * A node whose rdf:type contains any of these is a TBox entity (it IS a class,
 * property, restriction, or structural schema axiom).  Everything else is either
 * ABox or unknown.
 *
 * Derivation: these are the types defined in the RDF 1.1, RDFS, and OWL 2 specs
 * themselves.  They are irreducible bootstrap vocabulary — you must know what
 * rdf:type owl:Class means to bootstrap any OWL reasoning.
 *
 * Intentional omissions:
 *   - owl:AllDifferent   — ABox axiom (asserts individuals are distinct)
 *   - owl:Thing / owl:Nothing — too broad, instances are ABox individuals
 *
 * Also used by the mapper when testing availableProperties[].domain / .range to
 * decide whether a predicate is schema-structural (TBOX_STRUCT_* sets).
 */
export const SCHEMA_TBOX_CLASS_IRIS = new Set<string>([
  // ── Core RDF / RDFS metaclasses ───────────────────────────────────────────
  `${RDFS}Class`,
  `${RDF}Property`,
  `${RDFS}Datatype`,

  // ── OWL class and property metaclasses ────────────────────────────────────
  `${OWL}Class`,
  `${OWL}ObjectProperty`,
  `${OWL}DatatypeProperty`,
  `${OWL}AnnotationProperty`,

  // ── OWL class-expression types ────────────────────────────────────────────
  `${OWL}Restriction`,

  // ── OWL structural axiom types (TBox — defined in the schema layer) ───────
  `${OWL}AllDisjointClasses`,
  `${OWL}AllDisjointProperties`,
  `${OWL}Ontology`,

  // ── OWL property characteristic types ────────────────────────────────────
  `${OWL}TransitiveProperty`,
  `${OWL}SymmetricProperty`,
  `${OWL}AsymmetricProperty`,
  `${OWL}ReflexiveProperty`,
  `${OWL}IrreflexiveProperty`,
  `${OWL}FunctionalProperty`,
  `${OWL}InverseFunctionalProperty`,
]);
