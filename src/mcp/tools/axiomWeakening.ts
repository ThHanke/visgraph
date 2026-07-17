// src/mcp/tools/axiomWeakening.ts
//
// TODO(rdf-reasoner-konclude): axiom weakening should move to the reasoner API
// once repair/weakening endpoints land. Currently app-side (plan-050 deferred).
//
// Axiom WEAKENING as a less-destructive repair alternative to axiom DELETION.
//
// Background — the publishable contribution
// ------------------------------------------
// Our reasoner-computed repairs (computeRepairs.ts) restore consistency by
// DELETING a culprit axiom from each inconsistency justification (MIPS). That is
// the maximally destructive choice: it throws away ALL the knowledge the axiom
// carried. Troquard, Confalonieri, Galliani, Peñaloza, Porello & Kutz —
// "Repairing Ontologies via Axiom Weakening" (AAAI 2018) — show you can instead
// REPLACE the culprit `A ⊑ D` with a logically WEAKER axiom `A ⊑ D′` (D′ ⊒ D)
// that no longer triggers the clash while still preserving the entailments below
// D′. Li & Lambrix — "Repairing Networks of EL⊥ Ontologies Using Weakening and
// Completing" (ISWC 2024) — extend the weakening operator to networks of EL⊥
// ontologies and pair it with completion. This module implements the *generation*
// + *ranking* of weakening candidates; symbolic verification (re-running the
// Konclude consistency oracle) is layered on top in reasoning.ts /
// RepairSuggestions.tsx exactly as for deletions.
//
// Scope (honest about coverage)
// -----------------------------
// We implement weakening for `rdfs:subClassOf` axioms only — the most common
// culprit in EL⊥ inconsistencies and the case the cited papers analyse most
// directly. Two weakening operators (subsumed by the papers' refinement operator
// for the relevant fragment):
//
//   1. GENERALISE THE SUPERCLASS. Given `A ⊑ D`, replace D with a NAMED proper
//      superclass D′ of D drawn from the classified hierarchy (any D′ with
//      `D ⊑ D′`). Since D ⊑ D′, the axiom `A ⊑ D′` is *logically weaker* than
//      `A ⊑ D` (every model of A ⊑ D is a model of A ⊑ D′, but not vice versa).
//      The chain ends at the trivial `A ⊑ owl:Thing`, which is a tautology and
//      hence equivalent to simply DELETING the constraint while keeping A
//      declared — so deletion is recovered as the weakest weakening.
//
//   2. DROP A CONJUNCT. Given `A ⊑ B ⊓ C` (expressed either as two subClassOf
//      targets or via an owl:intersectionOf), drop the culprit conjunct to get
//      `A ⊑ B` or `A ⊑ C`. Dropping a conjunct enlarges the class, so the result
//      is again logically weaker.
//
// This module is PURE and reasoner-free so it can be unit-tested exhaustively.
// The caller supplies the class hierarchy (read once via rdfManager.sparqlQuery
// over urn:vg:inferred + asserted rdfs:subClassOf) and, where relevant, the
// resolved owl:intersectionOf members.

const OWL = 'http://www.w3.org/2002/07/owl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
export const OWL_THING = `${OWL}Thing`;
export const RDFS_SUBCLASS_OF = `${RDFS}subClassOf`;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single RDF triple (subject/predicate/object IRIs). */
export interface WeakeningTriple {
  subject: string;
  predicate: string;
  object: string;
  /** Optional source/target graph (threaded so apply/verify hit the right graph). */
  graph?: string;
}

/**
 * The class subsumption hierarchy used to enumerate superclasses. `superclasses`
 * maps a class IRI to the set of its KNOWN named superclasses (direct + inferred,
 * i.e. the reflexive-transitive closure MINUS the class itself and MINUS
 * owl:Thing, which is added explicitly as the trivial fallback). Built from
 * urn:vg:inferred + asserted `rdfs:subClassOf` triples.
 */
export interface ClassHierarchy {
  /** className → set of strictly-more-general named superclasses (excludes self & owl:Thing). */
  superclasses: Map<string, Set<string>>;
}

/**
 * One enumerated weakening of a culprit axiom: a BATCH that removes the original
 * axiom triple(s) and adds the weaker replacement triple(s).
 */
export interface WeakeningCandidate {
  /** 'generalize' (A ⊑ D → A ⊑ D′, D ⊑ D′) or 'dropConjunct' (A ⊑ B ⊓ C → A ⊑ B). */
  strategy: 'generalize' | 'dropConjunct';
  /** Triple(s) to remove (the original culprit axiom). */
  removes: WeakeningTriple[];
  /** Triple(s) to add (the logically weaker replacement). null adds nothing (≡ deletion). */
  adds: WeakeningTriple[];
  /**
   * The replacement superclass/target IRI. For 'generalize' this is D′; for
   * 'dropConjunct' it is the surviving conjunct. owl:Thing here means the
   * weakening degenerates to a deletion (constraint removed entirely).
   */
  weakerTarget: string;
  /**
   * Specificity rank used for ordering: SMALLER = more specific = LESS weakening
   * = preferred (preserves the most knowledge). The hop-distance from D up the
   * subsumption chain to weakerTarget; owl:Thing gets the largest value.
   */
  specificityRank: number;
  /** Human-readable explanation, e.g. "A ⊑ B → A ⊑ C (C ⊒ B; preserves A ⊑ C)". */
  rationale: string;
  /** "A ⊑ D" — the original axiom, for messaging. */
  weakerThan: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** local name after the last '#' or '/', or the full string. */
function localName(iri: string): string {
  if (!iri) return iri;
  const hash = iri.lastIndexOf('#');
  if (hash !== -1 && hash < iri.length - 1) return iri.slice(hash + 1);
  const slash = iri.lastIndexOf('/');
  if (slash !== -1 && slash < iri.length - 1) return iri.slice(slash + 1);
  return iri;
}

function isSubClassOf(predicate: string): boolean {
  return predicate === RDFS_SUBCLASS_OF;
}

// ---------------------------------------------------------------------------
// Hierarchy construction
// ---------------------------------------------------------------------------

/**
 * Build a ClassHierarchy from a flat list of `X rdfs:subClassOf Y` edges (the
 * asserted + inferred subsumption graph). Computes the transitive closure so
 * `superclasses(D)` returns every strictly-more-general named class — direct AND
 * indirect — which lets us enumerate the full weakening chain D ⊑ … ⊑ ⊤.
 *
 * owl:Thing and self-loops are excluded from the stored set (owl:Thing is the
 * explicit trivial fallback added by enumerateWeakenings; a self-edge is not a
 * proper superclass). Cycles (equivalent classes asserted as mutual subclasses)
 * are handled — the closure simply includes each member as a superclass of the
 * others, and self is still excluded.
 */
export function buildClassHierarchy(
  subClassEdges: Array<{ sub: string; sup: string }>,
): ClassHierarchy {
  // direct edges
  const direct = new Map<string, Set<string>>();
  for (const { sub, sup } of subClassEdges) {
    if (!sub || !sup) continue;
    if (sub === sup) continue; // ignore reflexive self-edges
    if (sup === OWL_THING) continue; // owl:Thing handled as explicit fallback
    let set = direct.get(sub);
    if (!set) {
      set = new Set<string>();
      direct.set(sub, set);
    }
    set.add(sup);
  }

  // transitive closure via DFS per node (small ontologies; deterministic).
  const closure = new Map<string, Set<string>>();
  const computeFor = (node: string): Set<string> => {
    const cached = closure.get(node);
    if (cached) return cached;
    const acc = new Set<string>();
    closure.set(node, acc); // set early to break cycles
    const ds = direct.get(node);
    if (ds) {
      for (const sup of ds) {
        if (sup === node) continue;
        acc.add(sup);
        for (const t of computeFor(sup)) {
          if (t !== node) acc.add(t);
        }
      }
    }
    return acc;
  };
  for (const node of direct.keys()) computeFor(node);

  return { superclasses: closure };
}

/**
 * Hop-distance from D to a target superclass via the DIRECT subsumption edges —
 * used for specificity ranking (the most specific = nearest proper superclass is
 * the least-weakening, hence preferred). Returns Infinity-equivalent (a large
 * sentinel) when the target is not reachable through direct edges (it is still a
 * valid transitive superclass; it just ranks after all directly-reachable ones).
 */
function hopDistance(
  direct: Map<string, Set<string>>,
  from: string,
  target: string,
): number {
  if (from === target) return 0;
  const visited = new Set<string>([from]);
  let frontier = [from];
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const node of frontier) {
      const sups = direct.get(node);
      if (!sups) continue;
      for (const sup of sups) {
        if (sup === target) return depth;
        if (!visited.has(sup)) {
          visited.add(sup);
          next.push(sup);
        }
      }
    }
    frontier = next;
  }
  return Number.MAX_SAFE_INTEGER;
}

// ---------------------------------------------------------------------------
// Weakening enumeration
// ---------------------------------------------------------------------------

/**
 * The culprit axiom to weaken, plus the metadata needed to build precise
 * remove/add triples.
 */
export interface CulpritAxiom {
  /** The subclass A. */
  subject: string;
  /** Must be rdfs:subClassOf for weakening to apply. */
  predicate: string;
  /** The superclass D (named) OR the intersection node carrying the conjunction. */
  object: string;
  /** Source graph the axiom lives in (threaded to the remove/add triples). */
  graph?: string;
  /**
   * When the culprit is `A ⊑ B ⊓ C` expressed as an owl:intersectionOf, the
   * resolved conjunct members (B, C, …). Present ⇒ dropConjunct weakenings are
   * enumerated. The `object` field is then the intersection's blank/IRI node.
   */
  intersectionMembers?: string[];
  /**
   * When the conjunction is instead expressed as MULTIPLE plain subClassOf
   * targets (A ⊑ B, A ⊑ C as two triples), the sibling targets so dropConjunct
   * can drop THIS axiom and keep the siblings. Each entry is one sibling
   * superclass IRI. Optional.
   */
  siblingTargets?: string[];
  /**
   * LACONIC culprit hint (Horridge et al. ISWC 2008). When the laconic
   * refinement of the justification identified that a SPECIFIC conjunct is the
   * precise culprit — e.g. for `A ⊑ B ⊓ C` the laconic part is `A ⊑ B`, so `B`
   * is the offending conjunct — this is that conjunct IRI. enumerateWeakenings
   * then PREFERS the weakening that drops exactly this conjunct (the minimal
   * thing to weaken), surfacing it first. Optional; absent ⇒ unchanged ranking.
   */
  laconicCulpritMember?: string;
}

/**
 * Enumerate logically-weaker replacements for a culprit `A rdfs:subClassOf D`.
 *
 * Operators:
 *  - GENERALISE: for each named proper superclass D′ of D in the hierarchy,
 *    emit `A ⊑ D′` (weaker since D ⊑ D′). Ranked most-specific-first by hop
 *    distance. The chain terminates with the trivial `A ⊑ owl:Thing`, which is
 *    a tautology ≡ deleting the constraint (always offered last as the maximal
 *    weakening so callers can show the full spectrum).
 *  - DROP CONJUNCT: when D is an intersection (intersectionMembers) emit one
 *    `A ⊑ Bi` per surviving conjunct; when the conjunction is sibling
 *    subClassOf targets, drop THIS axiom (adds nothing — the siblings remain).
 *
 * Returns candidates ordered LEAST-WEAKENING (most knowledge preserved) FIRST.
 * Deduplicated by weakerTarget. Pure & deterministic.
 */
export function enumerateWeakenings(
  culprit: CulpritAxiom,
  hierarchy: ClassHierarchy,
  options: { direct?: Map<string, Set<string>>; includeThing?: boolean } = {},
): WeakeningCandidate[] {
  if (!isSubClassOf(culprit.predicate)) return [];
  const { includeThing = true } = options;

  const A = culprit.subject;
  const Alabel = localName(A);
  const candidates: WeakeningCandidate[] = [];
  const seenTargets = new Set<string>();

  const originalTriple = (): WeakeningTriple => ({
    subject: A,
    predicate: RDFS_SUBCLASS_OF,
    object: culprit.object,
    ...(culprit.graph ? { graph: culprit.graph } : {}),
  });

  // --- Operator 2: DROP A CONJUNCT (intersection or sibling targets) ---------
  if (culprit.intersectionMembers && culprit.intersectionMembers.length > 1) {
    const D = culprit.object;
    const Dlabel = localName(D);

    // LACONIC-PREFERRED dropConjunct (Horridge et al. ISWC 2008). When the
    // laconic refinement pinpointed the offending conjunct, the MINIMAL weakening
    // is to drop EXACTLY that conjunct and keep every other — a single, most-
    // knowledge-preserving step. Emit it first (specificityRank 0) so it ranks
    // ahead of the per-member "keep only Bi" candidates below.
    const culpritMember = culprit.laconicCulpritMember;
    if (
      culpritMember &&
      culprit.intersectionMembers.includes(culpritMember) &&
      culprit.intersectionMembers.length > 1
    ) {
      const survivors = culprit.intersectionMembers.filter((m) => m !== culpritMember);
      if (survivors.length > 0) {
        const survivorKey = survivors.join('|');
        if (!seenTargets.has(survivorKey)) {
          seenTargets.add(survivorKey);
          candidates.push({
            strategy: 'dropConjunct',
            removes: [originalTriple()],
            adds: survivors.map((m) => ({
              subject: A,
              predicate: RDFS_SUBCLASS_OF,
              object: m,
              ...(culprit.graph ? { graph: culprit.graph } : {}),
            })),
            weakerTarget: survivors[0],
            // 0 ⇒ ranks ahead of every other weakening (the laconic-precise fix).
            specificityRank: 0,
            rationale:
              `Weaken ${Alabel} ⊑ ${Dlabel} (an intersection) by dropping the ` +
              `LACONIC culprit conjunct ${localName(culpritMember)} — the precise ` +
              `part driving the clash (Horridge et al. ISWC 2008) — and keeping ` +
              `${survivors.map(localName).join(' ⊓ ')}; the most knowledge-preserving fix.`,
            weakerThan: `${Alabel} ⊑ ${Dlabel}`,
          });
        }
      }
    }

    // Each surviving single member becomes the weaker target: A ⊑ Bi.
    culprit.intersectionMembers.forEach((member) => {
      if (seenTargets.has(member)) return;
      seenTargets.add(member);
      candidates.push({
        strategy: 'dropConjunct',
        removes: [originalTriple()],
        adds: [
          {
            subject: A,
            predicate: RDFS_SUBCLASS_OF,
            object: member,
            ...(culprit.graph ? { graph: culprit.graph } : {}),
          },
        ],
        weakerTarget: member,
        // Dropping a conjunct is a single, very-specific weakening step.
        specificityRank: 1,
        rationale:
          `Weaken ${Alabel} ⊑ ${Dlabel} (an intersection) to ${Alabel} ⊑ ${localName(member)} ` +
          `by dropping the other conjunct(s) — preserves ${Alabel} ⊑ ${localName(member)} ` +
          `instead of deleting the whole subclass axiom.`,
        weakerThan: `${Alabel} ⊑ ${Dlabel}`,
      });
    });
  } else if (culprit.siblingTargets && culprit.siblingTargets.length > 0) {
    // A ⊑ B ⊓ C expressed as separate triples (A⊑B, A⊑C). Dropping THIS axiom
    // (A ⊑ D) keeps the siblings — adds nothing.
    const D = culprit.object;
    const Dlabel = localName(D);
    const siblingsLabel = culprit.siblingTargets.map(localName).join(' ⊓ ');
    candidates.push({
      strategy: 'dropConjunct',
      removes: [originalTriple()],
      adds: [],
      weakerTarget: OWL_THING,
      specificityRank: 1,
      rationale:
        `Weaken ${Alabel} ⊑ ${siblingsLabel} ⊓ ${Dlabel} to ${Alabel} ⊑ ${siblingsLabel} ` +
        `by dropping the conjunct ${Dlabel} — keeps the sibling constraint(s) ` +
        `instead of deleting them all.`,
      weakerThan: `${Alabel} ⊑ ${Dlabel}`,
    });
  }

  // --- Operator 1: GENERALISE THE SUPERCLASS ---------------------------------
  // Only meaningful when the object is a NAMED class (not an intersection node).
  if (!culprit.intersectionMembers || culprit.intersectionMembers.length === 0) {
    const D = culprit.object;
    const Dlabel = localName(D);
    const sups = hierarchy.superclasses.get(D) ?? new Set<string>();
    const direct = options.direct;

    const ranked = [...sups]
      .filter((d) => d !== D && d !== OWL_THING)
      .map((d) => ({
        target: d,
        rank: direct ? hopDistance(direct, D, d) : 1,
      }))
      // most-specific (smallest hop) first, then stable lexicographic
      .sort((x, y) => (x.rank !== y.rank ? x.rank - y.rank : x.target < y.target ? -1 : 1));

    ranked.forEach(({ target, rank }) => {
      if (seenTargets.has(target)) return;
      seenTargets.add(target);
      candidates.push({
        strategy: 'generalize',
        removes: [originalTriple()],
        adds: [
          {
            subject: A,
            predicate: RDFS_SUBCLASS_OF,
            object: target,
            ...(culprit.graph ? { graph: culprit.graph } : {}),
          },
        ],
        weakerTarget: target,
        specificityRank: rank + 1, // +1 so it always ranks after a dropConjunct(1)
        rationale:
          `Weaken ${Alabel} ⊑ ${Dlabel} to ${Alabel} ⊑ ${localName(target)} ` +
          `(${localName(target)} ⊒ ${Dlabel}; logically weaker) — preserves ` +
          `${Alabel} ⊑ ${localName(target)} instead of deleting the axiom.`,
        weakerThan: `${Alabel} ⊑ ${Dlabel}`,
      });
    });

    // Trivial fallback: A ⊑ owl:Thing ≡ deleting the constraint. Offered LAST as
    // the maximal weakening so the full spectrum (specific → general → delete)
    // is visible. Skipped only when explicitly disabled.
    if (includeThing && !seenTargets.has(OWL_THING)) {
      seenTargets.add(OWL_THING);
      candidates.push({
        strategy: 'generalize',
        removes: [originalTriple()],
        adds: [], // A ⊑ owl:Thing is a tautology — add nothing (≡ deletion).
        weakerTarget: OWL_THING,
        specificityRank: Number.MAX_SAFE_INTEGER,
        rationale:
          `Weaken ${Alabel} ⊑ ${Dlabel} to ${Alabel} ⊑ owl:Thing — a tautology, ` +
          `equivalent to DELETING the axiom (maximal weakening; preserves nothing ` +
          `about ${Dlabel}). Prefer a more specific weakening above when available.`,
        weakerThan: `${Alabel} ⊑ ${Dlabel}`,
      });
    }
  }

  // Final ordering: least-weakening (smallest specificityRank) first; ties by
  // a stable target order for full determinism.
  candidates.sort((a, b) =>
    a.specificityRank !== b.specificityRank
      ? a.specificityRank - b.specificityRank
      : a.weakerTarget < b.weakerTarget
        ? -1
        : a.weakerTarget > b.weakerTarget
          ? 1
          : 0,
  );

  return candidates;
}

/**
 * Convenience: build the direct-edge map from raw subClassOf edges, for callers
 * that want hop-distance ranking (enumerateWeakenings(..., { direct })).
 */
export function buildDirectEdgeMap(
  subClassEdges: Array<{ sub: string; sup: string }>,
): Map<string, Set<string>> {
  const direct = new Map<string, Set<string>>();
  for (const { sub, sup } of subClassEdges) {
    if (!sub || !sup || sub === sup || sup === OWL_THING) continue;
    let set = direct.get(sub);
    if (!set) {
      set = new Set<string>();
      direct.set(sub, set);
    }
    set.add(sup);
  }
  return direct;
}
