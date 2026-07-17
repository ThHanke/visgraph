// src/mcp/tools/computeRepairs.ts
//
// TODO(rdf-reasoner-konclude): repair computation (MIPS hitting-set, minimality)
// should move to the reasoner API once repair endpoints land (plan-050 deferred).
//
// R1 — Reasoner-computed repair suggestions.
//
// Pure, deterministic translation of symbolic diagnostics (inconsistency
// justifications a.k.a. MIPS, unsatisfiable classes, SHACL violations) into a
// ranked list of *executable* repair candidates. This moves repair SELECTION
// from the LLM onto the symbolic side: instead of handing the agent a prose
// brief and asking it to translate justifications into tool calls, we compute
// the minimal axiom set whose removal restores consistency and emit ready-to-run
// `removeLink` / `addTriple` actions. Every emitted `action.tool` is a tool that
// is actually registered in ontosphereMcpServer.ts (guarded by a unit test).
//
// This module is intentionally free of any reasoner / worker dependency so it
// can be unit-tested exhaustively without WASM. The optional *symbolic
// verification* of each candidate (re-running the Konclude consistency oracle on
// a store copy with the axioms removed) is layered on top in reasoning.ts.

import type { DiagnosticsData } from './diagnosticsBrief';
import {
  enumerateWeakenings,
  type ClassHierarchy,
  type CulpritAxiom,
  type WeakeningTriple,
} from './axiomWeakening';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RepairIssue = 'inconsistency' | 'shacl';

/**
 * How a repair changes the ontology:
 *  - 'delete'  — remove the culprit axiom outright (maximally destructive; the
 *                original, default behaviour).
 *  - 'weaken'  — replace the culprit `A ⊑ D` with a logically weaker axiom
 *                `A ⊑ D′` (D′ ⊒ D) or drop a conjunct — preserves more knowledge
 *                (Troquard et al. AAAI 2018; Li & Lambrix ISWC 2024).
 *
 * Repairs without an explicit kind are 'delete' (back-compat: existing tests and
 * callers that don't set it treat every repair as a deletion).
 */
export type RepairKind = 'delete' | 'weaken';

/**
 * A remove+add batch for a WEAKENING repair: remove the original culprit
 * axiom triple(s) AND add the weaker replacement triple(s). Adds may be empty
 * when the weakening degenerates to a deletion (A ⊑ owl:Thing, or dropping the
 * last conjunct). Mirrors rdfManager.applyBatch's { removes, adds } shape.
 */
export interface RepairBatch {
  removes: WeakeningTriple[];
  adds: WeakeningTriple[];
}

export interface RepairAction {
  /**
   * MCP tool the agent should call to apply this repair. Inconsistency repairs
   * always use `removeLink` — its handler removes ANY matching triple (it calls
   * rdfManager.removeTriple under the hood), so it works for IRI-object edges,
   * literal-object annotations, AND TBox schema axioms (disjointWith/subClassOf).
   * Only tools that are actually registered (see ontosphereMcpServer.ts) are emitted.
   */
  tool: 'removeLink' | 'addTriple' | 'updateNode';
  args: {
    subjectIri?: string;
    predicateIri?: string;
    /**
     * The triple object. For IRI-object axioms this is the object IRI. For
     * literal-object axioms (e.g. an annotation with a string/number literal)
     * this carries the literal's lexical value — `removeLink`'s handler coerces
     * a non-IRI object string to a Literal term and removes the matching triple,
     * so the same field works for both cases.
     */
    objectIri?: string;
    /**
     * For SHACL `addTriple`/`updateNode` candidates whose object value cannot be
     * inferred symbolically, this is left undefined and `needsValue` is set so
     * the agent knows it must supply a value.
     */
    objectValue?: string;
    /**
     * C1: the named graph the axiom physically resides in (e.g. 'urn:vg:data' or
     * 'urn:vg:ontologies' for an imported schema axiom). The apply path MUST
     * remove/add in THIS graph — hardcoding urn:vg:data silently no-ops when the
     * axiom lives in an imported ontology. Undefined ⇒ default data graph.
     */
    graph?: string;
    /**
     * H2: the object term's RDF kind ('NamedNode' | 'Literal' | 'BlankNode').
     * When 'Literal', `objectDatatype`/`objectLanguage` carry the exact type so
     * the apply path reconstructs the precise typed/lang literal instead of a
     * lossy lexical-only match that could remove a same-lexical sibling.
     */
    objectTermType?: string;
    /** H2: datatype IRI of a literal object (e.g. xsd:integer). */
    objectDatatype?: string;
    /** H2: language tag of a literal object (e.g. 'en'). */
    objectLanguage?: string;
  };
}

export interface RepairSuggestion {
  /** Stable, human-referenceable id, e.g. "R1", "R2", "S1", "W1". */
  id: string;
  issue: RepairIssue;
  action: RepairAction;
  /**
   * Repair kind. Absent ⇒ 'delete' (back-compat). 'weaken' repairs carry a
   * `batch` (remove original + add weaker) and a `weakerThan` description.
   */
  kind?: RepairKind;
  /**
   * For kind:'weaken' — the remove+add batch to apply (the deletion `action`
   * above still removes the culprit, so an apply path that only understands
   * `action` degrades gracefully to a deletion; a weakening-aware path applies
   * the full batch to also ADD the weaker axiom).
   */
  batch?: RepairBatch;
  /**
   * For kind:'weaken' — "A ⊑ D" (the original, stronger axiom) so the UI/agent
   * can show "A ⊑ D → A ⊑ D′".
   */
  weakerThan?: string;
  /**
   * For kind:'weaken' — the id of the deletion repair this weakening is an
   * alternative to (same culprit axiom). Lets the UI group "delete vs weaken".
   */
  alternativeTo?: string;
  /**
   * For kind:'weaken' — set by the caller after symbolic verification: true when
   * removing the original culprit axiom restores consistency. Because the added
   * weaker axiom `A ⊑ D′` is ENTAILED by the removed `A ⊑ D` (D ⊑ D′), the
   * removal verdict transfers to the weakening (re-adding an entailment of a
   * removed axiom cannot re-break a satisfied model). Undefined when not verified.
   */
  weakeningVerified?: boolean;
  /** For kind:'weaken' — human-readable verification note (honest about the add-side). */
  weakeningNote?: string;
  /** Plain-language explanation of why this repair was chosen. */
  rationale: string;
  /**
   * Indices (into `diagnostics.justifications`) of the inconsistency
   * justifications this repair resolves. Present for inconsistency repairs.
   */
  justificationsCovered?: number[];
  /**
   * Set by the caller after symbolic verification: true when re-running the
   * Konclude consistency oracle on a store copy WITHOUT this repair's *single*
   * axiom yields a consistent ontology. NOTE: with multiple disjoint
   * contradictions no single removal restores GLOBAL consistency, so this is
   * commonly `false` even for a correct repair — it means "does not ALONE
   * restore consistency; apply the full repair set" rather than "wrong repair".
   * Cross-reference `verifiedSet`. Undefined when not (yet) verified.
   */
  verifiedConsistent?: boolean;
  /**
   * Set by the caller after symbolic verification of the FULL hitting set
   * (all inconsistency repairs removed together): true when removing every
   * inconsistency repair's axiom at once restores global consistency. This is
   * the paper-critical signal — the union of repairs IS the valid fix even when
   * each individual `verifiedConsistent` is false. Same value on every
   * inconsistency repair. Undefined when not (yet) verified.
   */
  verifiedSet?: boolean;
  /**
   * Set by `verifyDeletionSetMinimality` after a BOUNDED subset-minimality
   * search: true when the deletion repair set was *verified* to be a genuinely
   * minimal sub-collection whose removal restores consistency (no proper subset
   * of it does) — i.e. the reported set is not merely irredundant-by-heuristic
   * but reasoner-verified minimal WITHIN the configured bound. false when the
   * hitting set was above the bound and the search was skipped (the set falls
   * back to the irredundant heuristic and minimality is NOT proven). Same value
   * on every deletion repair in the verified set. Undefined when no reasoner
   * check was supplied (pure path — behaviour unchanged). Cross-reference
   * `minimalDeletionSet` on the returned summary for the actual minimal set.
   */
  minimalityVerified?: boolean;
  /**
   * True when the action cannot be fully specified because a value must be
   * chosen by the agent (SHACL candidates with an unknown object).
   */
  needsValue?: boolean;
  /**
   * True for a marker suggestion that has NO executable action because the
   * reasoner reported a contradiction with no covering axiom (a degenerate /
   * empty MIPS). The agent must inspect the ontology manually. `action` is set
   * to a no-op shape and there is no `justificationsCovered`.
   */
  needsManualReview?: boolean;
}

// ---------------------------------------------------------------------------
// Axiom helpers
// ---------------------------------------------------------------------------

type Axiom = {
  subject: string;
  predicate: string;
  object: string;
  // C1 + H2: optional provenance/term metadata threaded from the MIPS so the
  // repair action can target the correct graph and reconstruct the exact object
  // term. Absent on synthetic/test axioms that only specify s/p/o.
  objectTermType?: string;
  objectDatatype?: string;
  objectLanguage?: string;
  graph?: string;
};

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL = 'http://www.w3.org/2002/07/owl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

/** Predicates that express TBox / structural schema axioms (least preferred to remove). */
const TBOX_PREDICATES = new Set<string>([
  `${OWL}disjointWith`,
  `${OWL}equivalentClass`,
  `${OWL}equivalentProperty`,
  `${OWL}complementOf`,
  `${OWL}unionOf`,
  `${OWL}intersectionOf`,
  `${OWL}oneOf`,
  `${OWL}onProperty`,
  `${OWL}someValuesFrom`,
  `${OWL}allValuesFrom`,
  `${OWL}hasValue`,
  `${OWL}cardinality`,
  `${OWL}minCardinality`,
  `${OWL}maxCardinality`,
  `${OWL}qualifiedCardinality`,
  `${OWL}minQualifiedCardinality`,
  `${OWL}maxQualifiedCardinality`,
  `${OWL}propertyDisjointWith`,
  `${OWL}disjointUnionOf`,
  `${OWL}inverseOf`,
  `${RDFS}subClassOf`,
  `${RDFS}subPropertyOf`,
  `${RDFS}domain`,
  `${RDFS}range`,
]);

/** Object values that, as rdf:type objects, denote a TBox structural assertion. */
const TBOX_TYPE_OBJECTS = new Set<string>([
  `${OWL}FunctionalProperty`,
  `${OWL}InverseFunctionalProperty`,
  `${OWL}TransitiveProperty`,
  `${OWL}SymmetricProperty`,
  `${OWL}AsymmetricProperty`,
  `${OWL}ReflexiveProperty`,
  `${OWL}IrreflexiveProperty`,
]);

/** local name after the last '#' or '/', or the full string. */
function localName(iri: string): string {
  if (!iri) return iri;
  const hash = iri.lastIndexOf('#');
  if (hash !== -1 && hash < iri.length - 1) return iri.slice(hash + 1);
  const slash = iri.lastIndexOf('/');
  if (slash !== -1 && slash < iri.length - 1) return iri.slice(slash + 1);
  return iri;
}

function axiomKey(a: Axiom): string {
  // Include graph + object term metadata so two axioms that share the same
  // s/p/o lexical form but differ in source graph (C1) or in literal
  // datatype/language (H2) are NOT merged into one hitting-set entry — they are
  // genuinely distinct RDF terms and may need distinct repairs.
  return [
    a.subject,
    a.predicate,
    a.object,
    a.objectTermType ?? '',
    a.objectDatatype ?? '',
    a.objectLanguage ?? '',
    a.graph ?? '',
  ].join(' ');
}

/**
 * Is this axiom a TBox / structural schema axiom? Such axioms are MORE
 * destructive to remove (they change the meaning of the ontology) so the
 * ranking prefers removing ABox / object-property assertions instead.
 */
function isTBoxAxiom(a: Axiom): boolean {
  if (TBOX_PREDICATES.has(a.predicate)) return true;
  if (a.predicate === RDF_TYPE && TBOX_TYPE_OBJECTS.has(a.object)) return true;
  return false;
}

/**
 * An rdf:type assertion to an OWL meta-class (owl:Class, owl:ObjectProperty,
 * owl:NamedIndividual, …) is a *declaration*. Removing a declaration is
 * pointless as a repair (it does not relieve the logical clash) so we treat it
 * as maximally destructive when ranking, keeping it out of hitting sets unless
 * nothing else covers a justification.
 */
function isDeclaration(a: Axiom): boolean {
  return (
    a.predicate === RDF_TYPE &&
    a.object.startsWith(OWL) &&
    /(Class|ObjectProperty|DatatypeProperty|AnnotationProperty|NamedIndividual|Ontology)$/.test(
      a.object,
    )
  );
}

/**
 * Does this axiom's object look like an absolute IRI (vs. a literal value)?
 * Used only for rationale wording — the emitted tool is always `removeLink`,
 * whose handler removes IRI-object AND literal-object triples alike.
 */
function hasIriObject(a: Axiom): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(a.object);
}

// ---------------------------------------------------------------------------
// Minimal hitting set over the justifications (MIPS)
// ---------------------------------------------------------------------------

/**
 * A hitting set over a family of sets is a set that intersects every member.
 * For inconsistency repair, every justification (MIPS) must lose at least one
 * axiom for consistency to be restored; the minimal hitting set is the smallest
 * such axiom collection.
 *
 * Minimum hitting set is NP-hard, so we use a deterministic greedy heuristic
 * (repeatedly take the axiom covering the most still-uncovered justifications)
 * followed by a minimality post-reduction pass (drop any chosen axiom that is
 * redundant because the rest already hit every justification). This yields a
 * *minimal* (irredundant) hitting set — not necessarily of globally minimum
 * cardinality, but small and verifiable, which is what the agent needs.
 *
 * Ties in coverage are broken to favour the LEAST-DESTRUCTIVE removal:
 *   1. higher coverage (more justifications hit) wins;
 *   2. then prefer ABox / object-property assertions over TBox structural axioms;
 *   3. then prefer axioms that touch an unsatisfiable class;
 *   4. then a stable lexicographic axiom-key order (full determinism).
 */
function computeMinimalHittingSet(
  justifications: Axiom[][],
  unsatClasses: Set<string>,
): { hittingSet: { axiom: Axiom; covered: number[] }[]; uncovered: number[] } {
  // Deduplicate axioms, recording which justifications each appears in.
  const axiomToJustifs = new Map<string, { axiom: Axiom; justifs: Set<number> }>();
  justifications.forEach((mips, jIdx) => {
    for (const ax of mips) {
      const key = axiomKey(ax);
      let entry = axiomToJustifs.get(key);
      if (!entry) {
        entry = { axiom: ax, justifs: new Set<number>() };
        axiomToJustifs.set(key, entry);
      }
      entry.justifs.add(jIdx);
    }
  });

  const touchesUnsat = (a: Axiom): boolean =>
    unsatClasses.has(a.subject) || unsatClasses.has(a.object);

  // Destructiveness rank: lower is better (less destructive → preferred).
  const destructiveness = (a: Axiom): number => {
    if (isDeclaration(a)) return 2; // never really a useful repair
    if (isTBoxAxiom(a)) return 1; // structural change
    return 0; // ABox / object-property assertion
  };

  const uncovered = new Set<number>(justifications.map((_, i) => i));
  const chosen: { axiom: Axiom; covered: number[] }[] = [];
  const chosenKeys = new Set<string>();

  while (uncovered.size > 0) {
    let best: { key: string; axiom: Axiom; newCover: number[] } | null = null;
    for (const [key, { axiom, justifs }] of axiomToJustifs) {
      if (chosenKeys.has(key)) continue;
      const newCover: number[] = [];
      for (const j of justifs) if (uncovered.has(j)) newCover.push(j);
      if (newCover.length === 0) continue;

      if (best === null) {
        best = { key, axiom, newCover };
        continue;
      }
      // Compare against current best with the documented tie-break order.
      const cmp = compareCandidates(
        { axiom: best.axiom, cover: best.newCover.length },
        { axiom, cover: newCover.length },
        destructiveness,
        touchesUnsat,
      );
      // cmp > 0 means the new candidate is better.
      if (cmp > 0) best = { key, axiom, newCover };
    }
    if (!best) break; // no axiom can cover remaining justifications (shouldn't happen)
    chosen.push({ axiom: best.axiom, covered: [...best.newCover].sort((a, b) => a - b) });
    chosenKeys.add(best.key);
    for (const j of best.newCover) uncovered.delete(j);
  }

  // Minimality post-reduction: drop any chosen axiom whose justifications are
  // already covered by the others. Iterate from the last-added (greedy picks
  // earliest-added axioms cover the most, so later ones are likelier redundant).
  const coversAll = (set: { covered: number[] }[]): boolean => {
    const hit = new Set<number>();
    for (const c of set) for (const j of c.covered) hit.add(j);
    return justifications.every((_, i) => hit.has(i));
  };
  for (let i = chosen.length - 1; i >= 0; i--) {
    const without = chosen.filter((_, idx) => idx !== i);
    if (coversAll(without)) {
      chosen.splice(i, 1);
    }
  }

  // Recompute the FULL coverage of each surviving axiom (it may hit more
  // justifications than the incremental `newCover` recorded during greedy
  // selection), so `justificationsCovered` reflects every MIPS it resolves.
  const hittingSet = chosen.map(({ axiom }) => {
    const justifs = axiomToJustifs.get(axiomKey(axiom))!.justifs;
    return { axiom, covered: [...justifs].sort((a, b) => a - b) };
  });

  // `uncovered` retains any justification index no axiom could hit — i.e. a
  // degenerate / empty MIPS (an inner `[]`). These have no covering axiom, so
  // the caller emits a `needsManualReview` marker instead of leaving the agent
  // with a contradiction and zero guidance (M4).
  return { hittingSet, uncovered: [...uncovered].sort((a, b) => a - b) };
}

/**
 * Returns > 0 if `b` should be preferred over `a`, < 0 if `a` is preferred,
 * 0 if equal under all criteria. Implements the documented ranking order.
 */
function compareCandidates(
  a: { axiom: Axiom; cover: number },
  b: { axiom: Axiom; cover: number },
  destructiveness: (x: Axiom) => number,
  touchesUnsat: (x: Axiom) => boolean,
): number {
  // 1. higher coverage wins
  if (b.cover !== a.cover) return b.cover - a.cover;
  // 2. lower destructiveness wins (prefer ABox over TBox)
  const da = destructiveness(a.axiom);
  const db = destructiveness(b.axiom);
  if (da !== db) return da - db;
  // 3. prefer touching an unsatisfiable class
  const ua = touchesUnsat(a.axiom) ? 0 : 1;
  const ub = touchesUnsat(b.axiom) ? 0 : 1;
  if (ua !== ub) return ua - ub;
  // 4. stable lexicographic order
  const ka = axiomKey(a.axiom);
  const kb = axiomKey(b.axiom);
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Repair builders
// ---------------------------------------------------------------------------

function buildInconsistencyRepairs(
  justifications: Axiom[][],
  unsatClasses: Set<string>,
): RepairSuggestion[] {
  if (justifications.length === 0) return [];
  const { hittingSet, uncovered } = computeMinimalHittingSet(justifications, unsatClasses);

  // Final presentation ordering: rank repairs by impact — most justifications
  // covered first, then least-destructive, then unsat-touching, then stable key.
  const destructiveness = (a: Axiom): number =>
    isDeclaration(a) ? 2 : isTBoxAxiom(a) ? 1 : 0;
  const touchesUnsat = (a: Axiom): boolean =>
    unsatClasses.has(a.subject) || unsatClasses.has(a.object);

  hittingSet.sort((x, y) =>
    compareCandidates(
      { axiom: x.axiom, cover: x.covered.length },
      { axiom: y.axiom, cover: y.covered.length },
      destructiveness,
      touchesUnsat,
    ),
  );

  const out: RepairSuggestion[] = hittingSet.map(({ axiom, covered }, i) => {
    // H1: ALWAYS removeLink. Its handler removes any matching triple (IRI- AND
    // literal-object) and any TBox axiom — and it is a registered MCP tool,
    // unlike the previously-emitted `removeTriple` which had no handler.
    const tool: RepairAction['tool'] = 'removeLink';
    const structural = isTBoxAxiom(axiom);
    const coversText =
      covered.length > 1
        ? `resolves ${covered.length} of the ${justifications.length} contradictions`
        : `resolves contradiction ${covered[0] + 1}`;
    const kind = structural
      ? 'a TBox/structural axiom (more invasive — verify intent before applying)'
      : hasIriObject(axiom)
        ? 'an ABox/assertion (least-destructive choice)'
        : 'an annotation/literal assertion (least-destructive choice)';
    const rationale =
      `Remove ${localName(axiom.subject)} ${localName(axiom.predicate)} ` +
      `${localName(axiom.object)} — ${kind}; this ${coversText}.`;
    return {
      id: `R${i + 1}`,
      issue: 'inconsistency' as const,
      action: {
        tool,
        args: {
          subjectIri: axiom.subject,
          predicateIri: axiom.predicate,
          objectIri: axiom.object,
          // C1 + H2: carry the source graph and object term metadata so the
          // apply path removes from the correct graph and reconstructs the exact
          // typed/lang literal. Only set when present (back-compat).
          ...(axiom.graph ? { graph: axiom.graph } : {}),
          ...(axiom.objectTermType ? { objectTermType: axiom.objectTermType } : {}),
          ...(axiom.objectDatatype ? { objectDatatype: axiom.objectDatatype } : {}),
          ...(axiom.objectLanguage ? { objectLanguage: axiom.objectLanguage } : {}),
        },
      },
      rationale,
      justificationsCovered: covered,
    };
  });

  // M4: any justification with no covering axiom (a degenerate / empty MIPS)
  // gets a non-executable `needsManualReview` marker so the agent is told the
  // contradiction exists and why it cannot be auto-repaired, instead of being
  // handed a contradiction with zero guidance.
  for (const jIdx of uncovered) {
    out.push({
      id: `R${out.length + 1}`,
      issue: 'inconsistency' as const,
      action: { tool: 'removeLink', args: {} },
      rationale:
        `Contradiction ${jIdx + 1} has no covering axiom in its justification ` +
        `(the reasoner returned an empty/degenerate MIPS). No automatic repair ` +
        `can be computed — inspect the ontology manually (e.g. an implicit ` +
        `entailment or a class definition rather than a single removable axiom).`,
      justificationsCovered: [jIdx],
      needsManualReview: true,
    });
  }

  return out;
}

function buildShaclRepairs(
  violations: DiagnosticsData['shaclViolations'],
): RepairSuggestion[] {
  const out: RepairSuggestion[] = [];
  let n = 0;
  for (const v of violations) {
    if (!v.focusNode || !v.path) continue; // can't form an actionable triple
    n += 1;
    const constraintName = v.constraint ? localName(v.constraint) : 'shape constraint';
    // We cannot symbolically infer the value the shape expects, so the agent
    // must supply it. We use addTriple with needsValue:true.
    const rationale =
      `SHACL ${v.severity ?? 'violation'} on ${localName(v.focusNode)} via ` +
      `${localName(v.path)} (${constraintName})` +
      (v.message ? `: ${v.message}` : '') +
      `. Add a value for ${localName(v.path)} on ${localName(v.focusNode)} to satisfy the shape.`;
    out.push({
      id: `S${n}`,
      issue: 'shacl',
      action: {
        tool: 'addTriple',
        args: {
          subjectIri: v.focusNode,
          predicateIri: v.path,
          // objectValue intentionally omitted — see needsValue.
        },
      },
      rationale,
      needsValue: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Axiom weakening — less-destructive alternatives to deletion (R-weaken)
// ---------------------------------------------------------------------------

/**
 * Context the weakening enumerator needs from the (async) caller: the classified
 * subsumption hierarchy and, for intersection-typed superclasses, the resolved
 * owl:intersectionOf members keyed by the intersection node IRI. The caller in
 * reasoning.ts / RepairSuggestions.tsx reads these once via rdfManager.sparqlQuery
 * (this module stays pure/reasoner-free).
 */
export interface WeakeningContext {
  hierarchy: ClassHierarchy;
  /** Direct subClassOf edges (for hop-distance specificity ranking). */
  direct?: Map<string, Set<string>>;
  /** intersectionNodeIri → resolved conjunct member IRIs (A ⊑ B ⊓ C). */
  intersections?: Map<string, string[]>;
  /**
   * The inconsistency justifications (MIPS). When provided, weakenings are
   * enumerated for EVERY `rdfs:subClassOf` axiom appearing in a justification —
   * not only the axiom the deletion hitting-set happened to pick. This matters
   * because the hitting set prefers ABox removals (least destructive), so a
   * subClassOf culprit you could WEAKEN may not be the chosen deletion. Each
   * resulting weakening is tied (alternativeTo) to the deletion repair whose
   * justification contains the weakened axiom. Optional: when absent, weakenings
   * are derived only from the deletion repairs themselves (back-compat).
   */
  justifications?: Array<
    Array<{ subject: string; predicate: string; object: string; graph?: string }>
  >;
  /**
   * LACONIC justifications (Horridge et al. ISWC 2008), aligned BY INDEX with
   * `justifications`. When present, the precise culprit PART of an intersection
   * subClassOf axiom (e.g. the `A ⊑ B` part of `A ⊑ B ⊓ C`) tells the weakening
   * enumerator EXACTLY which conjunct to drop — the minimal repair target. Used
   * to set `laconicCulpritMember` on the culprit so the laconic-precise drop is
   * ranked first. Optional; absent ⇒ unchanged behaviour.
   */
  laconicJustifications?: Array<{
    parts: Array<{
      subject: string;
      predicate: string;
      object: string;
      sourceSubject: string;
      sourcePredicate: string;
      sourceObject: string;
      isPartOf: boolean;
    }>;
    sharpened: boolean;
    skipped: boolean;
  }>;
}

const RDFS_SUBCLASS_OF = `${RDFS}subClassOf`;

/**
 * For each DELETION repair whose culprit axiom is an `A rdfs:subClassOf D`,
 * enumerate logically-weaker replacements and append them as kind:'weaken'
 * repairs (ids W1, W2, …). The original deletion repairs are kept UNCHANGED —
 * weakening is offered as an ALTERNATIVE, ranked above deletion because it
 * preserves more knowledge (Troquard et al. 2018; Li & Lambrix 2024).
 *
 * Pure & deterministic given the same deletion repairs + context. The trivial
 * `A ⊑ owl:Thing` weakening (≡ deletion) is suppressed here to avoid duplicating
 * the deletion repair the agent already has.
 *
 * Returns the augmented list: original repairs followed by their weakening
 * alternatives (each annotated with `alternativeTo` = the deletion repair id).
 */
export function addWeakeningRepairs(
  repairs: RepairSuggestion[],
  ctx: WeakeningContext,
): RepairSuggestion[] {
  const out: RepairSuggestion[] = [...repairs];
  let wCount = 0;
  // Deduplicate culprit axioms already weakened (avoid duplicate W-repairs when
  // a subClassOf axiom is both the deletion target AND present across MIPS).
  const weakenedCulprits = new Set<string>();

  const deletionRepairs = repairs.filter(
    (r) => r.issue === 'inconsistency' && !r.needsManualReview,
  );

  // For each subClassOf culprit, find the deletion repair to tie it to: prefer a
  // deletion that targets the SAME axiom; else the deletion covering the same
  // justification; else the first inconsistency deletion (so alternativeTo is set).
  const findOwner = (
    s: string,
    p: string,
    o: string,
    jIdx: number | null,
  ): RepairSuggestion | undefined => {
    const exact = deletionRepairs.find(
      (r) =>
        r.action.args.subjectIri === s &&
        r.action.args.predicateIri === p &&
        r.action.args.objectIri === o,
    );
    if (exact) return exact;
    if (jIdx !== null) {
      const byJust = deletionRepairs.find((r) => r.justificationsCovered?.includes(jIdx));
      if (byJust) return byJust;
    }
    return deletionRepairs[0];
  };

  const emitWeakenings = (
    culprit: CulpritAxiom,
    owner: RepairSuggestion | undefined,
    covered: number[] | undefined,
  ) => {
    const key = `${culprit.subject} ${culprit.predicate} ${culprit.object} ${culprit.graph ?? ''}`;
    if (weakenedCulprits.has(key)) return;
    weakenedCulprits.add(key);
    const weakenings = enumerateWeakenings(culprit, ctx.hierarchy, {
      direct: ctx.direct,
      // Suppress A ⊑ owl:Thing — that IS the deletion of the axiom.
      includeThing: false,
    });
    for (const w of weakenings) {
      wCount += 1;
      out.push({
        id: `W${wCount}`,
        issue: 'inconsistency',
        kind: 'weaken',
        ...(owner ? { alternativeTo: owner.id } : {}),
        // `action` removes the culprit so a weakening-naive apply path still
        // removes it; `batch` carries the full remove+add (weakening-aware path).
        action: {
          tool: 'removeLink',
          args: {
            subjectIri: culprit.subject,
            predicateIri: culprit.predicate,
            objectIri: culprit.object,
            ...(culprit.graph ? { graph: culprit.graph } : {}),
          },
        },
        batch: { removes: w.removes, adds: w.adds },
        weakerThan: w.weakerThan,
        rationale: w.rationale + ' (less destructive than deletion — apply as a remove+add batch).',
        ...(covered ? { justificationsCovered: covered } : {}),
      });
    }
  };

  // Path A: weaken subClassOf axioms present in the JUSTIFICATIONS (preferred —
  // catches culprits the deletion hitting set skipped in favour of an ABox).
  if (ctx.justifications && ctx.justifications.length > 0) {
    ctx.justifications.forEach((mips, jIdx) => {
      // LACONIC culprit hint for THIS justification (aligned by index): the
      // precise conjunct part the contradiction actually uses. We look for a
      // laconic part whose SOURCE axiom is the intersection subClassOf axiom and
      // whose own object is one of the intersection's members — that member is
      // the offending conjunct to drop (Horridge et al. ISWC 2008).
      const lac = ctx.laconicJustifications?.[jIdx];
      const laconicMemberFor = (subject: string, intersectionObject: string): string | undefined => {
        if (!lac || lac.skipped) return undefined;
        const members = ctx.intersections?.get(intersectionObject);
        if (!members || members.length === 0) return undefined;
        for (const part of lac.parts) {
          if (
            part.isPartOf &&
            part.sourceSubject === subject &&
            part.sourceObject === intersectionObject &&
            part.subject === subject &&
            members.includes(part.object)
          ) {
            return part.object;
          }
        }
        return undefined;
      };

      for (const ax of mips) {
        if (ax.predicate !== RDFS_SUBCLASS_OF) continue;
        const culpritMember = laconicMemberFor(ax.subject, ax.object);
        const culprit: CulpritAxiom = {
          subject: ax.subject,
          predicate: RDFS_SUBCLASS_OF,
          object: ax.object,
          ...(ax.graph ? { graph: ax.graph } : {}),
          ...(ctx.intersections?.has(ax.object)
            ? { intersectionMembers: ctx.intersections.get(ax.object) }
            : {}),
          ...(culpritMember ? { laconicCulpritMember: culpritMember } : {}),
        };
        const owner = findOwner(ax.subject, RDFS_SUBCLASS_OF, ax.object, jIdx);
        emitWeakenings(culprit, owner, owner?.justificationsCovered ?? [jIdx]);
      }
    });
  }

  // Path B: also weaken any subClassOf axiom the deletion hitting set itself
  // chose (covers the back-compat case where no justifications were supplied).
  for (const del of deletionRepairs) {
    const a = del.action.args;
    if (a.predicateIri !== RDFS_SUBCLASS_OF || !a.subjectIri || !a.objectIri) continue;
    const culprit: CulpritAxiom = {
      subject: a.subjectIri,
      predicate: RDFS_SUBCLASS_OF,
      object: a.objectIri,
      ...(a.graph ? { graph: a.graph } : {}),
      ...(ctx.intersections?.has(a.objectIri)
        ? { intersectionMembers: ctx.intersections.get(a.objectIri) }
        : {}),
    };
    emitWeakenings(culprit, del, del.justificationsCovered);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Compute ranked, executable repair candidates from symbolic diagnostics.
 *
 * - Inconsistency repairs come from a minimal hitting set over the MIPS:
 *   removing the chosen axioms intersects every justification, restoring
 *   consistency. Ranked by impact (coverage), then least-destructive, then
 *   unsat-touching, then a stable order.
 * - SHACL repairs emit one `addTriple` candidate per actionable violation,
 *   flagged `needsValue` since the expected object cannot be inferred.
 *
 * Pure and deterministic: identical input always yields identical output.
 * Verification of each candidate (re-running the consistency oracle on a store
 * copy without the removed axioms) is performed separately by the caller.
 */
export function computeRepairs(diagnostics: DiagnosticsData): RepairSuggestion[] {
  const unsatClasses = new Set<string>(diagnostics.unsatisfiableClasses ?? []);
  const inconsistencyRepairs =
    diagnostics.isConsistent === false
      ? buildInconsistencyRepairs(diagnostics.justifications ?? [], unsatClasses)
      : [];
  const shaclRepairs = buildShaclRepairs(diagnostics.shaclViolations ?? []);
  return [...inconsistencyRepairs, ...shaclRepairs];
}

// ---------------------------------------------------------------------------
// Bounded subset-minimality verification for DELETION repairs
// ---------------------------------------------------------------------------

/**
 * A removal request projected from a deletion repair — the exact triple the
 * apply path (removeLink) removes, carrying the source graph and object-term
 * metadata so a verifier excludes the IDENTICAL quad (mirrors
 * reasoning.ts/repairToRemoval and verifyRepairMatch.RepairRemoval). The
 * reasoner-check callback receives a collection of these.
 */
export interface DeletionRemoval {
  subject: string;
  predicate: string;
  object: string;
  objectTermType?: string;
  objectDatatype?: string;
  objectLanguage?: string;
  graph?: string;
}

/**
 * The injected reasoner-check seam. Given a sub-collection of removals, returns
 * a promise resolving to `true` when removing exactly those axioms (on a STORE
 * COPY — the implementation MUST NOT mutate the author's graph) restores global
 * consistency. Tests supply a deterministic mock oracle; production wires this
 * to rdfManager.verifyRepairDetailed. The contract is read-only: the check is
 * invoked many times during the subset search and the caller relies on each
 * invocation being independent (no accumulated state on the real store).
 */
export type ReasonerConsistencyCheck = (
  removals: DeletionRemoval[],
) => Promise<boolean>;

export interface MinimalitySearchOptions {
  /**
   * Maximum hitting-set cardinality at which the exhaustive subset search runs.
   * At or below the bound we search for a genuinely minimal sub-collection; above
   * it we skip the (exponential) search and fall back to the irredundant
   * heuristic with `minimalityVerified: false`. Default 4. The search visits up
   * to 2^bound subsets, so keep the bound small.
   */
  bound?: number;
}

export interface MinimalityResult {
  /**
   * The verified-minimal sub-collection of removals (a subset of the input
   * deletion repairs' removals) whose removal restores consistency and no proper
   * subset of which does. When `minimalityVerified` is false this is the full
   * input set (the irredundant fallback) — minimality is NOT proven.
   */
  minimalDeletionSet: DeletionRemoval[];
  /**
   * true when the minimal set was reasoner-verified within the bound; false when
   * the set exceeded the bound (search skipped) OR the full set itself did not
   * restore consistency under the oracle (nothing to minimise from).
   */
  minimalityVerified: boolean;
  /** The bound that was applied. */
  bound: number;
  /** Number of reasoner-check invocations made (0 when search skipped). */
  checksPerformed: number;
}

/** Project a deletion RepairSuggestion to the removal the apply path would run. */
export function repairToDeletionRemoval(r: RepairSuggestion): DeletionRemoval {
  const a = r.action.args;
  return {
    subject: a.subjectIri ?? '',
    predicate: a.predicateIri ?? '',
    object: a.objectIri ?? '',
    ...(a.objectTermType ? { objectTermType: a.objectTermType } : {}),
    ...(a.objectDatatype ? { objectDatatype: a.objectDatatype } : {}),
    ...(a.objectLanguage ? { objectLanguage: a.objectLanguage } : {}),
    ...(a.graph ? { graph: a.graph } : {}),
  };
}

/** Stable key for a removal (graph + object-term aware, mirrors axiomKey). */
function removalKey(r: DeletionRemoval): string {
  return [
    r.subject,
    r.predicate,
    r.object,
    r.objectTermType ?? '',
    r.objectDatatype ?? '',
    r.objectLanguage ?? '',
    r.graph ?? '',
  ].join(' ');
}

/**
 * Enumerate all subsets of `items` of size exactly `k`, in ascending index
 * order (deterministic). Index combinations over [0, n).
 */
function combinations(n: number, k: number): number[][] {
  const out: number[][] = [];
  const combo: number[] = [];
  const rec = (start: number): void => {
    if (combo.length === k) {
      out.push([...combo]);
      return;
    }
    for (let i = start; i < n; i++) {
      combo.push(i);
      rec(i + 1);
      combo.pop();
    }
  };
  rec(0);
  return out;
}

/**
 * BOUNDED subset-minimality verification for a DELETION repair set.
 *
 * The greedy/irredundant hitting set computed by `computeMinimalHittingSet` is
 * minimal-by-heuristic: no single member is redundant, but it is NOT guaranteed
 * to be of minimum cardinality, and a genuinely smaller sub-collection may still
 * restore consistency once the *real* reasoner (not just the per-justification
 * combinatorics) is consulted. For a hitting set of size n at or below `bound`,
 * this searches — smallest cardinality first — for the smallest reasoner-VERIFIED
 * sub-collection whose removal restores consistency. The first such set found is
 * returned and flagged `minimalityVerified: true` (it is minimum-cardinality
 * within the candidate set, hence minimal: no smaller subset works).
 *
 * Above the bound the (exponential) search is skipped: the input set is returned
 * unchanged with `minimalityVerified: false` (irredundant fallback). When no
 * reasoner check is supplied this function is NEVER called by the pure path, so
 * behaviour with a missing oracle is unchanged (the caller simply leaves
 * `minimalityVerified` undefined).
 *
 * The oracle is invoked on REMOVAL sub-collections only; it must operate on a
 * store copy and never mutate the author's graph — this function relies on that
 * read-only contract (it issues many independent checks).
 *
 * Determinism: subsets are visited in ascending (size, lexicographic index)
 * order, so identical inputs + identical oracle yield an identical minimal set.
 */
export async function verifyDeletionSetMinimality(
  deletionRemovals: DeletionRemoval[],
  check: ReasonerConsistencyCheck,
  options: MinimalitySearchOptions = {},
): Promise<MinimalityResult> {
  const bound = options.bound ?? 4;
  // Deduplicate by removal key (two repairs could project the same triple) while
  // preserving first-seen order for stable index combinations.
  const seen = new Set<string>();
  const items: DeletionRemoval[] = [];
  for (const r of deletionRemovals) {
    const k = removalKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    items.push(r);
  }

  const n = items.length;

  // Empty set: nothing to verify. Vacuously not a verified-minimal repair.
  if (n === 0) {
    return { minimalDeletionSet: [], minimalityVerified: false, bound, checksPerformed: 0 };
  }

  // Above the bound: skip the exponential search, fall back to the irredundant
  // set and flag minimality as NOT verified.
  if (n > bound) {
    return { minimalDeletionSet: items, minimalityVerified: false, bound, checksPerformed: 0 };
  }

  let checksPerformed = 0;

  // Search smallest-first. For each cardinality k from 1..n, try every k-subset
  // (deterministic ascending index order). The first subset the oracle reports
  // consistent for is, by construction, of minimum cardinality among all working
  // subsets — hence genuinely minimal (no smaller sub-collection restores
  // consistency). k === n is the full set itself.
  for (let k = 1; k <= n; k++) {
    for (const idx of combinations(n, k)) {
      const subset = idx.map((i) => items[i]);
      checksPerformed += 1;
      // eslint-disable-next-line no-await-in-loop -- deterministic smallest-first search
      const consistent = await check(subset);
      if (consistent) {
        return {
          minimalDeletionSet: subset,
          minimalityVerified: true,
          bound,
          checksPerformed,
        };
      }
    }
  }

  // No subset (including the full set) restored consistency under the oracle.
  // Return the full set but do NOT claim verified minimality — the oracle could
  // not confirm even the whole set fixes the ontology (e.g. a degenerate MIPS or
  // an oracle that never matched the removals).
  return { minimalDeletionSet: items, minimalityVerified: false, bound, checksPerformed };
}

/**
 * Convenience wrapper: run the bounded subset-minimality search over the
 * DELETION repairs in `repairs` (issue:'inconsistency', not weaken, not
 * needsManualReview, with a fully-specified action), then annotate each verified
 * deletion repair in place with `minimalityVerified`. Returns the
 * MinimalityResult so the caller can surface `minimalDeletionSet`.
 *
 * No-ops (returns minimalityVerified:false, leaves repairs untouched) when there
 * are no actionable deletion repairs. Never called on the pure path, so callers
 * that omit a reasoner check see unchanged behaviour.
 */
export async function annotateDeletionMinimality(
  repairs: RepairSuggestion[],
  check: ReasonerConsistencyCheck,
  options: MinimalitySearchOptions = {},
): Promise<MinimalityResult> {
  const deletionRepairs = repairs.filter(
    (r) =>
      r.issue === 'inconsistency' &&
      r.kind !== 'weaken' &&
      !r.needsManualReview &&
      r.action.args.subjectIri &&
      r.action.args.predicateIri &&
      r.action.args.objectIri,
  );

  if (deletionRepairs.length === 0) {
    return { minimalDeletionSet: [], minimalityVerified: false, bound: options.bound ?? 4, checksPerformed: 0 };
  }

  const removals = deletionRepairs.map(repairToDeletionRemoval);
  const result = await verifyDeletionSetMinimality(removals, check, options);

  // Annotate the deletion repairs with the shared verdict so the UI/agent can
  // distinguish a reasoner-verified-minimal set from an irredundant fallback.
  for (const r of deletionRepairs) r.minimalityVerified = result.minimalityVerified;

  return result;
}
