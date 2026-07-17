/**
 * laconicJustification.ts
 *
 * TODO(rdf-reasoner-konclude): this module will be ported to the reasoner
 * package as explainInconsistencyLaconic() (plan-050, Unit 4-5).
 *
 * LACONIC JUSTIFICATIONS for OWL entailments / inconsistencies.
 *
 * PURE, STANDALONE module. NOT wired into the worker / reasoning pipeline yet.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THEORY
 * ─────────────────────────────────────────────────────────────────────────────
 * Implements laconic justifications following:
 *
 *   M. Horridge, B. Parsia, U. Sattler.
 *   "Laconic and Precise Justifications in OWL."
 *   The Semantic Web — ISWC 2008, LNCS 5318, pp. 323–338. Springer, 2008.
 *
 * A *justification* J for an entailment η (here η is usually the inconsistency
 * ⊤ ⊑ ⊥, or an unsatisfiable class A ⊑ ⊥) is a MINIMAL subset of the ontology's
 * axioms such that J ⊨ η but no proper subset of J entails η. Standard (regular)
 * justifications are minimal at the granularity of WHOLE axioms, but an axiom can
 * still carry SUPERFLUOUS parts: e.g. in the justification
 *
 *     { A ⊑ B ⊓ C ,  B ⊑ ⊥ }
 *
 * the conjunct `C` of the first axiom plays no role in the contradiction — only
 * the `A ⊑ B` PART is causally responsible. A regular justification cannot say
 * this; it reports the whole axiom `A ⊑ B ⊓ C`.
 *
 * A justification is LACONIC iff every axiom in it is (a) as WEAK as possible and
 * (b) free of superfluous parts — i.e. you cannot replace any axiom by a strictly
 * weaker consequence of it and still entail η, and you cannot drop any part. The
 * laconic justification therefore pinpoints PRECISELY the axiom parts that cause
 * η. For an LLM repair agent this is sharper: instead of "axiom A ⊑ B ⊓ C is
 * involved", we can say "the `A ⊑ B` part of axiom A ⊑ B ⊓ C is the culprit; the
 * `A ⊑ C` part is irrelevant".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ALGORITHM (pinpointing by ORACLE — reasoner-agnostic, pure)
 * ─────────────────────────────────────────────────────────────────────────────
 * Horridge et al. compute laconic justifications by (1) rewriting each axiom of a
 * regular justification into the set of its weaker syntactic parts (the OPlus /
 * weakening closure), then (2) recomputing a minimal entailing subset over those
 * finer-grained parts. We follow exactly that two-step shape, but keep the entire
 * module REASONER-AGNOSTIC by taking the entailment test as an injected ORACLE:
 *
 *   splitAxiom(axiom)                 → the weaker parts (OPlus) of one axiom.
 *   computeLaconic(justification, ⊨)  → a minimal entailing subset of the union of
 *                                       all parts, plus a part → source mapping.
 *
 * `⊨` (the `entails` oracle) is supplied by the caller: `entails(axiomSet)`
 * returns true iff `axiomSet` entails the target η (e.g. is inconsistent). In the
 * worker this will be backed by Konclude's consistency check; in tests it is a
 * deterministic mock. The module never calls a reasoner itself, so it is fully
 * unit-testable and side-effect free.
 *
 * STEP 1 — splitAxiom (structural weakening / OPlus). The weaker parts of an
 *   axiom are entailment-preserving consequences that are syntactically smaller.
 *   The split rules implemented here (all expressible in the repo's triple shape):
 *
 *     • SubClassOf with an intersection RHS:
 *         A ⊑ B ⊓ C   ⤳   { A ⊑ B , A ⊑ C }
 *       (C ⊑ D₁ ⊓ … ⊓ Dₙ is equivalent to the n axioms C ⊑ Dᵢ; each is weaker.)
 *
 *     • SubClassOf with a someValuesFrom whose filler is an intersection:
 *         A ⊑ ∃R.(B ⊓ C)   ⤳   { A ⊑ ∃R.B , A ⊑ ∃R.C }
 *       (∃R.(B⊓C) ⊑ ∃R.B and ⊑ ∃R.C, so each is a weaker consequence.)
 *
 *     • EquivalentClasses(A, B): A ≡ B entails both A ⊑ B and B ⊑ A, each of which
 *       is weaker than the equivalence. We split into those two subsumptions, and
 *       then recursively weaken each (so A ≡ B ⊓ C yields A ⊑ B, A ⊑ C, B⊓C ⊑ A).
 *
 *   Everything else is KEPT WHOLE (returned as the singleton {axiom}). Keeping an
 *   axiom whole is always SOUND: the laconic result is then merely COARSER (it may
 *   report a whole axiom where a finer part would have sufficed) but never wrong.
 *   In particular we do NOT attempt to weaken: intersection LHS (A ⊓ B ⊑ C — both
 *   conjuncts may be needed, splitting would be unsound), union RHS, cardinality
 *   restrictions, property axioms, or ABox assertions. See the per-shape notes in
 *   `splitAxiom`.
 *
 * STEP 2 — computeLaconic. Replace each axiom of J by its split parts, union them
 *   into the candidate set J'. J' still entails η (each part is a consequence of a
 *   source axiom in J, and J ⊨ η, so J' ⊨ η — soundness of weakening). Then find a
 *   single MINIMAL subset of J' that still entails η, by a deterministic black-box
 *   minimisation (Horridge's "expand-contract" contraction step over parts): scan
 *   the parts in a fixed order and drop any part whose removal preserves the
 *   entailment. The survivors are a laconic justification — every part is
 *   NECESSARY (removing it breaks η) and as WEAK as possible (it is a leaf of the
 *   weakening closure). We also return a Map from each surviving part back to the
 *   ORIGINAL axiom it was split from, so the UI can attribute the blame precisely.
 *
 * DETERMINISM. splitAxiom emits parts in document order; computeLaconic contracts
 *   in a fixed, stable order. The same input always yields the same output.
 *
 * SOUNDNESS RECAP. Every part returned by splitAxiom is a logical CONSEQUENCE of
 *   its source axiom (weakening), so any subset of parts that entails η witnesses
 *   that the corresponding sources entail η. Unsplittable axioms are preserved
 *   verbatim. Hence the laconic result is always a correct (if sometimes coarser)
 *   pinpointing of the cause.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INPUT / OUTPUT ENCODING
 * ─────────────────────────────────────────────────────────────────────────────
 * An axiom is a NON-EMPTY array of RDF triples in the repo's
 * `{ subject, predicate, object, objectIsLiteral? }` shape (see
 * ReasoningError.justification in reasoningTypes.ts and LocalityTriple in
 * localityModule.ts). A simple axiom such as `A ⊑ B` is a single triple; an axiom
 * with an anonymous class expression (∃R.(B ⊓ C), an intersection RHS expressed
 * via owl:intersectionOf + rdf:List) is the principal triple plus the blank-node
 * closure that builds the expression. splitAxiom resolves owl:intersectionOf
 * lists and someValuesFrom restrictions to produce the weaker parts; each part is
 * itself a self-contained LaconicAxiom (its own triple closure).
 */

import { RDF, RDFS, OWL } from "../constants/vocabularies.ts";

// ───────────────────────────── Well-known IRIs ──────────────────────────────

const RDF_TYPE = RDF.type;
const RDF_FIRST = RDF.first;
const RDF_REST = RDF.rest;
const RDF_NIL = RDF.nil;

const RDFS_SUBCLASS_OF = `${RDFS.namespace}subClassOf`;
const OWL_EQUIVALENT_CLASS = `${OWL.namespace}equivalentClass`;

const OWL_RESTRICTION = `${OWL.namespace}Restriction`;
const OWL_ON_PROPERTY = `${OWL.namespace}onProperty`;
const OWL_SOME_VALUES_FROM = `${OWL.namespace}someValuesFrom`;
const OWL_INTERSECTION_OF = `${OWL.namespace}intersectionOf`;

// ───────────────────────────────── Types ────────────────────────────────────

/**
 * A single RDF triple. Matches the `{ subject, predicate, object }` shape used
 * across the repo (ReasoningError.justification, LocalityTriple). `objectIsLiteral`
 * is optional; when omitted the object is treated as an IRI / blank-node term.
 */
export interface LaconicTriple {
  subject: string;
  predicate: string;
  object: string;
  objectIsLiteral?: boolean;
}

/**
 * An AXIOM: one logical OWL axiom assembled from its principal triple plus the
 * transitive blank-node closure (restrictions, rdf:Lists, nested class
 * expressions). A simple `A ⊑ B` is a one-triple axiom; `A ⊑ ∃R.(B ⊓ C)` is the
 * principal subClassOf triple plus the restriction / list closure. The first
 * triple is treated as the PRINCIPAL.
 */
export type LaconicAxiom = LaconicTriple[];

/**
 * The result of computeLaconic.
 *
 *   laconic — the laconic justification: the minimal, weakest set of axiom PARTS
 *     that still entails the target. Every part is necessary and as weak as the
 *     split rules allow.
 *   sources — maps each laconic part (by referential identity AND by stable key)
 *     back to the ORIGINAL axiom it was split from, so the UI can say "the
 *     `A ⊑ B` part of axiom `A ⊑ B ⊓ C` is the culprit".
 */
export interface LaconicResult {
  laconic: LaconicAxiom[];
  /** part → the original (pre-split) axiom that part came from. */
  sources: Map<LaconicAxiom, LaconicAxiom>;
}

/**
 * The entailment ORACLE. `entails(axiomSet)` returns true iff the conjunction of
 * the given axioms entails the target η (e.g. is inconsistent / unsatisfiable).
 * Supplied by the caller — Konclude in the worker, a mock in tests. The module
 * treats it as a black box and only ever calls it on subsets of the candidate
 * parts.
 */
export type EntailsOracle = (axiomSet: LaconicAxiom[]) => boolean;

// ───────────────────────────── Term helpers ─────────────────────────────────

/** Blank nodes are encoded as `_:b0`, N3 `bN`, or `n3-…` ids. */
function isBlankNode(term: string): boolean {
  return term.startsWith("_:") || /^b\d+$/.test(term) || term.startsWith("n3-");
}

/** A stable, order-independent key for a single triple. */
function tripleKey(t: LaconicTriple): string {
  return `${t.subject} ${t.predicate} ${t.object} ${t.objectIsLiteral ? "1" : "0"}`;
}

/**
 * A stable, order-independent key for an axiom (sorted triple keys joined). Used
 * to deduplicate parts and to expose a string handle in the sources map.
 */
export function axiomKey(axiom: LaconicAxiom): string {
  return axiom.map(tripleKey).sort().join("");
}

/** Index a triple list by subject for blank-node closure / list walking. */
function indexBySubject(triples: LaconicTriple[]): Map<string, LaconicTriple[]> {
  const out = new Map<string, LaconicTriple[]>();
  for (const t of triples) {
    let arr = out.get(t.subject);
    if (!arr) {
      arr = [];
      out.set(t.subject, arr);
    }
    arr.push(t);
  }
  return out;
}

/** First outgoing object triple for `subject` under `predicate`, if any. */
function objTriple(
  bySubject: Map<string, LaconicTriple[]>,
  subject: string,
  predicate: string,
): LaconicTriple | undefined {
  return (bySubject.get(subject) ?? []).find((t) => t.predicate === predicate);
}

/**
 * Resolve an rdf:List headed by `head` into its member object terms. Cycle-safe.
 */
function resolveList(bySubject: Map<string, LaconicTriple[]>, head: string): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = head;
  while (cur && cur !== RDF_NIL && !seen.has(cur)) {
    seen.add(cur);
    const arr = bySubject.get(cur) ?? [];
    const first = arr.find((t) => t.predicate === RDF_FIRST);
    const rest = arr.find((t) => t.predicate === RDF_REST);
    if (first) items.push(first.object);
    cur = rest?.object;
  }
  return items;
}

/**
 * Collect the transitive blank-node closure of `start`, appending every reachable
 * triple to `acc`. Cycle-safe. Used to pull the full triple set that builds an
 * anonymous class expression (a member of an intersection list, a nested
 * restriction filler, …) when emitting it as a self-contained part.
 */
function blankClosure(
  bySubject: Map<string, LaconicTriple[]>,
  start: string,
  acc: LaconicTriple[],
  seen: Set<string>,
): void {
  if (seen.has(start)) return;
  seen.add(start);
  const arr = bySubject.get(start);
  if (!arr) return;
  for (const t of arr) {
    acc.push(t);
    if (!t.objectIsLiteral && isBlankNode(t.object)) {
      blankClosure(bySubject, t.object, acc, seen);
    }
  }
}

// ─────────────────────────────── splitAxiom ─────────────────────────────────

/**
 * splitAxiom — the weakening closure (OPlus) of a single axiom: the set of its
 * weaker, superfluous-part-free pieces. Returns an array of self-contained
 * axioms. When the axiom matches no recognised weakening rule it is returned
 * UNCHANGED as a singleton (sound: a coarser laconic result).
 *
 * Recognised weakenings (see the module header for the soundness rationale):
 *   • A ⊑ B₁ ⊓ … ⊓ Bₙ            → { A ⊑ B₁ , … , A ⊑ Bₙ }
 *   • A ⊑ ∃R.(B₁ ⊓ … ⊓ Bₙ)       → { A ⊑ ∃R.B₁ , … , A ⊑ ∃R.Bₙ }
 *   • A ≡ B                       → split into A ⊑ B and B ⊑ A, then weaken each.
 *
 * Determinism: parts are emitted in the document / list order of the conjuncts.
 */
export function splitAxiom(axiom: LaconicAxiom): LaconicAxiom[] {
  if (axiom.length === 0) return [axiom];

  const bySubject = indexBySubject(axiom);
  const principal = axiom[0];
  const p = principal.predicate;

  // ── EquivalentClasses(A, B): A ≡ B ⊨ A ⊑ B and B ⊑ A (both weaker). ─────────
  // We rewrite the equivalence into the two subsumptions, then recursively weaken
  // each (so an intersection on either side is further split). Only handled for
  // a NAMED A and a NAMED-or-anonymous B (the common shapes); literal objects are
  // left whole.
  if (p === OWL_EQUIVALENT_CLASS && !principal.objectIsLiteral) {
    const a = principal.subject;
    const b = principal.object;
    const forward = buildSubClassAxiom(bySubject, a, b);
    const backward = buildSubClassAxiom(bySubject, b, a);
    if (forward && backward) {
      const out: LaconicAxiom[] = [];
      for (const part of splitAxiom(forward)) pushUnique(out, part);
      for (const part of splitAxiom(backward)) pushUnique(out, part);
      return out;
    }
    return [axiom];
  }

  // ── SubClassOf(A, RHS) ──────────────────────────────────────────────────────
  if (p === RDFS_SUBCLASS_OF && !principal.objectIsLiteral) {
    const a = principal.subject;
    const rhs = principal.object;

    // Case 1: RHS is an intersection class expression (owl:intersectionOf list).
    const interParts = splitIntersectionRhs(bySubject, a, rhs);
    if (interParts) return interParts;

    // Case 2: RHS is a someValuesFrom restriction whose filler is an intersection.
    const someInterParts = splitSomeValuesIntersection(bySubject, a, rhs);
    if (someInterParts) return someInterParts;

    // Otherwise: a plain or unrecognised SubClassOf → keep whole (sound).
    return [axiom];
  }

  // Everything else (intersection LHS, union RHS, cardinality, property axioms,
  // ABox assertions, unrecognised shapes) → keep whole (sound, coarser).
  return [axiom];
}

/**
 * If `rhs` is an anonymous class with an owl:intersectionOf list, return one
 * `subject ⊑ member` axiom per list member (each member's full blank-node closure
 * carried along). Returns undefined when `rhs` is not such an intersection.
 */
function splitIntersectionRhs(
  bySubject: Map<string, LaconicTriple[]>,
  subject: string,
  rhs: string,
): LaconicAxiom[] | undefined {
  if (!isBlankNode(rhs)) return undefined;
  const inter = objTriple(bySubject, rhs, OWL_INTERSECTION_OF);
  if (!inter) return undefined;
  const members = resolveList(bySubject, inter.object);
  if (members.length === 0) return undefined;

  const out: LaconicAxiom[] = [];
  for (const m of members) {
    const part = buildSubClassAxiom(bySubject, subject, m);
    if (part) pushUnique(out, part);
  }
  // If we could not build a single member axiom, fall back to keeping whole.
  return out.length > 0 ? out : undefined;
}

/**
 * If `rhs` is an anonymous someValuesFrom restriction `∃R.F` whose filler `F` is
 * itself an owl:intersectionOf `F₁ ⊓ … ⊓ Fₙ`, return one `subject ⊑ ∃R.Fᵢ` axiom
 * per filler member. Returns undefined when the shape does not match.
 */
function splitSomeValuesIntersection(
  bySubject: Map<string, LaconicTriple[]>,
  subject: string,
  rhs: string,
): LaconicAxiom[] | undefined {
  if (!isBlankNode(rhs)) return undefined;
  const onProp = objTriple(bySubject, rhs, OWL_ON_PROPERTY);
  const some = objTriple(bySubject, rhs, OWL_SOME_VALUES_FROM);
  if (!onProp || !some || some.objectIsLiteral) return undefined;

  const filler = some.object;
  if (!isBlankNode(filler)) return undefined;
  const inter = objTriple(bySubject, filler, OWL_INTERSECTION_OF);
  if (!inter) return undefined;
  const members = resolveList(bySubject, inter.object);
  if (members.length === 0) return undefined;

  const out: LaconicAxiom[] = [];
  for (const m of members) {
    const part = buildSomeValuesAxiom(bySubject, subject, onProp.object, m);
    if (part) pushUnique(out, part);
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Build a self-contained `subject ⊑ rhsTerm` axiom. When `rhsTerm` is a blank
 * node (an anonymous class expression) its full blank-node closure is carried so
 * the part stands alone. Returns undefined only for degenerate input.
 */
function buildSubClassAxiom(
  bySubject: Map<string, LaconicTriple[]>,
  subject: string,
  rhsTerm: string,
): LaconicAxiom | undefined {
  if (!subject || !rhsTerm) return undefined;
  const triples: LaconicTriple[] = [
    { subject, predicate: RDFS_SUBCLASS_OF, object: rhsTerm, objectIsLiteral: false },
  ];
  if (isBlankNode(rhsTerm)) {
    blankClosure(bySubject, rhsTerm, triples, new Set<string>());
  }
  return triples;
}

/**
 * Build a self-contained `subject ⊑ ∃prop.fillerTerm` axiom with a DETERMINISTIC
 * fresh blank node for the restriction (so distinct parts never collide on a
 * shared blank id, while the same input always yields the same id). The filler's
 * blank-node closure is carried when the filler is anonymous.
 */
function buildSomeValuesAxiom(
  bySubject: Map<string, LaconicTriple[]>,
  subject: string,
  prop: string,
  fillerTerm: string,
): LaconicAxiom | undefined {
  if (!subject || !prop || !fillerTerm) return undefined;
  // Deterministic fresh blank node derived from the structural triple so the same
  // input yields the same id (determinism) while staying distinct per part.
  const restr = `_:laconic-${stableHash(`${subject}|${prop}|${fillerTerm}`)}`;
  const triples: LaconicTriple[] = [
    { subject, predicate: RDFS_SUBCLASS_OF, object: restr, objectIsLiteral: false },
    { subject: restr, predicate: RDF_TYPE, object: OWL_RESTRICTION, objectIsLiteral: false },
    { subject: restr, predicate: OWL_ON_PROPERTY, object: prop, objectIsLiteral: false },
    { subject: restr, predicate: OWL_SOME_VALUES_FROM, object: fillerTerm, objectIsLiteral: false },
  ];
  if (isBlankNode(fillerTerm)) {
    blankClosure(bySubject, fillerTerm, triples, new Set<string>());
  }
  return triples;
}

/** A small deterministic hash → short hex string (no crypto dependency). */
function stableHash(s: string): string {
  let h = 2166136261 >>> 0; // FNV-1a 32-bit
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16);
}

/** Push `part` into `out` only if no axiom with the same key is present. */
function pushUnique(out: LaconicAxiom[], part: LaconicAxiom): void {
  const k = axiomKey(part);
  for (const existing of out) {
    if (axiomKey(existing) === k) return;
  }
  out.push(part);
}

// ───────────────────────────── computeLaconic ───────────────────────────────

/**
 * computeLaconic — given a (regular) justification and an entailment oracle,
 * produce a LACONIC justification: the minimal, weakest set of axiom PARTS that
 * still entails the target, plus a map from each part back to its source axiom.
 *
 * Steps (Horridge et al. ISWC 2008, oracle / black-box variant):
 *   1. Split every axiom of `justification` via splitAxiom → candidate parts J'.
 *      Each part is a logical consequence of its source axiom, so J' ⊨ η whenever
 *      J ⊨ η (weakening soundness). Deduplicate parts; remember each part's source.
 *   2. SANITY: if the full candidate set does not entail η under the oracle, the
 *      split was non-conservative for this oracle (should not happen for a sound
 *      oracle + sound split) — fall back to the ORIGINAL justification unchanged so
 *      the result is never weaker than the input guarantees.
 *   3. CONTRACT: scan parts in a fixed order; drop any part whose removal keeps the
 *      remaining set entailing η. Survivors form one minimal (laconic)
 *      justification — every part necessary, every part as weak as the split rules
 *      allow.
 *
 * Determinism: the candidate order is the split order; contraction is a single
 * stable left-to-right pass, so the output is deterministic.
 */
export function computeLaconic(
  justification: LaconicAxiom[],
  entails: EntailsOracle,
): LaconicResult {
  // Step 1 — split + dedupe, tracking provenance.
  const candidates: LaconicAxiom[] = [];
  const candidateKeys = new Set<string>();
  const sources = new Map<LaconicAxiom, LaconicAxiom>();

  for (const original of justification) {
    const parts = splitAxiom(original);
    for (const part of parts) {
      const k = axiomKey(part);
      if (candidateKeys.has(k)) continue;
      candidateKeys.add(k);
      candidates.push(part);
      sources.set(part, original);
    }
  }

  // Step 2 — sanity: the candidate set must still entail η. If not (an unsound or
  // mismatched oracle), fall back to the original justification verbatim so we
  // never return something the oracle does not accept.
  if (!entails(candidates)) {
    const fallbackSources = new Map<LaconicAxiom, LaconicAxiom>();
    for (const a of justification) fallbackSources.set(a, a);
    return { laconic: [...justification], sources: fallbackSources };
  }

  // Step 3 — contract: drop every superfluous part (single stable pass).
  let current = [...candidates];
  for (const part of candidates) {
    const without = current.filter((c) => c !== part);
    if (entails(without)) {
      current = without;
    }
  }

  // Build the sources map restricted to the surviving parts (preserve order).
  const laconicSources = new Map<LaconicAxiom, LaconicAxiom>();
  for (const part of current) {
    const src = sources.get(part);
    if (src) laconicSources.set(part, src);
  }

  return { laconic: current, sources: laconicSources };
}
