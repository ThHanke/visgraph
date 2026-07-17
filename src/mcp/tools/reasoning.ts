// src/mcp/tools/reasoning.ts
import type { McpTool, McpResult } from '@/mcp/types';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';
import { useAppConfigStore } from '@/stores/appConfigStore';
import { VALID_ALGORITHMS } from './layout';
import { rdfManager } from '@/utils/rdfManager';
import { buildRepairBrief, type DiagnosticsData } from './diagnosticsBrief';
// TODO(rdf-reasoner-konclude): replace local computeRepairs/axiomWeakening with
// reasoner API once repair/weakening endpoints land (plan-050 deferred scope).
import {
  computeRepairs,
  addWeakeningRepairs,
  annotateDeletionMinimality,
  type RepairSuggestion,
  type WeakeningContext,
  type DeletionRemoval,
} from './computeRepairs';
import { buildClassHierarchy, buildDirectEdgeMap } from './axiomWeakening';
import type { VerifyRepairRemoval } from '@/utils/rdfManager';
const EXPORT_FORMATS = ['turtle', 'jsonld', 'rdfxml', 'svg', 'png'];

const DATA_GRAPH = 'urn:vg:data';

/**
 * BUG B: project a computed repair into a verifyRepair removal, carrying the
 * object-term metadata (termType/datatype/language) and source graph that
 * computeRepairs threaded from the MIPS. This makes VERIFY exclude the IDENTICAL
 * triple the apply path (removeLink) removes — preventing a false
 * `verifiedConsistent` against a same-lexical sibling in another graph/datatype.
 * Optional fields are only set when present (back-compat: a bare s/p/o repair
 * verifies with the legacy lexical/all-graph match).
 */
function repairToRemoval(r: RepairSuggestion): VerifyRepairRemoval {
  const a = r.action.args;
  return {
    subject: a.subjectIri!,
    predicate: a.predicateIri!,
    object: a.objectIri!,
    ...(a.objectTermType ? { objectTermType: a.objectTermType } : {}),
    ...(a.objectDatatype ? { objectDatatype: a.objectDatatype } : {}),
    ...(a.objectLanguage ? { objectLanguage: a.objectLanguage } : {}),
    ...(a.graph ? { graph: a.graph } : {}),
  };
}


const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const OWL_INTERSECTION_OF = 'http://www.w3.org/2002/07/owl#intersectionOf';
const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';
const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';
const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';

/**
 * Read the classified class subsumption hierarchy (asserted + inferred
 * rdfs:subClassOf) plus any owl:intersectionOf definitions, to drive axiom
 * weakening. sparqlQuery runs with unionDefaultGraph:true so a plain BGP matches
 * urn:vg:data + urn:vg:ontologies + urn:vg:inferred — i.e. the FULL classified
 * hierarchy after reasoning. Returns the WeakeningContext computeRepairs needs.
 *
 * Best-effort: on any query failure returns an empty hierarchy (weakening simply
 * yields no candidates and the agent still gets the deletion repairs).
 */
async function loadWeakeningContext(): Promise<WeakeningContext> {
  const empty: WeakeningContext = { hierarchy: buildClassHierarchy([]) };
  try {
    // 1. All subClassOf edges with NAMED (IRI) super- and sub-classes.
    const subRes = await rdfManager.sparqlQuery(
      `SELECT ?sub ?sup WHERE { ?sub <${RDFS_SUBCLASS_OF}> ?sup . FILTER(isIRI(?sub) && isIRI(?sup)) }`,
      { limit: 5000 },
    );
    const edges: Array<{ sub: string; sup: string }> = [];
    if (subRes?.type === 'select' && Array.isArray(subRes.rows)) {
      for (const row of subRes.rows as Array<Record<string, string>>) {
        if (row.sub && row.sup) edges.push({ sub: row.sub, sup: row.sup });
      }
    }

    // 2. owl:intersectionOf definitions: map the class/intersection node to its
    //    resolved NAMED conjunct members (RDF list walk). Only named members are
    //    usable as drop-conjunct weakening targets.
    const intersections = new Map<string, string[]>();
    try {
      const intRes = await rdfManager.sparqlQuery(
        `SELECT ?node ?member WHERE {
           ?node <${OWL_INTERSECTION_OF}> ?list .
           ?list <${RDF_FIRST}>* /  <${RDF_REST}>* ?cell .
           ?cell <${RDF_FIRST}> ?member .
           FILTER(isIRI(?member))
         }`,
        { limit: 5000 },
      );
      if (intRes?.type === 'select' && Array.isArray(intRes.rows)) {
        for (const row of intRes.rows as Array<Record<string, string>>) {
          if (!row.node || !row.member) continue;
          if (row.member === RDF_NIL) continue;
          const arr = intersections.get(row.node) ?? [];
          if (!arr.includes(row.member)) arr.push(row.member);
          intersections.set(row.node, arr);
        }
      }
    } catch {
      // intersection resolution is optional — generalise-only weakening still works.
    }

    return {
      hierarchy: buildClassHierarchy(edges),
      direct: buildDirectEdgeMap(edges),
      ...(intersections.size > 0 ? { intersections } : {}),
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// runReasoning
// ---------------------------------------------------------------------------
const runReasoning: McpTool = {
  name: 'runReasoning',
  description: "Run OWL reasoning over the loaded graph and infer new triples. Default backend is 'konclude' (full OWL 2 DL). Pass reasonerBackend='n3' to use N3 rule-based inference instead. Pass clearBefore=true to clear previous inferences first. SHACL validation runs by default after reasoning if shapes are loaded (shaclValidation=true); pass shaclValidation=false to skip it. Response: { inferredTriples, isConsistent: boolean|null, errors: ReasoningError[] }. isConsistent=false means the ontology is logically contradictory — inferences were skipped and errors contains per-entity clash details (nodeId: individual IRI, rule, message). isConsistent=null when using the n3 backend or when validation was unavailable.",
  inputSchema: {
    type: 'object',
    properties: {
      clearBefore: { type: 'boolean', default: false },
      reasonerBackend: { type: 'string', enum: ['konclude', 'n3'], description: "Reasoning backend: 'konclude' (OWL 2 DL, default) or 'n3' (N3 rule-based)" },
      shaclValidation: { type: 'boolean', default: true, description: 'Run SHACL validation after reasoning (default true). Pass false to skip.' },
    },
  },
  async handler(params): Promise<McpResult> {
    try {
      const { clearBefore = false, reasonerBackend, shaclValidation = true } = (params ?? {}) as { clearBefore?: boolean; reasonerBackend?: 'konclude' | 'n3'; shaclValidation?: boolean };
      const refs = getWorkspaceRefs();

      if (clearBefore) {
        if (refs.clearInferred) {
          refs.clearInferred();
        } else {
          refs.dataProvider.clearInferred();
        }
      }

      const prevShaclEnabled = useAppConfigStore.getState().config.shaclEnabled;
      if (shaclValidation !== prevShaclEnabled) {
        useAppConfigStore.getState().setShaclEnabled(shaclValidation);
      }

      const backend = reasonerBackend === 'n3' ? 'n3' : reasonerBackend === 'konclude' ? 'konclude' : undefined;
      let result: unknown;
      try {
        result = await refs.runReasoning?.(backend);
      } finally {
        if (shaclValidation !== prevShaclEnabled) {
          useAppConfigStore.getState().setShaclEnabled(prevShaclEnabled);
        }
      }
      const inferredTriples = (result as any)?.meta?.addedCount ?? (result as any)?.inferences?.length ?? 0;

      return {
        success: true,
        data: {
          inferredTriples,
          isConsistent: (result as any)?.isConsistent ?? null,
          errors: ((result as any)?.errors ?? []).map((e: any) => ({
            nodeId: e.nodeId ?? null,
            rule: e.rule ?? 'unknown',
            severity: e.severity ?? 'error',
            message: e.message ?? '',
          })),
        },
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// clearInferred
// ---------------------------------------------------------------------------
const clearInferred: McpTool = {
  name: 'clearInferred',
  description: 'Remove all inferred (reasoned) triples from the graph.',
  inputSchema: {
    type: 'object',
  },
  async handler(): Promise<McpResult> {
    try {
      const refs = getWorkspaceRefs();
      if (refs.clearInferred) {
        refs.clearInferred();
      } else {
        await refs.dataProvider.clearInferred();
      }
      return { success: true, data: { cleared: true } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// getCapabilities
// ---------------------------------------------------------------------------
const getCapabilities: McpTool = {
  name: 'getCapabilities',
  description: 'Return the supported layout algorithms and export formats.',
  inputSchema: {
    type: 'object',
  },
  async handler(): Promise<McpResult> {
    try {
      return {
        success: true,
        data: {
          layoutAlgorithms: [...VALID_ALGORITHMS],
          exportFormats: EXPORT_FORMATS,
          reasonerBackends: ['konclude', 'n3'],
        },
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// explainDiagnostics
// ---------------------------------------------------------------------------
const explainDiagnostics: McpTool = {
  name: 'explainDiagnostics',
  description:
    "Run the full symbolic verifier (OWL 2 DL reasoning + SHACL) and return ONE structured, actionable diagnosis of everything wrong with the current graph. " +
    "Use this to decide what to fix after authoring. Response: { isConsistent, justifications, laconicJustifications, unsatisfiableClasses, profile, shaclViolations, repairBrief, suggestedRepairs }. " +
    "isConsistent=false means a logical contradiction: `justifications` lists each minimal set of axioms (MIPS) causing it — remove or revise one axiom per set. " +
    "`laconicJustifications` (Horridge, Parsia & Sattler, ISWC 2008) is the superfluous-part-free refinement of `justifications`, aligned by index: each entry pinpoints the precise culprit axiom PART (e.g. the `A ⊑ B` part of `A ⊑ B ⊓ C`) via parts[] (each part carrying its source axiom as sourceSubject/sourcePredicate/sourceObject), with `sharpened` (a superfluous part was dropped) and `skipped` (a cost cap suppressed laconic for that MIPS — parts then equal the whole axioms). The repairBrief surfaces the precise culprit and the axiom-weakening repairs prefer dropping exactly the laconic culprit conjunct. " +
    "`unsatisfiableClasses` are classes that can never have instances (best-effort). `profile` reports OWL 2 profile analysis: the legacy DL sanity check (owl2dl + violations, e.g. a literal on an object property) PLUS structural EL/QL/RL detection (el/ql/rl each { valid, violations:[{construct,axiom,reason}] }) and `mostRestrictive` (EL|QL|RL|DL|Full) — the tightest profile the ontology fits, indicating whether a cheaper profile-specific reasoner suffices. " +
    "`shaclViolations` are data-shape conformance failures. `repairBrief` is a ranked plain-language summary you can act on directly. " +
    "`suggestedRepairs` is a ranked list of EXECUTABLE reasoner-computed fixes, each { id, issue, kind?, action:{tool,args}, batch?, weakerThan?, alternativeTo?, weakeningVerified?, rationale, verifiedConsistent?, verifiedSet?, justificationsCovered?, needsValue?, needsManualReview? }: " +
    "for inconsistencies the DELETION repairs (kind:'delete') form a minimal hitting set over the MIPS — removing the WHOLE set restores consistency. AXIOM WEAKENING repairs (kind:'weaken', ids W1,W2,…) are a LESS-destructive alternative (Troquard et al. AAAI 2018; Li & Lambrix ISWC 2024): for an rdfs:subClassOf culprit A ⊑ D they replace it with a weaker A ⊑ D′ (D′ ⊒ D) or drop a conjunct — apply via batch:{removes,adds}; prefer weakening over deletion to preserve more knowledge. verifiedConsistent:true ⇒ removing that ONE axiom alone restores consistency; with multiple independent contradictions it is commonly false for every repair (means 'not ALONE', not 'wrong'). " +
    "Trust the top-level `repairSetVerifiedConsistent` / per-repair `verifiedSet` (the full set together) and apply the entire set. needsManualReview:true ⇒ no auto-repair (inspect manually). " +
    "Apply each by calling its action.tool (always removeLink for inconsistency repairs) with action.args. Read-only: never mutates asserted data.",
  inputSchema: {
    type: 'object',
    properties: {
      maxJustifications: {
        type: 'number',
        default: 3,
        description: 'Maximum number of independent inconsistency justifications (MIPS) to return when inconsistent.',
      },
    },
  },
  async handler(params): Promise<McpResult> {
    try {
      const { maxJustifications = 3 } = (params ?? {}) as { maxJustifications?: number };

      // 1. Run reasoning to compute consistency, classify, and run SHACL.
      const reasoning = await rdfManager.runReasoning();
      const isConsistent = (reasoning as { isConsistent?: boolean | null })?.isConsistent ?? null;

      // 2. Inconsistency justifications (only meaningful when inconsistent). We
      //    request the LACONIC refinement alongside the regular MIPS (Horridge
      //    et al. ISWC 2008): each laconic entry pinpoints the superfluous-part-
      //    free culprit PART (e.g. the `A ⊑ B` part of `A ⊑ B ⊓ C`), aligned by
      //    index with `justifications`. Non-breaking: `justifications` keeps its
      //    existing whole-axiom shape; `laconicJustifications` is purely additive.
      let justifications: DiagnosticsData['justifications'] = [];
      let laconicJustifications: DiagnosticsData['laconicJustifications'] = [];
      if (isConsistent === false) {
        // Prefer the laconic-enriched call (returns the regular MIPS PLUS the
        // superfluous-part-free refinement). Fall back to plain explainInconsistency
        // when the manager build / a test double does not expose the laconic method
        // (defensive: laconic is purely additive).
        if (typeof rdfManager.explainInconsistencyWithLaconic === 'function') {
          const incon = await rdfManager.explainInconsistencyWithLaconic(maxJustifications);
          justifications = incon.justifications;
          laconicJustifications = incon.laconicJustifications;
        } else {
          justifications = await rdfManager.explainInconsistency(maxJustifications);
        }
      }

      // 3. Unsatisfiable classes (Konclude classification — classes equivalent to owl:Nothing).
      let unsatisfiableClasses: string[] = [];
      try { unsatisfiableClasses = await rdfManager.getUnsatisfiableClasses(); } catch { unsatisfiableClasses = []; }

      // TODO(rdf-reasoner-konclude): profile/expressivity detection removed —
      // will be replaced by reasoner API: detectProfiles(store) returning
      // EL/QL/RL/DL classification per named graph with violations list.

      // 5. SHACL conformance.
      const shacl = await rdfManager.runShaclValidation();
      const shaclViolations = (shacl?.violations ?? []) as DiagnosticsData['shaclViolations'];

      const data: DiagnosticsData = {
        isConsistent,
        justifications,
        ...(laconicJustifications && laconicJustifications.length > 0
          ? { laconicJustifications }
          : {}),
        unsatisfiableClasses,
        shaclViolations,
      };

      // R1 — reasoner-computed repair suggestions. Compute ranked, executable
      // candidates from the symbolic diagnostics (minimal hitting set over the
      // MIPS + SHACL candidates), then symbolically VERIFY the inconsistency
      // candidates by re-running the consistency oracle on a store copy without
      // the removed axioms. Verification is read-only (operates on a copy).
      let suggestedRepairs: RepairSuggestion[] = computeRepairs(data);

      // R-weaken — AXIOM WEAKENING (Troquard et al. AAAI 2018; Li & Lambrix ISWC
      // 2024). For every deletion repair that targets an `A rdfs:subClassOf D`
      // axiom, ALSO offer logically-weaker replacements `A ⊑ D′` (D′ ⊒ D) or
      // drop-conjunct alternatives — less destructive than deletion. Reads the
      // classified hierarchy via sparqlQuery (urn:vg:inferred + asserted).
      if (isConsistent === false) {
        const wctx = await loadWeakeningContext();
        suggestedRepairs = addWeakeningRepairs(suggestedRepairs, {
          ...wctx,
          justifications,
          // LACONIC culprit hints (Horridge et al. ISWC 2008): let the weakening
          // enumerator prefer dropping the precise offending conjunct.
          ...(laconicJustifications && laconicJustifications.length > 0
            ? { laconicJustifications }
            : {}),
        });
      }

      // `repairSetVerifiedConsistent` is the paper-critical signal: does removing
      // the FULL hitting set at once restore global consistency? With multiple
      // disjoint contradictions no single removal does, so per-axiom checks are
      // all false even though the union IS valid (M2). null = not verified.
      let repairSetVerifiedConsistent: boolean | null = null;
      let repairSetMatchWarning: string | undefined;

      if (isConsistent === false) {
        // Executable inconsistency repairs (skip needsManualReview markers,
        // which have no axiom to remove).
        const actionable = suggestedRepairs.filter(
          (r) =>
            r.issue === 'inconsistency' &&
            !r.needsManualReview &&
            r.action.args.subjectIri &&
            r.action.args.predicateIri &&
            r.action.args.objectIri,
        );

        // 1. Per-axiom verification — meaning: does removing THIS axiom ALONE
        //    restore consistency? Commonly false with disjoint contradictions;
        //    it does NOT mean the repair is wrong (cross-ref verifiedSet).
        await Promise.all(
          actionable.map(async (r) => {
            try {
              // BUG B: thread the object-term + source graph so VERIFY targets the
              // IDENTICAL triple APPLY (removeLink) removes — not a same-lexical
              // sibling in another graph / with another datatype.
              r.verifiedConsistent = await rdfManager.verifyRepair([repairToRemoval(r)]);
            } catch {
              // Leave verifiedConsistent undefined when the oracle is unavailable.
            }
          }),
        );

        // 1b. WEAKENING verification (Troquard et al. 2018; Li & Lambrix 2024).
        //     A weakening repair removes `A ⊑ D` and ADDS the weaker `A ⊑ D′`
        //     (D′ ⊒ D). verifyRepair only takes REMOVALS, so we verify the
        //     removal side directly (does removing `A ⊑ D` restore consistency —
        //     reused from the per-axiom pass above). The ADD side is sound WITHOUT
        //     a separate oracle call: because D ⊑ D′, the added `A ⊑ D′` is
        //     ENTAILED by the very axiom we removed, so it introduces NO new
        //     constraint over the post-removal ontology — re-adding an entailment
        //     of a removed axiom cannot re-break a model that satisfied the
        //     removal. We record this as weakeningVerified with an honest note.
        //     LIMITATION: this is a *monotonicity* argument, not a full whatIf(add)
        //     re-classification (the worker exposes no add-side consistency oracle
        //     without mutating urn:vg:data); a fuller check is documented follow-up.
        for (const r of actionable) {
          if (r.kind !== 'weaken') continue;
          // verifiedConsistent here = "removing the culprit A⊑D alone restores
          // consistency". When true, the weakening (which keeps A⊑D′ ⊒ A⊑D) is
          // sound by the entailment-monotonicity argument above.
          r.weakeningVerified = r.verifiedConsistent === true;
          r.weakeningNote = r.weakeningVerified
            ? 'Removal of the original axiom restores consistency; the weaker A ⊑ D′ ' +
              'is entailed by the removed A ⊑ D (D ⊑ D′), so re-adding it cannot ' +
              're-introduce the contradiction — weakening is sound and preserves A ⊑ D′.'
            : 'Removing the original axiom alone does not restore consistency (other ' +
              'contradictions remain); apply with the full repair set. The weaker ' +
              'A ⊑ D′ is still entailed by the removed axiom (add-side is monotone).';
        }

        // 2. Full-set verification — remove EVERY inconsistency repair at once.
        //    This is the hitting-set guarantee: their union restores consistency
        //    even when each individual removal does not.
        // The full hitting set is the set of DELETION repairs (weakenings are
        // per-axiom ALTERNATIVES to a deletion, not additional set members — they
        // share the same culprit, so including them would double-count).
        const deletionSet = actionable.filter((r) => r.kind !== 'weaken');
        if (deletionSet.length > 0) {
          // BUG B: each removal carries its object-term + source graph so the
          // full-set VERIFY removes exactly what the apply path would.
          const removals = deletionSet.map(repairToRemoval);
          try {
            const detailed = await rdfManager.verifyRepairDetailed(removals);
            repairSetVerifiedConsistent = detailed.verifiedConsistent;
            // L2: warn when some removals matched nothing — a false verdict then
            // means "the store was not actually changed", not "repair failed".
            if (detailed.matchedCount < detailed.requestedCount) {
              repairSetMatchWarning =
                `Only ${detailed.matchedCount} of ${detailed.requestedCount} repair ` +
                `axioms matched a triple in the store; the consistency verdict may ` +
                `reflect an unchanged store rather than the repair's effect ` +
                `(check for serialization mismatches).`;
            }
            // Annotate each deletion repair with the shared full-set verdict.
            for (const r of deletionSet) r.verifiedSet = detailed.verifiedConsistent;
          } catch {
            // Oracle unavailable — leave repairSetVerifiedConsistent null.
          }

          // 3. BOUNDED subset-minimality verification (live wiring of
          //    annotateDeletionMinimality). The greedy/irredundant hitting set
          //    above is minimal-by-heuristic (no single member redundant) but NOT
          //    proven minimum-cardinality; a genuinely smaller sub-collection may
          //    still restore consistency once the REAL reasoner is consulted. We
          //    run the bounded smallest-first subset search using the SAME
          //    store-copy oracle (verifyRepairDetailed) the full-set check uses —
          //    each invocation operates on a store COPY and never mutates the
          //    author's graph. The search annotates each verified deletion repair
          //    with `minimalityVerified`. Above the bound the search is skipped
          //    (minimalityVerified:false, irredundant fallback). Guarded so it is
          //    a no-op when no reasoner is available and NEVER throws into the
          //    diagnosis path (matches current best-effort verification behaviour).
          try {
            const reasonerCheck = async (removals: DeletionRemoval[]): Promise<boolean> =>
              (await rdfManager.verifyRepairDetailed(removals as VerifyRepairRemoval[]))
                .verifiedConsistent;
            await annotateDeletionMinimality(suggestedRepairs, reasonerCheck);
          } catch {
            // Oracle unavailable or search failed — leave minimalityVerified
            // undefined on the repairs (unchanged pure-path behaviour).
          }
        }
      }

      const repairBrief = buildRepairBrief(data, suggestedRepairs, {
        repairSetVerifiedConsistent,
        repairSetMatchWarning,
      });

      return {
        success: true,
        data: {
          ...data,
          repairBrief,
          suggestedRepairs,
          repairSetVerifiedConsistent,
          ...(repairSetMatchWarning ? { repairSetMatchWarning } : {}),
        },
      };
    } catch (e) {
      return { success: false, error: `explainDiagnostics: ${(e as Error)?.message ?? String(e)}` };
    }
  },
};

// ---------------------------------------------------------------------------
// explainEntailment
// ---------------------------------------------------------------------------

/** Local name of an IRI for compact, human-readable summaries. */
function localName(iri: string): string {
  const hash = iri.lastIndexOf('#');
  const slash = iri.lastIndexOf('/');
  const cut = Math.max(hash, slash);
  return cut >= 0 && cut < iri.length - 1 ? iri.slice(cut + 1) : iri;
}

function axiomToText(a: { subject: string; predicate: string; object: string }): string {
  return `${localName(a.subject)} ${localName(a.predicate)} ${localName(a.object)}`;
}

const explainEntailment: McpTool = {
  name: 'explainEntailment',
  description:
    "Explain WHY a specific entailed axiom holds — Horridge-style justifications for an ARBITRARY entailed axiom (not just inconsistency). " +
    "Ask 'why is A rdfs:subClassOf B?' or 'why is x rdf:type C?' and get back the minimal set(s) of asserted axioms whose conjunction logically entails it. " +
    "Input: { subjectIri, predicateIri, objectIri, maxJustifications? }. " +
    "Returns { isEntailed, justifications, summary, ontologyInconsistent?, vacuous?, reason? }: isEntailed=true means the OWL 2 DL reasoner derives the axiom; " +
    "justifications is a list of minimal axiom sets (each { subject, predicate, object }[]) — every axiom in a set is needed to derive the conclusion. " +
    "An empty justifications list with isEntailed=true means the axiom is directly asserted (nothing to derive) or its shape is unsupported. " +
    "isEntailed=false with empty justifications means the axiom is NOT entailed. " +
    "ontologyInconsistent=true (isEntailed=null) means the ontology is ALREADY inconsistent so entailment is vacuous — run explainDiagnostics and fix consistency first; the result is NOT a real entailment. " +
    "vacuous=true (subClassOf only) means the axiom holds ONLY because the subject class is unsatisfiable (empty class ⊑ anything) — not a genuine derivation; fix the unsatisfiable class. " +
    "summary is a short plain-language 'Inferred because: …' explanation. " +
    "Supported shapes: rdfs:subClassOf and rdf:type with an IRI object (e.g. transitive subclass A⊑B,B⊑C ⟹ A⊑C, or domain/range-driven type inference). " +
    "Read-only: never mutates asserted data.",
  inputSchema: {
    type: 'object',
    required: ['subjectIri', 'predicateIri', 'objectIri'],
    properties: {
      subjectIri: { type: 'string', description: 'IRI of the axiom subject (e.g. the subclass, or the individual).' },
      predicateIri: { type: 'string', description: 'IRI of the predicate — rdfs:subClassOf or rdf:type.' },
      objectIri: { type: 'string', description: 'IRI of the axiom object (e.g. the superclass, or the class).' },
      maxJustifications: { type: 'number', default: 1, description: 'Maximum number of independent justifications to return.' },
    },
  },
  async handler(params): Promise<McpResult> {
    try {
      const { subjectIri, predicateIri, objectIri, maxJustifications = 1 } = (params ?? {}) as {
        subjectIri?: string;
        predicateIri?: string;
        objectIri?: string;
        maxJustifications?: number;
      };
      if (!subjectIri || !predicateIri || !objectIri) {
        return { success: false, error: 'explainEntailment requires subjectIri, predicateIri and objectIri.' };
      }

      // Ensure the reasoner has the current asserted graph (read-only).
      const { isEntailed, justifications, ontologyInconsistent, vacuous, reason } =
        await rdfManager.explainEntailment(
          subjectIri,
          predicateIri,
          objectIri,
          { maxJustifications },
        );

      const axiomText = axiomToText({ subject: subjectIri, predicate: predicateIri, object: objectIri });
      let summary: string;
      if (ontologyInconsistent) {
        // C1: the ontology is already inconsistent, so the entailment reduction is
        // VACUOUS (a contradiction entails everything). isEntailed is null here.
        summary =
          `Cannot decide whether ${axiomText} is entailed: the ontology is already ` +
          `inconsistent, so every axiom is "entailed" by the contradiction. ` +
          `Run explainDiagnostics and fix consistency first.`;
        return {
          success: true,
          data: { isEntailed: null, ontologyInconsistent: true, justifications: [], reason, summary },
        };
      }
      if (vacuous) {
        // C2: A ⊑ anything holds only because the subject class is unsatisfiable.
        summary =
          `${axiomText} holds only VACUOUSLY: the subject class is unsatisfiable in the ` +
          `ontology, so it is a subclass of everything. This is not a genuine derivation — ` +
          `fix the unsatisfiable class (see explainDiagnostics / unsatisfiableClasses).`;
        return {
          success: true,
          data: { isEntailed: true, vacuous: true, justifications, reason, summary },
        };
      }
      if (!isEntailed) {
        summary = `${axiomText} is NOT entailed by the current ontology.`;
      } else if (justifications.length === 0) {
        summary = `${axiomText} holds — it is directly asserted (no derivation needed).`;
      } else {
        const sets = justifications
          .map((j, i) => {
            const axioms = j.map(axiomToText).join('; ');
            return justifications.length > 1 ? `[${i + 1}] ${axioms}` : axioms;
          })
          .join(' | ');
        summary = `${axiomText} is inferred because: ${sets}.`;
      }

      return { success: true, data: { isEntailed, justifications, summary } };
    } catch (e) {
      return { success: false, error: `explainEntailment: ${(e as Error)?.message ?? String(e)}` };
    }
  },
};

export const reasoningTools: McpTool[] = [runReasoning, clearInferred, getCapabilities, explainDiagnostics, explainEntailment];
