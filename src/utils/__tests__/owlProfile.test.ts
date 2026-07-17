// src/utils/__tests__/owlProfile.test.ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { checkOwl2Profile, detectOwl2Profiles, ProfileTriple } from '../owlProfile';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';

const RDF_TYPE = `${RDF}type`;
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const RDF_NIL = `${RDF}nil`;
const OWL_OBJECT_PROPERTY = `${OWL}ObjectProperty`;
const OWL_DATATYPE_PROPERTY = `${OWL}DatatypeProperty`;
const OWL_ANNOTATION_PROPERTY = `${OWL}AnnotationProperty`;
const RDFS_LABEL = `${RDFS}label`;
const RDFS_COMMENT = `${RDFS}comment`;
const RDFS_SUBCLASS_OF = `${RDFS}subClassOf`;
const OWL_RESTRICTION = `${OWL}Restriction`;
const OWL_ON_PROPERTY = `${OWL}onProperty`;
const OWL_SOME_VALUES_FROM = `${OWL}someValuesFrom`;
const OWL_ALL_VALUES_FROM = `${OWL}allValuesFrom`;
const OWL_INTERSECTION_OF = `${OWL}intersectionOf`;
const OWL_UNION_OF = `${OWL}unionOf`;
const OWL_ONE_OF = `${OWL}oneOf`;
const OWL_PROPERTY_CHAIN_AXIOM = `${OWL}propertyChainAxiom`;
const OWL_TRANSITIVE_PROPERTY = `${OWL}TransitiveProperty`;
const OWL_EQUIVALENT_CLASS = `${OWL}equivalentClass`;
const OWL_FUNCTIONAL_PROPERTY = `${OWL}FunctionalProperty`;

const EX = 'http://example.org/';

function triple(
  subject: string,
  predicate: string,
  object: string,
  objectIsLiteral = false,
): ProfileTriple {
  return { subject, predicate, object, objectIsLiteral };
}

describe('checkOwl2Profile', () => {
  it('(a) clean triple set → owl2dl:true, no violations', () => {
    const triples: ProfileTriple[] = [
      // declare knows as ObjectProperty
      triple(`${EX}knows`, RDF_TYPE, OWL_OBJECT_PROPERTY),
      // declare age as DatatypeProperty
      triple(`${EX}age`, RDF_TYPE, OWL_DATATYPE_PROPERTY),
      // correct use: object property → IRI object
      triple(`${EX}Alice`, `${EX}knows`, `${EX}Bob`),
      // correct use: datatype property → literal
      triple(`${EX}Alice`, `${EX}age`, '30', true),
    ];
    const report = checkOwl2Profile(triples);
    expect(report.owl2dl).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  it('(b) object property used with literal → owl2dl:false, violation names the property', () => {
    const triples: ProfileTriple[] = [
      triple(`${EX}knows`, RDF_TYPE, OWL_OBJECT_PROPERTY),
      triple(`${EX}Alice`, `${EX}knows`, '42', true),
    ];
    const report = checkOwl2Profile(triples);
    expect(report.owl2dl).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].reason).toMatch(/object property used with a literal/i);
    expect(report.violations[0].axiom).toContain(`${EX}knows`);
  });

  it('(c) datatype property used with IRI object → violation', () => {
    const triples: ProfileTriple[] = [
      triple(`${EX}age`, RDF_TYPE, OWL_DATATYPE_PROPERTY),
      triple(`${EX}Alice`, `${EX}age`, `${EX}Bob`, false),
    ];
    const report = checkOwl2Profile(triples);
    expect(report.owl2dl).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].reason).toMatch(/datatype property used with an IRI/i);
    expect(report.violations[0].axiom).toContain(`${EX}age`);
  });

  it('(d) property declared both ObjectProperty and DatatypeProperty → violation', () => {
    const triples: ProfileTriple[] = [
      triple(`${EX}mixed`, RDF_TYPE, OWL_OBJECT_PROPERTY),
      triple(`${EX}mixed`, RDF_TYPE, OWL_DATATYPE_PROPERTY),
    ];
    const report = checkOwl2Profile(triples);
    expect(report.owl2dl).toBe(false);
    const v = report.violations.find((x) =>
      /both object and datatype/i.test(x.reason),
    );
    expect(v).toBeDefined();
    expect(v!.axiom).toContain(`${EX}mixed`);
  });

  it('(e) literal in rdf:type object position → violation', () => {
    const triples: ProfileTriple[] = [
      triple(`${EX}Alice`, RDF_TYPE, 'Person', true),
    ];
    const report = checkOwl2Profile(triples);
    expect(report.owl2dl).toBe(false);
    expect(report.violations).toHaveLength(1);
    expect(report.violations[0].reason).toMatch(/class position occupied by a literal/i);
  });

  it('(f) literal on rdfs:label/rdfs:comment is NOT flagged', () => {
    const triples: ProfileTriple[] = [
      // object property declared correctly
      triple(`${EX}knows`, RDF_TYPE, OWL_OBJECT_PROPERTY),
      // annotation literals — must be ignored for check #1
      triple(`${EX}Alice`, RDFS_LABEL, 'Alice', true),
      triple(`${EX}Alice`, RDFS_COMMENT, 'A person named Alice.', true),
    ];
    const report = checkOwl2Profile(triples);
    expect(report.owl2dl).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  it('(g) literal on declared owl:AnnotationProperty is NOT flagged', () => {
    const triples: ProfileTriple[] = [
      triple(`${EX}notes`, RDF_TYPE, OWL_ANNOTATION_PROPERTY),
      triple(`${EX}Alice`, `${EX}notes`, 'some note', true),
    ];
    const report = checkOwl2Profile(triples);
    expect(report.owl2dl).toBe(true);
    expect(report.violations).toHaveLength(0);
  });
});

// ─────────────────────── detectOwl2Profiles (EL/QL/RL) ───────────────────────

/** Helper: an rdf:List of one IRI member, headed at `head`. */
function singletonList(head: string, member: string): ProfileTriple[] {
  return [
    triple(head, RDF_FIRST, member),
    triple(head, RDF_REST, RDF_NIL),
  ];
}

/** Helper: a two-member rdf:List headed at `head`. */
function pairList(head: string, mid: string, a: string, b: string): ProfileTriple[] {
  return [
    triple(head, RDF_FIRST, a),
    triple(head, RDF_REST, mid),
    triple(mid, RDF_FIRST, b),
    triple(mid, RDF_REST, RDF_NIL),
  ];
}

describe('detectOwl2Profiles', () => {
  it('EL ontology (subClassOf + someValuesFrom + intersectionOf) → el.valid true', () => {
    const triples: ProfileTriple[] = [
      // Parent ⊑ ∃hasPart.Thing  (existential — allowed in EL)
      triple(`${EX}Parent`, RDFS_SUBCLASS_OF, '_:r1'),
      triple('_:r1', RDF_TYPE, OWL_RESTRICTION),
      triple('_:r1', OWL_ON_PROPERTY, `${EX}hasChild`),
      triple('_:r1', OWL_SOME_VALUES_FROM, `${EX}Person`),
      // Human ≡ intersectionOf(...)  (conjunction — allowed in EL)
      triple(`${EX}Human`, OWL_INTERSECTION_OF, '_:l1'),
      ...pairList('_:l1', '_:l2', `${EX}Animal`, `${EX}Rational`),
    ];
    const r = detectOwl2Profiles(triples);
    expect(r.el.valid).toBe(true);
    expect(r.mostRestrictive).toBe('EL');
  });

  it('adding owl:allValuesFrom breaks EL (el.valid false with right violation)', () => {
    const triples: ProfileTriple[] = [
      triple(`${EX}Parent`, RDFS_SUBCLASS_OF, '_:r1'),
      triple('_:r1', RDF_TYPE, OWL_RESTRICTION),
      triple('_:r1', OWL_ON_PROPERTY, `${EX}hasChild`),
      triple('_:r1', OWL_ALL_VALUES_FROM, `${EX}Person`),
    ];
    const r = detectOwl2Profiles(triples);
    expect(r.el.valid).toBe(false);
    expect(r.el.violations.some((v) => v.construct === 'owl:allValuesFrom')).toBe(true);
    // allValuesFrom also breaks QL.
    expect(r.ql.valid).toBe(false);
  });

  it('owl:unionOf breaks EL, QL and RL (disjunction)', () => {
    const triples: ProfileTriple[] = [
      triple(`${EX}Animal`, OWL_UNION_OF, '_:l1'),
      ...pairList('_:l1', '_:l2', `${EX}Cat`, `${EX}Dog`),
    ];
    const r = detectOwl2Profiles(triples);
    expect(r.el.valid).toBe(false);
    expect(r.ql.valid).toBe(false);
    expect(r.rl.valid).toBe(false);
    expect(r.el.violations.some((v) => v.construct === 'owl:unionOf')).toBe(true);
  });

  it('someValuesFrom on the super-class side breaks RL', () => {
    const triples: ProfileTriple[] = [
      // C ⊑ ∃p.D   — existential in rule-head position → RL violation
      triple(`${EX}C`, RDFS_SUBCLASS_OF, '_:r1'),
      triple('_:r1', RDF_TYPE, OWL_RESTRICTION),
      triple('_:r1', OWL_ON_PROPERTY, `${EX}p`),
      triple('_:r1', OWL_SOME_VALUES_FROM, `${EX}D`),
    ];
    const r = detectOwl2Profiles(triples);
    expect(r.rl.valid).toBe(false);
    expect(
      r.rl.violations.some((v) => v.construct.startsWith('owl:someValuesFrom')),
    ).toBe(true);
    // This same ontology is fine for EL (existential allowed).
    expect(r.el.valid).toBe(true);
  });

  it('property chain breaks QL (allowed in EL and RL)', () => {
    const triples: ProfileTriple[] = [
      triple(`${EX}hasGrandparent`, OWL_PROPERTY_CHAIN_AXIOM, '_:l1'),
      ...pairList('_:l1', '_:l2', `${EX}hasParent`, `${EX}hasParent`),
    ];
    const r = detectOwl2Profiles(triples);
    expect(r.ql.valid).toBe(false);
    expect(r.ql.violations.some((v) => v.construct === 'owl:propertyChainAxiom')).toBe(true);
    expect(r.el.valid).toBe(true);
    expect(r.rl.valid).toBe(true);
  });

  it('transitive property breaks QL (allowed in EL)', () => {
    const triples: ProfileTriple[] = [
      triple(`${EX}partOf`, RDF_TYPE, OWL_TRANSITIVE_PROPERTY),
    ];
    const r = detectOwl2Profiles(triples);
    expect(r.ql.valid).toBe(false);
    expect(r.ql.violations.some((v) => v.construct === 'owl:TransitiveProperty')).toBe(true);
    expect(r.el.valid).toBe(true);
  });

  it('singleton owl:oneOf is allowed in EL; multi-member is not', () => {
    const ok: ProfileTriple[] = [
      triple(`${EX}JustAlice`, OWL_ONE_OF, '_:l1'),
      ...singletonList('_:l1', `${EX}Alice`),
    ];
    expect(detectOwl2Profiles(ok).el.valid).toBe(true);

    const bad: ProfileTriple[] = [
      triple(`${EX}AliceOrBob`, OWL_ONE_OF, '_:l1'),
      ...pairList('_:l1', '_:l2', `${EX}Alice`, `${EX}Bob`),
    ];
    const r = detectOwl2Profiles(bad);
    expect(r.el.valid).toBe(false);
    expect(r.el.violations.some((v) => v.construct === 'owl:oneOf')).toBe(true);
  });

  it('mostRestrictive prefers the tightest fitting profile', () => {
    // QL-but-not-EL: allValuesFrom breaks EL; but here we use a transitive
    // property which breaks QL, plus an inverse which breaks EL — choose a case
    // that fits QL only. Inverse object property breaks EL but not QL/RL.
    const inverseOnly: ProfileTriple[] = [
      triple(`${EX}hasParent`, `${OWL}inverseOf`, `${EX}hasChild`),
    ];
    const r1 = detectOwl2Profiles(inverseOnly);
    expect(r1.el.valid).toBe(false); // EL forbids inverses
    expect(r1.ql.valid).toBe(true);  // QL allows inverses
    expect(r1.mostRestrictive).toBe('QL');

    // RL-only: a max-cardinality 1 restriction (RL allows max 0/1, EL/QL forbid
    // cardinality entirely).
    const rlOnly: ProfileTriple[] = [
      triple(`${EX}C`, RDFS_SUBCLASS_OF, '_:r1'),
      triple('_:r1', RDF_TYPE, OWL_RESTRICTION),
      triple('_:r1', OWL_ON_PROPERTY, `${EX}p`),
      triple('_:r1', `${OWL}maxCardinality`, '1', true),
    ];
    const r2 = detectOwl2Profiles(rlOnly);
    expect(r2.el.valid).toBe(false);
    expect(r2.ql.valid).toBe(false);
    expect(r2.rl.valid).toBe(true);
    expect(r2.mostRestrictive).toBe('RL');
  });

  it('empty ontology fits EL (mostRestrictive EL)', () => {
    const r = detectOwl2Profiles([]);
    expect(r.el.valid).toBe(true);
    expect(r.ql.valid).toBe(true);
    expect(r.rl.valid).toBe(true);
    expect(r.mostRestrictive).toBe('EL');
  });

  // ── M1: RL super-class existential via owl:equivalentClass ─────────────────
  it('(M1) owl:equivalentClass to a someValuesFrom restriction breaks RL (object side)', () => {
    // A ≡ ∃p.D — equivalentClass expands to subClassOf both directions, so the
    // existential restriction lands in a super-class (rule-head) position → RL
    // forbids it.
    const triples: ProfileTriple[] = [
      triple(`${EX}A`, OWL_EQUIVALENT_CLASS, '_:r1'),
      triple('_:r1', RDF_TYPE, OWL_RESTRICTION),
      triple('_:r1', OWL_ON_PROPERTY, `${EX}p`),
      triple('_:r1', OWL_SOME_VALUES_FROM, `${EX}D`),
    ];
    const r = detectOwl2Profiles(triples);
    expect(r.rl.valid).toBe(false);
    expect(
      r.rl.violations.some((v) => v.construct.startsWith('owl:someValuesFrom')),
    ).toBe(true);
    // Existential is allowed in EL → EL still valid.
    expect(r.el.valid).toBe(true);
  });

  it('(M1) owl:equivalentClass breaks RL when the restriction is on the SUBJECT side (symmetric)', () => {
    // [∃p.D] ≡ A — restriction is the SUBJECT of equivalentClass; symmetry still
    // places it in super-class position for RL.
    const triples: ProfileTriple[] = [
      triple('_:r1', OWL_EQUIVALENT_CLASS, `${EX}A`),
      triple('_:r1', RDF_TYPE, OWL_RESTRICTION),
      triple('_:r1', OWL_ON_PROPERTY, `${EX}p`),
      triple('_:r1', OWL_SOME_VALUES_FROM, `${EX}D`),
    ];
    const r = detectOwl2Profiles(triples);
    expect(r.rl.valid).toBe(false);
    expect(
      r.rl.violations.some((v) => v.construct.startsWith('owl:someValuesFrom')),
    ).toBe(true);
    expect(r.el.valid).toBe(true);
  });

  it('(M1) a plain rdfs:subClassOf [someValuesFrom] (sub-class side) is still RL-valid', () => {
    // ∃p.D ⊑ A — existential as the SUB-class (rule-body) is permitted by RL.
    const triples: ProfileTriple[] = [
      triple('_:r1', RDFS_SUBCLASS_OF, `${EX}A`),
      triple('_:r1', RDF_TYPE, OWL_RESTRICTION),
      triple('_:r1', OWL_ON_PROPERTY, `${EX}p`),
      triple('_:r1', OWL_SOME_VALUES_FROM, `${EX}D`),
    ];
    const r = detectOwl2Profiles(triples);
    expect(r.rl.valid).toBe(true);
  });

  // ── M2: EL functional data vs object property ──────────────────────────────
  it('(M2) functional DATATYPE property is NOT an EL violation', () => {
    // EL allows functional data properties.
    const triples: ProfileTriple[] = [
      triple(`${EX}age`, RDF_TYPE, OWL_DATATYPE_PROPERTY),
      triple(`${EX}age`, RDF_TYPE, OWL_FUNCTIONAL_PROPERTY),
    ];
    const r = detectOwl2Profiles(triples);
    expect(
      r.el.violations.some((v) => v.construct === 'owl:FunctionalProperty'),
    ).toBe(false);
    expect(r.el.valid).toBe(true);
  });

  it('(M2) functional OBJECT property IS still an EL violation', () => {
    // EL forbids functional object properties.
    const triples: ProfileTriple[] = [
      triple(`${EX}hasFather`, RDF_TYPE, OWL_OBJECT_PROPERTY),
      triple(`${EX}hasFather`, RDF_TYPE, OWL_FUNCTIONAL_PROPERTY),
    ];
    const r = detectOwl2Profiles(triples);
    expect(r.el.valid).toBe(false);
    expect(
      r.el.violations.some((v) => v.construct === 'owl:FunctionalProperty'),
    ).toBe(true);
  });

  it('(M2) untyped functional property is conservatively still flagged for EL', () => {
    // No object/datatype declaration: ambiguous → conservatively flagged for EL.
    const triples: ProfileTriple[] = [
      triple(`${EX}mystery`, RDF_TYPE, OWL_FUNCTIONAL_PROPERTY),
    ];
    const r = detectOwl2Profiles(triples);
    expect(r.el.valid).toBe(false);
    expect(
      r.el.violations.some((v) => v.construct === 'owl:FunctionalProperty'),
    ).toBe(true);
  });

  it('still surfaces the DL sanity check inside the dl field', () => {
    const triples: ProfileTriple[] = [
      triple(`${EX}knows`, RDF_TYPE, OWL_OBJECT_PROPERTY),
      triple(`${EX}Alice`, `${EX}knows`, '42', true),
    ];
    const r = detectOwl2Profiles(triples);
    expect(r.dl.valid).toBe(false);
    expect(r.dl.violations.length).toBeGreaterThan(0);
  });
});
