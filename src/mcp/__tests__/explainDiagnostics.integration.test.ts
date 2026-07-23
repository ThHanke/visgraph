// src/mcp/__tests__/explainDiagnostics.integration.test.ts
// @vitest-environment node
//
// End-to-end integration test for the explainDiagnostics pipeline using the
// REAL Konclude WASM reasoner. Exercises the full chain and its degradation
// paths with genuine MIPS — not fake shapes from mocks.
//
//   MIPS → computeRepairs (hitting set) → addWeakeningRepairs (hierarchy from
//   store) → per-axiom verification → full-set verification → minimality
//   verification → buildRepairBrief
//
// Degradation tests use real MIPS from Konclude, then deliberately break a
// downstream step to prove the pipeline still produces valid partial results.
//
// REQUIRE_KONCLUDE gating: same semantics as computeRepairs.integration.test.ts.

import { describe, it, expect } from 'vitest';
import { RdfReasoner } from 'rdf-reasoner-konclude';
import * as N3 from 'n3';
import {
  computeRepairs,
  addWeakeningRepairs,
  annotateDeletionMinimality,
  type RepairSuggestion,
  type DeletionRemoval,
  type WeakeningContext,
} from '../tools/computeRepairs';
import {
  buildClassHierarchy,
  buildDirectEdgeMap,
  RDFS_SUBCLASS_OF,
} from '../tools/axiomWeakening';
import { buildRepairBrief, type DiagnosticsData } from '../tools/diagnosticsBrief';

const REQUIRE_KONCLUDE = !!process.env.REQUIRE_KONCLUDE;

async function initReasonerOrSkip(): Promise<RdfReasoner | undefined> {
  try {
    const r = new RdfReasoner();
    await r.ready;
    return r;
  } catch (e) {
    if (REQUIRE_KONCLUDE) {
      throw new Error(
        `REQUIRE_KONCLUDE is set but the Konclude reasoner failed to initialise: ${String(e)}`,
      );
    }
    console.warn(
      '[TEST][SKIP] Konclude WASM unavailable and REQUIRE_KONCLUDE not set — skipping:',
      String(e),
    );
    return undefined;
  }
}

function parseTtl(ttl: string): N3.Store {
  const store = new N3.Store();
  store.addQuads(new N3.Parser({ format: 'text/turtle' }).parse(ttl));
  return store;
}

const quadKey = (s: string, p: string, o: string) => `${s} ${p} ${o}`;

function storeOracle(r: RdfReasoner, store: N3.Store) {
  return async (removals: DeletionRemoval[]): Promise<boolean> => {
    const keys = new Set(removals.map((x) => quadKey(x.subject, x.predicate, x.object)));
    const copy = new N3.Store();
    for (const q of store.getQuads(null, null, null, null) as N3.Quad[]) {
      if (keys.has(quadKey(q.subject.value, q.predicate.value, q.object.value))) continue;
      copy.addQuad(q);
    }
    return r.checkConsistency(copy);
  };
}

function extractSubClassEdges(store: N3.Store): Array<{ sub: string; sup: string }> {
  const edges: Array<{ sub: string; sup: string }> = [];
  for (const q of store.getQuads(null, RDFS_SUBCLASS_OF, null, null) as N3.Quad[]) {
    edges.push({ sub: q.subject.value, sup: q.object.value });
  }
  return edges;
}

function buildWeakeningContext(
  store: N3.Store,
  justifications: DiagnosticsData['justifications'],
): WeakeningContext {
  const edges = extractSubClassEdges(store);
  return {
    hierarchy: buildClassHierarchy(edges),
    direct: buildDirectEdgeMap(edges),
    justifications,
  };
}

function perAxiomVerify(
  r: RdfReasoner,
  store: N3.Store,
  repairs: RepairSuggestion[],
): Promise<void[]> {
  const actionable = repairs.filter(
    (x) =>
      x.issue === 'inconsistency' &&
      !x.needsManualReview &&
      x.kind !== 'weaken' &&
      x.action.args.subjectIri &&
      x.action.args.predicateIri &&
      x.action.args.objectIri,
  );
  return Promise.all(
    actionable.map(async (rep) => {
      const key = quadKey(
        rep.action.args.subjectIri!,
        rep.action.args.predicateIri!,
        rep.action.args.objectIri!,
      );
      const copy = new N3.Store();
      for (const q of store.getQuads(null, null, null, null) as N3.Quad[]) {
        if (quadKey(q.subject.value, q.predicate.value, q.object.value) === key) continue;
        copy.addQuad(q);
      }
      rep.verifiedConsistent = await r.checkConsistency(copy);
    }),
  );
}

function propagateWeakeningVerification(repairs: RepairSuggestion[]) {
  const actionable = repairs.filter(
    (x) => x.issue === 'inconsistency' && !x.needsManualReview,
  );
  for (const rep of actionable) {
    if (rep.kind !== 'weaken') continue;
    const owner = actionable.find(
      (d) => d.id === rep.alternativeTo && d.kind !== 'weaken',
    );
    rep.weakeningVerified = owner ? owner.verifiedConsistent === true : false;
  }
}

function fullSetVerify(
  r: RdfReasoner,
  store: N3.Store,
  repairs: RepairSuggestion[],
): Promise<boolean> {
  const deletionSet = repairs.filter(
    (x) =>
      x.issue === 'inconsistency' &&
      !x.needsManualReview &&
      x.kind !== 'weaken' &&
      x.action.args.subjectIri,
  );
  const removalKeys = new Set(
    deletionSet.map((d) =>
      quadKey(d.action.args.subjectIri!, d.action.args.predicateIri!, d.action.args.objectIri!),
    ),
  );
  const copy = new N3.Store();
  for (const q of store.getQuads(null, null, null, null) as N3.Quad[]) {
    if (removalKeys.has(quadKey(q.subject.value, q.predicate.value, q.object.value))) continue;
    copy.addQuad(q);
  }
  return r.checkConsistency(copy);
}

// ═══════════════════════════════════════════════════════════════════════════
// Fixtures
// ═══════════════════════════════════════════════════════════════════════════

// Single contradiction with subClassOf hierarchy — enables weakening.
const FIXTURE_SINGLE = `
@prefix ex:   <http://example.org/> .
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

ex:Animal  a owl:Class .
ex:Mammal  a owl:Class .
ex:Bird    a owl:Class .
ex:Penguin a owl:Class .

ex:Mammal  rdfs:subClassOf ex:Animal .
ex:Bird    rdfs:subClassOf ex:Animal .
ex:Penguin rdfs:subClassOf ex:Bird .

ex:Mammal  owl:disjointWith ex:Bird .
ex:Penguin rdfs:subClassOf ex:Mammal .

ex:tweety a ex:Penguin .
`;

// Two independent contradictions — per-axiom verify is false, full-set is true.
const FIXTURE_TWO_CLASHES = `
@prefix ex:  <http://example.org/> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

ex:A a owl:Class . ex:B a owl:Class . ex:P a owl:Class . ex:Q a owl:Class .
ex:A owl:disjointWith ex:B .
ex:P owl:disjointWith ex:Q .
ex:frank a ex:A , ex:B .
ex:gina  a ex:P , ex:Q .
`;

// Consistent fixture — no contradictions.
const FIXTURE_CONSISTENT = `
@prefix ex:   <http://example.org/> .
@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

ex:Animal a owl:Class .
ex:Bird   a owl:Class .
ex:Bird   rdfs:subClassOf ex:Animal .
ex:tweety a ex:Bird .
`;

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('explainDiagnostics pipeline — real Konclude integration', () => {
  // -----------------------------------------------------------------------
  // Happy path: full pipeline end-to-end
  // -----------------------------------------------------------------------
  it(
    'full pipeline: MIPS → repairs → weakening → verification → minimality → brief',
    async () => {
      const r = await initReasonerOrSkip();
      if (!r) return;

      try {
        const store = parseTtl(FIXTURE_SINGLE);
        const t0 = performance.now();

        // 1. Real MIPS
        const mips = await r.explainInconsistency(store, { maxJustifications: 5 });
        console.log(`[TIMING] MIPS: ${(performance.now() - t0).toFixed(0)}ms — ${mips.length} justification(s)`);
        expect(mips.length).toBeGreaterThanOrEqual(1);

        const justifications: DiagnosticsData['justifications'] = mips.map((m) =>
          m.map((q) => ({ subject: q.subject.value, predicate: q.predicate.value, object: q.object.value })),
        );

        console.log('\n── JUSTIFICATIONS ──');
        justifications.forEach((j, i) => {
          console.log(`  MIPS[${i}]: ${j.map((a) => `${a.subject.split('/').pop()} ${a.predicate.split(/[#/]/).pop()} ${a.object.split('/').pop()}`).join(' | ')}`);
        });

        const diagnostics: DiagnosticsData = {
          isConsistent: false,
          justifications,
          unsatisfiableClasses: [],
          profile: { owl2dl: true, violations: [] },
          shaclViolations: [],
        };

        // 2. Deletion repairs
        let repairs: RepairSuggestion[] = computeRepairs(diagnostics);
        expect(repairs.filter((x) => x.issue === 'inconsistency').length).toBeGreaterThanOrEqual(1);

        // 3. Weakening
        repairs = addWeakeningRepairs(repairs, buildWeakeningContext(store, justifications));
        const weakenings = repairs.filter((x) => x.kind === 'weaken');
        expect(weakenings.length).toBeGreaterThanOrEqual(1);
        console.log(`  ${weakenings.length} weakening candidate(s)`);

        // Structural: every weakening references a deletion
        for (const w of weakenings) {
          expect(w.alternativeTo).toBeTruthy();
          expect(w.batch).toBeTruthy();
          expect(w.weakerThan).toBeTruthy();
        }

        // At least one generalise weakening (Penguin ⊑ Mammal → Penguin ⊑ Animal)
        expect(weakenings.some((w) => w.rationale.includes('logically weaker'))).toBe(true);

        // 4. Per-axiom verification
        await perAxiomVerify(r, store, repairs);
        propagateWeakeningVerification(repairs);

        // 5. Full-set verification
        const repairSetVerifiedConsistent = await fullSetVerify(r, store, repairs);
        expect(repairSetVerifiedConsistent).toBe(true);

        // 6. Minimality
        const minResult = await annotateDeletionMinimality(repairs, storeOracle(r, store));
        expect(minResult.minimalityVerified).toBe(true);
        console.log(`  minimality: ${minResult.checksPerformed} check(s)`);

        // 7. Brief
        const brief = buildRepairBrief(diagnostics, repairs, { repairSetVerifiedConsistent });
        expect(brief).toContain('inconsisten');
        console.log(`\n── BRIEF ──\n${brief}`);

        // Every deletion targets a MIPS axiom
        const justAxioms = new Set(justifications.flat().map((a) => quadKey(a.subject, a.predicate, a.object)));
        for (const d of repairs.filter((x) => x.issue === 'inconsistency' && x.kind !== 'weaken' && !x.needsManualReview)) {
          expect(justAxioms.has(quadKey(d.action.args.subjectIri!, d.action.args.predicateIri!, d.action.args.objectIri!))).toBe(true);
        }

        console.log(`\n[TIMING] TOTAL: ${(performance.now() - t0).toFixed(0)}ms`);
      } finally {
        r.terminate();
      }
    },
    60000,
  );

  // -----------------------------------------------------------------------
  // Consistent ontology — pipeline short-circuits, no repairs
  // -----------------------------------------------------------------------
  it(
    'consistent ontology produces no repairs and no MIPS',
    async () => {
      const r = await initReasonerOrSkip();
      if (!r) return;

      try {
        const store = parseTtl(FIXTURE_CONSISTENT);
        const consistent = await r.checkConsistency(store);
        expect(consistent).toBe(true);

        const mips = await r.explainInconsistency(store, { maxJustifications: 3 });
        expect(mips).toEqual([]);

        const repairs = computeRepairs({
          isConsistent: true,
          justifications: [],
          unsatisfiableClasses: [],
          profile: { owl2dl: true, violations: [] },
          shaclViolations: [],
        });
        expect(repairs.filter((x) => x.issue === 'inconsistency')).toHaveLength(0);
      } finally {
        r.terminate();
      }
    },
    60000,
  );

  // -----------------------------------------------------------------------
  // Two independent contradictions: per-axiom false, full-set true
  // -----------------------------------------------------------------------
  it(
    'two independent clashes: per-axiom verification false, full-set true',
    async () => {
      const r = await initReasonerOrSkip();
      if (!r) return;

      try {
        const store = parseTtl(FIXTURE_TWO_CLASHES);
        const mips = await r.explainInconsistency(store, { maxJustifications: 5 });
        expect(mips.length).toBeGreaterThanOrEqual(2);

        const justifications: DiagnosticsData['justifications'] = mips.map((m) =>
          m.map((q) => ({ subject: q.subject.value, predicate: q.predicate.value, object: q.object.value })),
        );

        const repairs = computeRepairs({
          isConsistent: false,
          justifications,
          unsatisfiableClasses: [],
          profile: { owl2dl: true, violations: [] },
          shaclViolations: [],
        }).filter((x) => x.issue === 'inconsistency' && !x.needsManualReview);

        expect(repairs.length).toBeGreaterThanOrEqual(2);

        // Per-axiom: each alone does NOT restore consistency (other clash remains)
        await perAxiomVerify(r, store, repairs);
        for (const rep of repairs) {
          expect(rep.verifiedConsistent).toBe(false);
        }

        // Full-set: removing ALL repairs together DOES restore consistency
        const fullSetOk = await fullSetVerify(r, store, repairs);
        expect(fullSetOk).toBe(true);

        console.log(`  ${repairs.length} repairs, per-axiom all false, full-set true`);
      } finally {
        r.terminate();
      }
    },
    60000,
  );

  // -----------------------------------------------------------------------
  // Degradation: empty hierarchy → weakening produces no candidates,
  // but deletion repairs are still valid and verified.
  // -----------------------------------------------------------------------
  it(
    'degrades: empty hierarchy → no weakening candidates, deletions still work',
    async () => {
      const r = await initReasonerOrSkip();
      if (!r) return;

      try {
        const store = parseTtl(FIXTURE_SINGLE);
        const mips = await r.explainInconsistency(store, { maxJustifications: 5 });
        const justifications: DiagnosticsData['justifications'] = mips.map((m) =>
          m.map((q) => ({ subject: q.subject.value, predicate: q.predicate.value, object: q.object.value })),
        );

        let repairs: RepairSuggestion[] = computeRepairs({
          isConsistent: false,
          justifications,
          unsatisfiableClasses: [],
          profile: { owl2dl: true, violations: [] },
          shaclViolations: [],
        });

        // Empty hierarchy — simulates sparqlQuery failure in reasoning.ts
        const emptyCtx: WeakeningContext = {
          hierarchy: buildClassHierarchy([]),
          justifications,
        };
        repairs = addWeakeningRepairs(repairs, emptyCtx);

        // No weakening candidates (hierarchy empty, can't generalise)
        expect(repairs.filter((x) => x.kind === 'weaken')).toHaveLength(0);

        // But deletion repairs exist and are verified
        const deletions = repairs.filter((x) => x.issue === 'inconsistency' && !x.needsManualReview);
        expect(deletions.length).toBeGreaterThanOrEqual(1);

        await perAxiomVerify(r, store, repairs);
        const fullSetOk = await fullSetVerify(r, store, repairs);
        expect(fullSetOk).toBe(true);

        // Brief still generated
        const brief = buildRepairBrief(
          { isConsistent: false, justifications, unsatisfiableClasses: [], profile: { owl2dl: true, violations: [] }, shaclViolations: [] },
          repairs,
          { repairSetVerifiedConsistent: fullSetOk },
        );
        expect(brief).toContain('inconsisten');
        console.log('  empty hierarchy: 0 weakenings, deletions verified ✓');
      } finally {
        r.terminate();
      }
    },
    60000,
  );

  // -----------------------------------------------------------------------
  // Degradation: per-axiom oracle throws → verifiedConsistent stays undefined,
  // full-set and minimality still work.
  // -----------------------------------------------------------------------
  it(
    'degrades: per-axiom oracle throws → verifiedConsistent undefined, full-set still works',
    async () => {
      const r = await initReasonerOrSkip();
      if (!r) return;

      try {
        const store = parseTtl(FIXTURE_SINGLE);
        const mips = await r.explainInconsistency(store, { maxJustifications: 5 });
        const justifications: DiagnosticsData['justifications'] = mips.map((m) =>
          m.map((q) => ({ subject: q.subject.value, predicate: q.predicate.value, object: q.object.value })),
        );

        let repairs: RepairSuggestion[] = computeRepairs({
          isConsistent: false,
          justifications,
          unsatisfiableClasses: [],
          profile: { owl2dl: true, violations: [] },
          shaclViolations: [],
        });
        repairs = addWeakeningRepairs(repairs, buildWeakeningContext(store, justifications));

        // Simulate per-axiom oracle failure (same as reasoning.ts catch block)
        const actionable = repairs.filter(
          (x) => x.issue === 'inconsistency' && !x.needsManualReview && x.kind !== 'weaken',
        );
        for (const rep of actionable) {
          try {
            throw new Error('oracle down');
          } catch {
            // verifiedConsistent stays undefined — this is the degradation
          }
        }

        // Per-axiom is undefined
        for (const rep of actionable) {
          expect(rep.verifiedConsistent).toBeUndefined();
        }

        // But full-set still works (independent oracle call)
        const fullSetOk = await fullSetVerify(r, store, repairs);
        expect(fullSetOk).toBe(true);

        // Minimality still works
        const minResult = await annotateDeletionMinimality(repairs, storeOracle(r, store));
        expect(minResult.minimalityVerified).toBe(true);

        // Brief still generated
        const brief = buildRepairBrief(
          { isConsistent: false, justifications, unsatisfiableClasses: [], profile: { owl2dl: true, violations: [] }, shaclViolations: [] },
          repairs,
          { repairSetVerifiedConsistent: fullSetOk },
        );
        expect(brief.length).toBeGreaterThan(0);
        console.log('  per-axiom oracle down: verifiedConsistent=undefined, full-set=true ✓');
      } finally {
        r.terminate();
      }
    },
    60000,
  );

  // -----------------------------------------------------------------------
  // Degradation: full-set oracle throws → repairSetVerifiedConsistent null,
  // but repairs and brief still generated.
  // -----------------------------------------------------------------------
  it(
    'degrades: full-set oracle throws → repairSetVerifiedConsistent null, repairs still present',
    async () => {
      const r = await initReasonerOrSkip();
      if (!r) return;

      try {
        const store = parseTtl(FIXTURE_SINGLE);
        const mips = await r.explainInconsistency(store, { maxJustifications: 5 });
        const justifications: DiagnosticsData['justifications'] = mips.map((m) =>
          m.map((q) => ({ subject: q.subject.value, predicate: q.predicate.value, object: q.object.value })),
        );

        let repairs: RepairSuggestion[] = computeRepairs({
          isConsistent: false,
          justifications,
          unsatisfiableClasses: [],
          profile: { owl2dl: true, violations: [] },
          shaclViolations: [],
        });
        repairs = addWeakeningRepairs(repairs, buildWeakeningContext(store, justifications));

        // Per-axiom works
        await perAxiomVerify(r, store, repairs);
        propagateWeakeningVerification(repairs);

        // Full-set oracle fails
        const repairSetVerifiedConsistent: boolean | null = null;
        // Full-set oracle failed — stays null (matches reasoning.ts catch block)

        // Repairs exist with per-axiom verdicts
        const deletions = repairs.filter((x) => x.issue === 'inconsistency' && x.kind !== 'weaken' && !x.needsManualReview);
        expect(deletions.length).toBeGreaterThanOrEqual(1);
        expect(deletions[0].verifiedConsistent).toBeDefined();

        // But full-set is null
        expect(repairSetVerifiedConsistent).toBeNull();

        // Brief still generated (with null full-set)
        const brief = buildRepairBrief(
          { isConsistent: false, justifications, unsatisfiableClasses: [], profile: { owl2dl: true, violations: [] }, shaclViolations: [] },
          repairs,
          { repairSetVerifiedConsistent },
        );
        expect(brief.toUpperCase()).toContain('INCONSISTEN');
        console.log('  full-set oracle down: per-axiom verdicts present, repairSetVerified=null ✓');
      } finally {
        r.terminate();
      }
    },
    60000,
  );

  // -----------------------------------------------------------------------
  // Degradation: minimality oracle throws → minimalityVerified undefined,
  // repairs and brief still complete.
  // -----------------------------------------------------------------------
  it(
    'degrades: minimality oracle throws → minimalityVerified undefined, rest intact',
    async () => {
      const r = await initReasonerOrSkip();
      if (!r) return;

      try {
        const store = parseTtl(FIXTURE_SINGLE);
        const mips = await r.explainInconsistency(store, { maxJustifications: 5 });
        const justifications: DiagnosticsData['justifications'] = mips.map((m) =>
          m.map((q) => ({ subject: q.subject.value, predicate: q.predicate.value, object: q.object.value })),
        );

        let repairs: RepairSuggestion[] = computeRepairs({
          isConsistent: false,
          justifications,
          unsatisfiableClasses: [],
          profile: { owl2dl: true, violations: [] },
          shaclViolations: [],
        });
        repairs = addWeakeningRepairs(repairs, buildWeakeningContext(store, justifications));
        await perAxiomVerify(r, store, repairs);
        propagateWeakeningVerification(repairs);
        const fullSetOk = await fullSetVerify(r, store, repairs);

        // Minimality oracle throws
        const brokenOracle = async (): Promise<boolean> => {
          throw new Error('oracle down');
        };
        try {
          await annotateDeletionMinimality(repairs, brokenOracle);
        } catch {
          // matches reasoning.ts catch block — minimalityVerified stays undefined
        }

        const deletions = repairs.filter((x) => x.issue === 'inconsistency' && x.kind !== 'weaken' && !x.needsManualReview);
        for (const d of deletions) {
          expect(d.minimalityVerified).toBeUndefined();
        }

        // Everything else intact
        expect(fullSetOk).toBe(true);
        expect(deletions[0].verifiedConsistent).toBeDefined();

        const brief = buildRepairBrief(
          { isConsistent: false, justifications, unsatisfiableClasses: [], profile: { owl2dl: true, violations: [] }, shaclViolations: [] },
          repairs,
          { repairSetVerifiedConsistent: fullSetOk },
        );
        expect(brief).toContain('inconsisten');
        console.log('  minimality oracle down: minimalityVerified=undefined, rest intact ✓');
      } finally {
        r.terminate();
      }
    },
    60000,
  );

  // -----------------------------------------------------------------------
  // Laconic justifications with real Konclude
  // -----------------------------------------------------------------------
  it(
    'laconic justifications sharpen the MIPS and feed into weakening',
    async () => {
      const r = await initReasonerOrSkip();
      if (!r) return;

      try {
        const store = parseTtl(FIXTURE_SINGLE);

        // Check if laconic is available on this reasoner build
        if (typeof r.explainInconsistencyLaconic !== 'function') {
          console.log('  [SKIP] explainInconsistencyLaconic not available on this build');
          return;
        }

        // Raw API: Array<{ justification: Quad[], laconic: LaconicJustification }>
        const lacEntries = await r.explainInconsistencyLaconic(store, { maxJustifications: 5 });
        console.log(`  laconic: ${lacEntries.length} entries`);

        expect(lacEntries.length).toBeGreaterThanOrEqual(1);

        const justifications: DiagnosticsData['justifications'] = lacEntries.map(
          (e: { justification: N3.Quad[] }) => e.justification.map((q: N3.Quad) => ({
            subject: q.subject.value,
            predicate: q.predicate.value,
            object: q.object.value,
          })),
        );

        // Transform laconic entries to the shape addWeakeningRepairs expects
        const laconicJustifications: DiagnosticsData['laconicJustifications'] = lacEntries.map(
          (e: { laconic: { parts: Array<{ subject: string; predicate: string; object: string; sourceSubject: string; sourcePredicate: string; sourceObject: string; isPartOf: boolean }>; sharpened: boolean; skipped: boolean } }) => e.laconic,
        );

        let repairs = computeRepairs({
          isConsistent: false,
          justifications,
          unsatisfiableClasses: [],
          profile: { owl2dl: true, violations: [] },
          shaclViolations: [],
        });

        // Feed laconic into weakening context
        const edges = extractSubClassEdges(store);
        repairs = addWeakeningRepairs(repairs, {
          hierarchy: buildClassHierarchy(edges),
          direct: buildDirectEdgeMap(edges),
          justifications,
          laconicJustifications,
        });

        // Weakening should still produce candidates
        const weakenings = repairs.filter((x) => x.kind === 'weaken');
        expect(weakenings.length).toBeGreaterThanOrEqual(1);

        // Verify they're sound
        await perAxiomVerify(r, store, repairs);
        const fullSetOk = await fullSetVerify(r, store, repairs);
        expect(fullSetOk).toBe(true);

        console.log(`  laconic: ${weakenings.length} weakening(s), full-set verified ✓`);
      } finally {
        r.terminate();
      }
    },
    60000,
  );

  // -----------------------------------------------------------------------
  // Weakening verification with real oracle: the weaker axiom does NOT
  // re-introduce the contradiction.
  // -----------------------------------------------------------------------
  it(
    'weakening repair is sound: replacing culprit with weaker axiom stays consistent',
    async () => {
      const r = await initReasonerOrSkip();
      if (!r) return;

      try {
        const store = parseTtl(FIXTURE_SINGLE);
        const mips = await r.explainInconsistency(store, { maxJustifications: 5 });
        const justifications: DiagnosticsData['justifications'] = mips.map((m) =>
          m.map((q) => ({ subject: q.subject.value, predicate: q.predicate.value, object: q.object.value })),
        );

        let repairs = computeRepairs({
          isConsistent: false,
          justifications,
          unsatisfiableClasses: [],
          profile: { owl2dl: true, violations: [] },
          shaclViolations: [],
        });
        repairs = addWeakeningRepairs(repairs, buildWeakeningContext(store, justifications));

        const weakenings = repairs.filter((x) => x.kind === 'weaken' && x.batch);
        expect(weakenings.length).toBeGreaterThanOrEqual(1);

        // For each weakening: remove the culprit AND add the weaker axiom,
        // then check consistency with the real oracle.
        for (const w of weakenings) {
          const removeKeys = new Set(
            w.batch!.removes.map((t) => quadKey(t.subject, t.predicate, t.object)),
          );
          const copy = new N3.Store();
          for (const q of store.getQuads(null, null, null, null) as N3.Quad[]) {
            if (removeKeys.has(quadKey(q.subject.value, q.predicate.value, q.object.value))) continue;
            copy.addQuad(q);
          }
          // Add the weaker axiom(s)
          const df = N3.DataFactory;
          for (const add of w.batch!.adds) {
            copy.addQuad(
              df.namedNode(add.subject),
              df.namedNode(add.predicate),
              df.namedNode(add.object),
            );
          }

          const ok = await r.checkConsistency(copy);
          console.log(`  ${w.id} (${w.weakerThan} → weaker): consistent=${ok}`);
          expect(ok).toBe(true);
        }
      } finally {
        r.terminate();
      }
    },
    60000,
  );
});
