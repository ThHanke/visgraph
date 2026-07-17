/**
 * owlProfile.ts
 *
 * PRAGMATIC SUBSET — NOT a complete OWL 2 profile validator.
 *
 * Two distinct things live here:
 *
 *  A) checkOwl2Profile(triples) — the original, deliberately-incomplete OWL 2 DL
 *     sanity check. It catches the high-frequency mistakes LLMs make when
 *     authoring ontologies:
 *       1. Object property used with a literal value (non-annotation triples).
 *       2. Datatype property used with an IRI value.
 *       3. Property declared as both owl:ObjectProperty and owl:DatatypeProperty.
 *       4. Literal appearing in the object position of rdf:type.
 *     Annotation properties (rdfs:label, rdfs:comment, and predicates declared
 *     owl:AnnotationProperty) are exempt from checks 1 and 2.
 *
 *  B) detectOwl2Profiles(triples) — a STRUCTURAL detector for the OWL 2 EL / QL /
 *     RL profiles (plus the DL sanity check above). OWL 2 EL, QL and RL are
 *     *syntactic* profiles: each is defined purely by which class/property
 *     constructs are allowed to appear (and, for RL/QL, on which side of a
 *     subclass axiom). This detector scans the RDF graph for the disallowed
 *     constructs of each profile and reports, per profile, whether the ontology
 *     stays inside it and exactly which construct broke it.
 *
 *     This is a STRUCTURAL APPROXIMATION, not a certified profile validator.
 *     See the per-profile "WHAT WE CHECK / WHAT WE DON'T" notes below. We cover
 *     the commonly-decisive disallowed constructs; we intentionally skip many
 *     spec corner cases (e.g. full datatype-map restrictions, the exact
 *     EL-permitted self-restriction / single-nominal cases, anonymous-individual
 *     subtleties, RL's precise sub/super-class grammar for every operator).
 *
 *     `mostRestrictive` reports the tightest profile the ontology fits, which is
 *     the practically useful signal: it tells a tool/agent whether a cheaper,
 *     profile-specific reasoner (an EL/QL/RL engine) is sound & complete for this
 *     ontology instead of a full OWL 2 DL reasoner.
 */

// ────────────────────────────── Well-known IRIs ──────────────────────────────

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';

const RDF_TYPE = `${RDF}type`;
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const RDF_NIL = `${RDF}nil`;

const RDFS_LABEL = `${RDFS}label`;
const RDFS_COMMENT = `${RDFS}comment`;
const RDFS_SUBCLASS_OF = `${RDFS}subClassOf`;

const OWL_EQUIVALENT_CLASS = `${OWL}equivalentClass`;

const OWL_OBJECT_PROPERTY = `${OWL}ObjectProperty`;
const OWL_DATATYPE_PROPERTY = `${OWL}DatatypeProperty`;
const OWL_ANNOTATION_PROPERTY = `${OWL}AnnotationProperty`;

const OWL_RESTRICTION = `${OWL}Restriction`;
const OWL_ON_PROPERTY = `${OWL}onProperty`;
const OWL_SOME_VALUES_FROM = `${OWL}someValuesFrom`;
const OWL_ALL_VALUES_FROM = `${OWL}allValuesFrom`;
const OWL_HAS_VALUE = `${OWL}hasValue`;
const OWL_HAS_SELF = `${OWL}hasSelf`;
const OWL_MAX_CARDINALITY = `${OWL}maxCardinality`;
const OWL_MIN_CARDINALITY = `${OWL}minCardinality`;
const OWL_CARDINALITY = `${OWL}cardinality`;
const OWL_MAX_QUALIFIED_CARDINALITY = `${OWL}maxQualifiedCardinality`;
const OWL_MIN_QUALIFIED_CARDINALITY = `${OWL}minQualifiedCardinality`;
const OWL_QUALIFIED_CARDINALITY = `${OWL}qualifiedCardinality`;

const OWL_UNION_OF = `${OWL}unionOf`;
const OWL_INTERSECTION_OF = `${OWL}intersectionOf`;
const OWL_COMPLEMENT_OF = `${OWL}complementOf`;
const OWL_ONE_OF = `${OWL}oneOf`;
const OWL_DISJOINT_UNION_OF = `${OWL}disjointUnionOf`;

const OWL_INVERSE_OF = `${OWL}inverseOf`;
const OWL_PROPERTY_CHAIN_AXIOM = `${OWL}propertyChainAxiom`;
const OWL_HAS_KEY = `${OWL}hasKey`;

const OWL_TRANSITIVE_PROPERTY = `${OWL}TransitiveProperty`;
const OWL_FUNCTIONAL_PROPERTY = `${OWL}FunctionalProperty`;
const OWL_INVERSE_FUNCTIONAL_PROPERTY = `${OWL}InverseFunctionalProperty`;
const OWL_IRREFLEXIVE_PROPERTY = `${OWL}IrreflexiveProperty`;
const OWL_REFLEXIVE_PROPERTY = `${OWL}ReflexiveProperty`;
const OWL_ASYMMETRIC_PROPERTY = `${OWL}AsymmetricProperty`;
const OWL_SYMMETRIC_PROPERTY = `${OWL}SymmetricProperty`;

// ─────────────────────────────── Public types ────────────────────────────────

export interface ProfileTriple {
  subject: string;         // IRI or blank-node id
  predicate: string;       // IRI
  object: string;          // IRI, blank-node id, or literal lexical value
  objectIsLiteral: boolean; // true if object is an RDF literal
}

export interface ProfileViolation {
  axiom: string;   // human-readable rendering of the offending triple
  reason: string;  // why it violates OWL 2 DL, plain language
}

export interface ProfileReport {
  owl2dl: boolean;           // false if any violation found
  violations: ProfileViolation[];
}

/** A single profile (EL / QL / RL / DL) verdict. */
export interface SingleProfileReport {
  valid: boolean;
  violations: ProfileConstructViolation[];
}

export interface ProfileConstructViolation {
  construct: string; // the disallowed construct, e.g. 'owl:allValuesFrom'
  axiom: string;     // human-readable rendering of where it occurred
  reason: string;    // why it is not allowed in this profile
}

export type ProfileName = 'EL' | 'QL' | 'RL' | 'DL' | 'Full';

export interface Owl2ProfilesReport {
  dl: SingleProfileReport;
  el: SingleProfileReport;
  ql: SingleProfileReport;
  rl: SingleProfileReport;
  /** Tightest profile the ontology fits — handy for picking a fast reasoner. */
  mostRestrictive: ProfileName;
}

// ─────────────────────────────── Helpers ─────────────────────────────────────

function renderTriple(t: ProfileTriple): string {
  const obj = t.objectIsLiteral ? `"${t.object}"` : t.object;
  return `${t.subject} ${t.predicate} ${obj}`;
}

function localish(iri: string): string {
  if (iri.startsWith(OWL)) return `owl:${iri.slice(OWL.length)}`;
  if (iri.startsWith(RDFS)) return `rdfs:${iri.slice(RDFS.length)}`;
  if (iri.startsWith(RDF)) return `rdf:${iri.slice(RDF.length)}`;
  return iri;
}

// ─────────────────────────────── DL sanity check ─────────────────────────────

/**
 * Original OWL 2 DL pragmatic subset check. Unchanged behaviour — callers and
 * the existing tests depend on its exact { owl2dl, violations } shape.
 */
export function checkOwl2Profile(triples: ProfileTriple[]): ProfileReport {
  const violations: ProfileViolation[] = [];

  // Pass 1: collect property type declarations and annotation properties.
  const objectProperties = new Set<string>();
  const datatypeProperties = new Set<string>();
  const annotationProperties = new Set<string>([RDFS_LABEL, RDFS_COMMENT]);

  for (const t of triples) {
    if (t.predicate === RDF_TYPE && !t.objectIsLiteral) {
      if (t.object === OWL_OBJECT_PROPERTY) {
        objectProperties.add(t.subject);
      } else if (t.object === OWL_DATATYPE_PROPERTY) {
        datatypeProperties.add(t.subject);
      } else if (t.object === OWL_ANNOTATION_PROPERTY) {
        annotationProperties.add(t.subject);
      }
    }
  }

  // Check 3: property declared as both ObjectProperty and DatatypeProperty.
  for (const iri of objectProperties) {
    if (datatypeProperties.has(iri)) {
      violations.push({
        axiom: iri,
        reason: `property declared as both object and datatype property`,
      });
    }
  }

  // Pass 2: check usage triples.
  for (const t of triples) {
    // Check 4: literal in rdf:type object position.
    if (t.predicate === RDF_TYPE && t.objectIsLiteral) {
      violations.push({
        axiom: renderTriple(t),
        reason: 'class position occupied by a literal',
      });
      continue;
    }

    // Skip annotation predicates for checks 1 and 2.
    if (annotationProperties.has(t.predicate)) {
      continue;
    }

    // Check 1: object property used with a literal object.
    if (objectProperties.has(t.predicate) && t.objectIsLiteral) {
      violations.push({
        axiom: renderTriple(t),
        reason: 'object property used with a literal value',
      });
    }

    // Check 2: datatype property used with an IRI object.
    if (datatypeProperties.has(t.predicate) && !t.objectIsLiteral) {
      violations.push({
        axiom: renderTriple(t),
        reason: 'datatype property used with an IRI value',
      });
    }
  }

  return {
    owl2dl: violations.length === 0,
    violations,
  };
}

// ────────────────────── Structural profile detection (EL/QL/RL) ──────────────

/**
 * Pre-indexed view of the graph, so each profile rule can ask cheap questions
 * (e.g. "what is the rdf:type set of this blank node?", "what does this
 * restriction quantify over?").
 */
interface GraphIndex {
  triples: ProfileTriple[];
  /** subject → outgoing triples */
  out: Map<string, ProfileTriple[]>;
  /** subject → set of rdf:type IRIs (object, non-literal) */
  types: Map<string, Set<string>>;
  /** rdf:List head → array of member node ids (best-effort; literals kept as ids) */
  lists: Map<string, string[]>;
  /** all nodes that appear as a class restriction (rdf:type owl:Restriction) */
  restrictions: Set<string>;
  /** properties declared (or used) as owl:ObjectProperty */
  objectProperties: Set<string>;
  /** properties declared as owl:DatatypeProperty */
  datatypeProperties: Set<string>;
}

function buildIndex(triples: ProfileTriple[]): GraphIndex {
  const out = new Map<string, ProfileTriple[]>();
  const types = new Map<string, Set<string>>();
  const restrictions = new Set<string>();
  const objectProperties = new Set<string>();
  const datatypeProperties = new Set<string>();

  for (const t of triples) {
    let arr = out.get(t.subject);
    if (!arr) { arr = []; out.set(t.subject, arr); }
    arr.push(t);
    if (t.predicate === RDF_TYPE && !t.objectIsLiteral) {
      let set = types.get(t.subject);
      if (!set) { set = new Set(); types.set(t.subject, set); }
      set.add(t.object);
      if (t.object === OWL_RESTRICTION) restrictions.add(t.subject);
      if (t.object === OWL_OBJECT_PROPERTY) objectProperties.add(t.subject);
      if (t.object === OWL_DATATYPE_PROPERTY) datatypeProperties.add(t.subject);
    }
  }

  // Resolve rdf:List structures (best-effort, cycle-safe).
  const lists = new Map<string, string[]>();
  const isListHead = (node: string): boolean => {
    const arr = out.get(node);
    return !!arr && arr.some((t) => t.predicate === RDF_FIRST);
  };
  const collect = (head: string): string[] => {
    const items: string[] = [];
    const seen = new Set<string>();
    let cur: string | undefined = head;
    while (cur && cur !== RDF_NIL && !seen.has(cur)) {
      seen.add(cur);
      const arr = out.get(cur) ?? [];
      const first = arr.find((t) => t.predicate === RDF_FIRST);
      const rest = arr.find((t) => t.predicate === RDF_REST);
      if (first) items.push(first.object);
      cur = rest?.object;
    }
    return items;
  };
  for (const node of out.keys()) {
    if (isListHead(node)) lists.set(node, collect(node));
  }

  return { triples, out, types, lists, restrictions, objectProperties, datatypeProperties };
}

/** First outgoing object for a predicate, if any. */
function objOf(idx: GraphIndex, subject: string, predicate: string): ProfileTriple | undefined {
  return (idx.out.get(subject) ?? []).find((t) => t.predicate === predicate);
}

/** Members of an rdf:List headed by `node`, or [] if not a list. */
function listMembers(idx: GraphIndex, node: string): string[] {
  return idx.lists.get(node) ?? [];
}

/**
 * Detect the OWL 2 EL / QL / RL profiles structurally. Each rule is keyed to a
 * specific construct from the OWL 2 Profiles spec; see the inline notes for what
 * is and is not covered.
 */
export function detectOwl2Profiles(triples: ProfileTriple[]): Owl2ProfilesReport {
  const idx = buildIndex(triples);

  // DL = the existing pragmatic subset, re-expressed as construct violations so
  // it shares the SingleProfileReport shape.
  const dlBase = checkOwl2Profile(triples);
  const dl: SingleProfileReport = {
    valid: dlBase.owl2dl,
    violations: dlBase.violations.map((v) => ({
      construct: 'owl2dl-sanity',
      axiom: v.axiom,
      reason: v.reason,
    })),
  };

  const elV: ProfileConstructViolation[] = [];
  const qlV: ProfileConstructViolation[] = [];
  const rlV: ProfileConstructViolation[] = [];

  // ── Restriction-based rules (EL / QL / RL) ────────────────────────────────
  //
  // We scan every class restriction (rdf:type owl:Restriction) and classify the
  // quantifier it uses.
  //
  // EL allowed:  someValuesFrom, hasValue, hasSelf, intersectionOf, existential.
  // EL disallowed: allValuesFrom, cardinality (any), unionOf, complementOf,
  //                oneOf with >1 individual.
  // QL allowed (super-class position): someValuesFrom owl:Thing only, etc. — we
  //   approximate: QL disallows allValuesFrom, hasValue, hasSelf, any cardinality,
  //   unionOf, oneOf, complementOf (on the constraining side).
  // RL disallowed (super-class side): someValuesFrom (except RL super allows it
  //   only restricted), hasValue ok, max-cardinality 0/1 ok but min/exact not;
  //   we approximate the commonly-decisive ones: RL disallows unionOf on the
  //   super-class side and oneOf on the super-class side; existential on the
  //   super-class side is restricted.
  for (const r of idx.restrictions) {
    const onProp = objOf(idx, r, OWL_ON_PROPERTY);
    const propLabel = onProp ? localish(onProp.object) : '(unknown property)';

    if (objOf(idx, r, OWL_ALL_VALUES_FROM)) {
      elV.push({ construct: 'owl:allValuesFrom', axiom: `Restriction on ${propLabel}`, reason: 'EL forbids universal quantification (owl:allValuesFrom).' });
      qlV.push({ construct: 'owl:allValuesFrom', axiom: `Restriction on ${propLabel}`, reason: 'QL forbids universal quantification (owl:allValuesFrom).' });
    }

    const card =
      objOf(idx, r, OWL_MAX_CARDINALITY) ?? objOf(idx, r, OWL_MIN_CARDINALITY) ?? objOf(idx, r, OWL_CARDINALITY) ??
      objOf(idx, r, OWL_MAX_QUALIFIED_CARDINALITY) ?? objOf(idx, r, OWL_MIN_QUALIFIED_CARDINALITY) ?? objOf(idx, r, OWL_QUALIFIED_CARDINALITY);
    if (card) {
      const c = localish(card.predicate);
      elV.push({ construct: c, axiom: `Restriction on ${propLabel}`, reason: `EL forbids cardinality restrictions (${c}).` });
      qlV.push({ construct: c, axiom: `Restriction on ${propLabel}`, reason: `QL forbids cardinality restrictions (${c}).` });
      // RL allows max 0/1 cardinality but not min/exact/qualified-with-class.
      const isMax = card.predicate === OWL_MAX_CARDINALITY || card.predicate === OWL_MAX_QUALIFIED_CARDINALITY;
      const v = card.objectIsLiteral ? card.object : '';
      if (!isMax || (v !== '0' && v !== '1')) {
        rlV.push({ construct: c, axiom: `Restriction on ${propLabel}`, reason: `RL allows only owl:maxCardinality 0 or 1; (${c} = ${v || '?'}) is not allowed.` });
      }
    }

    const hasValue = objOf(idx, r, OWL_HAS_VALUE);
    if (hasValue) {
      // EL & RL allow hasValue; QL disallows it.
      qlV.push({ construct: 'owl:hasValue', axiom: `Restriction on ${propLabel}`, reason: 'QL forbids owl:hasValue restrictions.' });
    }

    const hasSelf = objOf(idx, r, OWL_HAS_SELF);
    if (hasSelf) {
      // EL allows local reflexivity (hasSelf); QL and RL do not.
      qlV.push({ construct: 'owl:hasSelf', axiom: `Restriction on ${propLabel}`, reason: 'QL forbids local reflexivity (owl:hasSelf).' });
      rlV.push({ construct: 'owl:hasSelf', axiom: `Restriction on ${propLabel}`, reason: 'RL forbids local reflexivity (owl:hasSelf).' });
    }
  }

  // ── Boolean class constructors (unionOf / complementOf / oneOf) ───────────
  //
  // We attribute these to the class node carrying them. EL forbids unionOf,
  // complementOf and oneOf-with->1-member. QL forbids unionOf, intersectionOf
  // (in arbitrary positions), complementOf, oneOf. RL forbids unionOf/oneOf on
  // the super-class side; here we flag them structurally (commonly-decisive).
  for (const t of idx.triples) {
    if (t.predicate === OWL_UNION_OF) {
      elV.push({ construct: 'owl:unionOf', axiom: renderTriple(t), reason: 'EL forbids disjunction (owl:unionOf).' });
      qlV.push({ construct: 'owl:unionOf', axiom: renderTriple(t), reason: 'QL forbids disjunction (owl:unionOf).' });
      rlV.push({ construct: 'owl:unionOf', axiom: renderTriple(t), reason: 'RL forbids disjunction (owl:unionOf) as a class expression.' });
    } else if (t.predicate === OWL_DISJOINT_UNION_OF) {
      elV.push({ construct: 'owl:disjointUnionOf', axiom: renderTriple(t), reason: 'EL forbids owl:disjointUnionOf (implies disjunction).' });
      qlV.push({ construct: 'owl:disjointUnionOf', axiom: renderTriple(t), reason: 'QL forbids owl:disjointUnionOf.' });
      rlV.push({ construct: 'owl:disjointUnionOf', axiom: renderTriple(t), reason: 'RL forbids owl:disjointUnionOf.' });
    } else if (t.predicate === OWL_COMPLEMENT_OF) {
      elV.push({ construct: 'owl:complementOf', axiom: renderTriple(t), reason: 'EL forbids negation (owl:complementOf).' });
      qlV.push({ construct: 'owl:complementOf', axiom: renderTriple(t), reason: 'QL forbids arbitrary negation (owl:complementOf).' });
    } else if (t.predicate === OWL_ONE_OF) {
      const members = listMembers(idx, t.object);
      // EL permits a singleton ObjectOneOf; >1 member is disallowed.
      if (members.length > 1) {
        elV.push({ construct: 'owl:oneOf', axiom: renderTriple(t), reason: 'EL allows only a single-individual owl:oneOf nominal; this has >1 member.' });
      }
      qlV.push({ construct: 'owl:oneOf', axiom: renderTriple(t), reason: 'QL forbids enumerations (owl:oneOf / nominals).' });
      rlV.push({ construct: 'owl:oneOf', axiom: renderTriple(t), reason: 'RL restricts owl:oneOf; enumerations are not allowed as a class expression here.' });
    }
  }

  // ── Property characteristics & axioms ─────────────────────────────────────
  //
  // QL forbids: transitive, functional, inverse-functional, (a)symmetric-as-such
  //   only partly — we flag the commonly-decisive ones: TransitiveProperty,
  //   FunctionalProperty, InverseFunctionalProperty, property chains, has-key.
  // EL forbids: inverse object properties (owl:inverseOf),
  //   InverseFunctionalProperty, IrreflexiveProperty, AsymmetricProperty,
  //   SymmetricProperty(*) — EL is unidirectional. (EL allows ReflexiveProperty,
  //   TransitiveProperty, FunctionalProperty? — EL does NOT allow functional
  //   data/obj props in general; we flag InverseFunctional only to stay
  //   conservative-but-useful.)
  // RL forbids: ReflexiveProperty (RL has no reflexive), and (positive) self.
  for (const t of idx.triples) {
    if (t.predicate === OWL_INVERSE_OF) {
      elV.push({ construct: 'owl:inverseOf', axiom: renderTriple(t), reason: 'EL forbids inverse object properties (owl:inverseOf).' });
    } else if (t.predicate === OWL_PROPERTY_CHAIN_AXIOM) {
      qlV.push({ construct: 'owl:propertyChainAxiom', axiom: renderTriple(t), reason: 'QL forbids property chains (owl:propertyChainAxiom).' });
    } else if (t.predicate === OWL_HAS_KEY) {
      elV.push({ construct: 'owl:hasKey', axiom: renderTriple(t), reason: 'EL forbids keys (owl:hasKey).' });
      qlV.push({ construct: 'owl:hasKey', axiom: renderTriple(t), reason: 'QL forbids keys (owl:hasKey).' });
    } else if (t.predicate === RDF_TYPE && !t.objectIsLiteral) {
      switch (t.object) {
        case OWL_TRANSITIVE_PROPERTY:
          qlV.push({ construct: 'owl:TransitiveProperty', axiom: renderTriple(t), reason: 'QL forbids transitive properties.' });
          break;
        case OWL_FUNCTIONAL_PROPERTY:
          qlV.push({ construct: 'owl:FunctionalProperty', axiom: renderTriple(t), reason: 'QL forbids functional properties.' });
          // OWL 2 EL forbids functional/inverse-functional OBJECT properties but
          // ALLOWS functional DATA properties (DataPropertyAxiom FunctionalDataProperty
          // is in the EL grammar; functional object properties are not). So flag
          // owl:FunctionalProperty for EL only when the property is NOT a declared
          // datatype property. A property declared owl:DatatypeProperty is exempt.
          // Conservative choice for the untyped case: a property that is marked
          // functional but carries no owl:ObjectProperty / owl:DatatypeProperty
          // declaration is ambiguous; we still flag it for EL (it could be the
          // disallowed functional object property), and document that here.
          if (!idx.datatypeProperties.has(t.subject)) {
            elV.push({ construct: 'owl:FunctionalProperty', axiom: renderTriple(t), reason: 'EL forbids functional object properties (functional data properties are allowed).' });
          }
          break;
        case OWL_INVERSE_FUNCTIONAL_PROPERTY:
          qlV.push({ construct: 'owl:InverseFunctionalProperty', axiom: renderTriple(t), reason: 'QL forbids inverse-functional properties.' });
          elV.push({ construct: 'owl:InverseFunctionalProperty', axiom: renderTriple(t), reason: 'EL forbids inverse-functional properties.' });
          break;
        case OWL_IRREFLEXIVE_PROPERTY:
          elV.push({ construct: 'owl:IrreflexiveProperty', axiom: renderTriple(t), reason: 'EL forbids irreflexive properties.' });
          break;
        case OWL_ASYMMETRIC_PROPERTY:
          elV.push({ construct: 'owl:AsymmetricProperty', axiom: renderTriple(t), reason: 'EL forbids asymmetric properties.' });
          qlV.push({ construct: 'owl:AsymmetricProperty', axiom: renderTriple(t), reason: 'QL allows asymmetric only under restrictions; flagged structurally.' });
          break;
        case OWL_REFLEXIVE_PROPERTY:
          rlV.push({ construct: 'owl:ReflexiveProperty', axiom: renderTriple(t), reason: 'RL forbids reflexive properties.' });
          break;
        case OWL_SYMMETRIC_PROPERTY:
          elV.push({ construct: 'owl:SymmetricProperty', axiom: renderTriple(t), reason: 'EL forbids symmetric properties (EL object properties are unidirectional).' });
          break;
        default:
          break;
      }
    }
  }

  // ── RL super-class-side existential ───────────────────────────────────────
  //
  // RL's superClassExpression grammar disallows ObjectSomeValuesFrom (existential)
  // except the owl:Thing-filler restricted form. We approximate that bound: a
  // restriction with someValuesFrom appearing in a super-class (rule-head)
  // position is an RL violation.
  //
  // Two ways a restriction reaches super-class position:
  //   1. As the OBJECT of rdfs:subClassOf  (C ⊑ ∃p.D — the OBJECT is the super).
  //   2. On EITHER side of owl:equivalentClass. Because C ≡ D expands to
  //      C ⊑ D AND D ⊑ C, an equivalentClass to an existential restriction puts
  //      that existential on a super-class side in one of the two expansions.
  //      Equivalence is symmetric, so a someValuesFrom restriction on EITHER the
  //      subject or the object side of owl:equivalentClass lands in super-class
  //      position and is therefore an RL violation.
  //
  // The plain subclass-SIDE (the SUBJECT of rdfs:subClassOf) is NOT checked here:
  // an existential as the sub-class (rule-body) is permitted by RL.
  const flagSuperExistential = (node: string, axiom: string): void => {
    if (idx.restrictions.has(node) && objOf(idx, node, OWL_SOME_VALUES_FROM)) {
      const onProp = objOf(idx, node, OWL_ON_PROPERTY);
      const propLabel = onProp ? localish(onProp.object) : '(unknown property)';
      rlV.push({
        construct: 'owl:someValuesFrom (super-class position)',
        axiom: axiom.replace('@prop', propLabel),
        reason: 'RL forbids existential quantification (owl:someValuesFrom) on the super-class (rule-head) side.',
      });
    }
  };
  for (const t of idx.triples) {
    if (t.objectIsLiteral) continue;
    if (t.predicate === RDFS_SUBCLASS_OF) {
      // Only the OBJECT (super-class) side of subClassOf is rule-head position.
      flagSuperExistential(t.object, `${t.subject} rdfs:subClassOf [ Restriction on @prop ]`);
    } else if (t.predicate === OWL_EQUIVALENT_CLASS) {
      // Symmetric: both sides of equivalentClass are super-class positions.
      flagSuperExistential(t.object, `${t.subject} owl:equivalentClass [ Restriction on @prop ]`);
      flagSuperExistential(t.subject, `${t.object} owl:equivalentClass [ Restriction on @prop ] (symmetric side)`);
    }
  }

  const el: SingleProfileReport = { valid: elV.length === 0, violations: elV };
  const ql: SingleProfileReport = { valid: qlV.length === 0, violations: qlV };
  const rl: SingleProfileReport = { valid: rlV.length === 0, violations: rlV };

  // mostRestrictive: EL/QL/RL are incomparable, but for a single useful label we
  // prefer EL < QL < RL < DL < Full. We report the FIRST profile (in that order)
  // the ontology fits; if it fits none of EL/QL/RL we fall back to DL when the DL
  // sanity check passes, else Full (i.e. outside the checked profiles).
  let mostRestrictive: ProfileName;
  if (el.valid) mostRestrictive = 'EL';
  else if (ql.valid) mostRestrictive = 'QL';
  else if (rl.valid) mostRestrictive = 'RL';
  else if (dl.valid) mostRestrictive = 'DL';
  else mostRestrictive = 'Full';

  return { dl, el, ql, rl, mostRestrictive };
}
