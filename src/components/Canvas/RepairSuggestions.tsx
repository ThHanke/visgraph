// src/components/Canvas/RepairSuggestions.tsx
//
// Human-facing "Apply repair" UI — the symmetric counterpart of the
// `explainDiagnostics` MCP tool. It closes the neuro-symbolic verify→repair
// loop for HUMANS: instead of an agent calling `removeLink`, a person clicks
// "Apply fix" in the Reasoning Report.
//
// It reuses the SAME pure repair logic the agent path uses — `computeRepairs`
// from src/mcp/tools/computeRepairs.ts — so the suggestions a human sees are
// byte-for-byte the suggestions an agent would receive. Verification
// (`verifyRepair` / full-set check) is delegated to rdfManager, exactly as in
// reasoning.ts's explainDiagnostics handler. The component is presentational +
// orchestration only; no repair selection lives here.

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { rdfManager, type VerifyRepairRemoval } from '../../utils/rdfManager';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { CheckCircle2, Wrench, ShieldQuestion, AlertTriangle, Sparkles } from 'lucide-react';
import { toPrefixed } from '../../utils/termUtils';
import {
  computeRepairs,
  addWeakeningRepairs,
  type RepairSuggestion,
  type WeakeningContext,
} from '../../mcp/tools/computeRepairs';
import { buildClassHierarchy, buildDirectEdgeMap } from '../../mcp/tools/axiomWeakening';
import type { DiagnosticsData } from '../../mcp/tools/diagnosticsBrief';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';

const DATA_GRAPH = 'urn:vg:data';
const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';

/**
 * Read the classified subClassOf hierarchy (asserted + inferred) for axiom
 * weakening, mirroring reasoning.ts's loadWeakeningContext so the human UI offers
 * the SAME weakening alternatives an agent receives. Best-effort: an empty
 * hierarchy simply yields no weakenings.
 */
async function loadWeakeningContext(): Promise<WeakeningContext> {
  try {
    const res = await rdfManager.sparqlQuery(
      `SELECT ?sub ?sup WHERE { ?sub <${RDFS_SUBCLASS_OF}> ?sup . FILTER(isIRI(?sub) && isIRI(?sup)) }`,
      { limit: 5000 },
    );
    const edges: Array<{ sub: string; sup: string }> = [];
    if (res?.type === 'select' && Array.isArray(res.rows)) {
      for (const row of res.rows as Array<Record<string, string>>) {
        if (row.sub && row.sup) edges.push({ sub: row.sub, sup: row.sup });
      }
    }
    return { hierarchy: buildClassHierarchy(edges), direct: buildDirectEdgeMap(edges) };
  } catch {
    return { hierarchy: buildClassHierarchy([]) };
  }
}

/**
 * C1: pick the graph a repair must be applied in. The MIPS axiom may physically
 * live in `urn:vg:ontologies` (an imported schema axiom) rather than the data
 * graph — applying to a hardcoded `urn:vg:data` would silently match nothing.
 * Falls back to the data graph when the metadata is absent (back-compat).
 */
function repairGraph(args: RepairSuggestion['action']['args']): string {
  return args.graph || DATA_GRAPH;
}

/**
 * H2: reconstruct the EXACT object term for an apply so a typed/lang literal is
 * matched precisely (not by lossy lexical fallback). Returns an object the
 * rdfManager term coercion understands ({ value, type, datatype, language }) so
 * `"42"^^xsd:integer` is removed without touching a same-lexical `"42"` string.
 * IRI/blank-node objects, and objects lacking term metadata, pass through as the
 * plain value string (unchanged behaviour).
 */
function repairObjectTerm(
  value: string,
  args: RepairSuggestion['action']['args'],
): unknown {
  if (args.objectTermType === 'Literal') {
    const term: { value: string; type: 'literal'; datatype?: string; language?: string } = {
      value,
      type: 'literal',
    };
    if (args.objectDatatype) term.datatype = args.objectDatatype;
    if (args.objectLanguage) term.language = args.objectLanguage;
    return term;
  }
  return value;
}

/**
 * BUG B + BUG C: project a repair into a verifyRepair removal carrying the
 * object-term metadata + source graph so VERIFY excludes the IDENTICAL triple the
 * apply path removes — not a same-lexical sibling in another graph / with another
 * datatype (which would yield a false 'verifiedConsistent').
 *
 * BUG C — VERIFY and APPLY MUST use the SAME graph. The apply path resolves the
 * graph via `repairGraph` (which DEFAULTS to urn:vg:data when the MIPS axiom has
 * no graph metadata). If VERIFY instead omitted the graph it would do an all-graph
 * match, targeting a DIFFERENT quad set than apply → a false `verifiedConsistent`
 * or an apply no-op. So we pin VERIFY to the IDENTICAL `repairGraph(a)` value the
 * apply path uses — verify and apply always target the same triple+graph.
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
    // BUG C: same graph resolution as the apply path (never absent) so verify
    // and apply agree on the exact quad set.
    graph: repairGraph(a),
  };
}

interface RepairSuggestionsProps {
  /**
   * Identity of the current reasoning run. Changing it re-fetches diagnostics
   * (so the panel always reflects the latest reasoning result the modal shows).
   */
  reasoningId: string | null;
  /** Whether the reasoner reported the ontology inconsistent. */
  isConsistent: boolean | null | undefined;
}

/** A repair plus its full-set context, ready to render. */
interface ComputedRepairs {
  repairs: RepairSuggestion[];
  repairSetVerifiedConsistent: boolean | null;
}

/** Build a one-line, prefixed rendering of the triple an action touches. */
function tripleLabel(action: RepairSuggestion['action']): string | null {
  const { subjectIri, predicateIri, objectIri } = action.args;
  if (!subjectIri || !predicateIri) return null;
  const s = toPrefixed(subjectIri);
  const p = toPrefixed(predicateIri);
  const o = objectIri ? toPrefixed(objectIri) : '(value needed)';
  return `${s} ${p} ${o}`;
}

export const RepairSuggestions = memo(({ reasoningId, isConsistent }: RepairSuggestionsProps) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [computed, setComputed] = useState<ComputedRepairs | null>(null);
  const [applied, setApplied] = useState<Record<string, boolean>>({});
  const [applying, setApplying] = useState<Record<string, boolean>>({});
  const [rerunning, setRerunning] = useState(false);
  // Synchronous in-flight guard: set at the very start of an apply (before any
  // await) so a fast double-click can be rejected immediately — React state
  // updates are async and would let a second click through before re-render.
  const inFlight = useRef<Set<string>>(new Set());
  const ALL_VERIFIED_KEY = '__all_verified__';

  // ── Load diagnostics + compute (and verify) repairs ────────────────────────
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        // 1. Symbolic diagnostics — same sources explainDiagnostics uses.
        let justifications: DiagnosticsData['justifications'] = [];
        if (isConsistent === false) {
          justifications = await rdfManager.explainInconsistency(3);
        }
        let unsatisfiableClasses: string[] = [];
        try { unsatisfiableClasses = (await rdfManager.validate()).unsatisfiable; } catch { unsatisfiableClasses = []; }
        const shacl = await rdfManager.runShaclValidation();
        const shaclViolations = (shacl?.violations ?? []) as DiagnosticsData['shaclViolations'];

        const diagnostics: DiagnosticsData = {
          isConsistent: isConsistent ?? null,
          justifications,
          unsatisfiableClasses,
          // profile is not surfaced in the UI repair list; computeRepairs ignores it.
          profile: { owl2dl: true, violations: [] },
          shaclViolations,
        };

        // 2. Shared, deterministic repair computation — identical to the agent path.
        let repairs = computeRepairs(diagnostics);

        // 2b. AXIOM WEAKENING alternatives (Troquard et al. 2018; Li & Lambrix
        //     2024) for subClassOf culprits — the SAME augmentation explainDiagnostics
        //     applies, so the human UI shows the same delete-vs-weaken choice.
        if (isConsistent === false) {
          const wctx = await loadWeakeningContext();
          repairs = addWeakeningRepairs(repairs, { ...wctx, justifications });
        }

        // 3. Symbolic verification (read-only, on a store copy) — per-axiom and full set.
        let repairSetVerifiedConsistent: boolean | null = null;
        if (isConsistent === false) {
          const actionable = repairs.filter(
            (r) =>
              r.issue === 'inconsistency' &&
              !r.needsManualReview &&
              r.action.args.subjectIri &&
              r.action.args.predicateIri &&
              r.action.args.objectIri,
          );
          await Promise.all(
            actionable.map(async (r) => {
              try {
                // BUG B: VERIFY the SAME triple APPLY removes (graph + exact
                // typed/lang literal), not a bare lexical/all-graph match.
                r.verifiedConsistent = await rdfManager.verifyRepair([repairToRemoval(r)]);
                // Weakening soundness transfers from the removal verdict: the
                // weaker A ⊑ D′ is entailed by the removed A ⊑ D (D ⊑ D′).
                if (r.kind === 'weaken') r.weakeningVerified = r.verifiedConsistent === true;
              } catch { /* oracle unavailable — leave undefined */ }
            }),
          );
          // Full-set verification uses DELETION repairs only (weakenings are
          // alternatives to a deletion, not extra hitting-set members).
          const deletionSet = actionable.filter((r) => r.kind !== 'weaken');
          if (deletionSet.length > 0) {
            const removals: VerifyRepairRemoval[] = deletionSet.map(repairToRemoval);
            try {
              repairSetVerifiedConsistent = await rdfManager.verifyRepair(removals);
              for (const r of deletionSet) r.verifiedSet = repairSetVerifiedConsistent ?? undefined;
            } catch { /* oracle unavailable */ }
          }
        }

        if (!cancelled) {
          setComputed({ repairs, repairSetVerifiedConsistent });
          setApplied({});
        }
      } catch (e) {
        if (!cancelled) {
          setError((e as Error)?.message ?? String(e));
          setComputed(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [reasoningId, isConsistent]);

  // ── Offer to re-run reasoning after a repair is applied ────────────────────
  const offerRerun = useCallback(() => {
    const refs = getWorkspaceRefs();
    if (!refs.runReasoning) {
      toast.info('Re-run reasoning to confirm the fix.');
      return;
    }
    toast('Repair applied — re-run reasoning to confirm?', {
      action: {
        label: 'Re-run',
        onClick: async () => {
          try {
            setRerunning(true);
            await refs.runReasoning?.();
          } catch (err) {
            console.error('Re-run reasoning failed', err);
            toast.error('Re-run reasoning failed (see console).');
          } finally {
            setRerunning(false);
          }
        },
      },
      duration: 10000,
    });
  }, []);

  // ── Apply a single repair ──────────────────────────────────────────────────
  // Routes through applyBatch (which returns the REAL {added, removed} delta) so
  // we only mark a repair "Applied" once the store actually changed (H1). The
  // graph and exact object term come from the repair action's metadata so the
  // change hits the correct graph (C1) and removes the precise typed literal (H2).
  const applyRepair = useCallback(async (r: RepairSuggestion) => {
    const { subjectIri, predicateIri, objectIri, objectValue } = r.action.args;
    if (!subjectIri || !predicateIri) {
      toast.error('This repair cannot be applied automatically.');
      return;
    }
    // FIX1: synchronous in-flight guard. A fast double-click fires two calls
    // before isApplied flips; without this the second applyBatch removes 0
    // triples and shows the misleading "matched no triples" warning for a
    // repair that actually succeeded. Reject the re-entrant click immediately.
    if (inFlight.current.has(r.id)) return;
    inFlight.current.add(r.id);
    setApplying((s) => ({ ...s, [r.id]: true }));
    const graph = repairGraph(r.action.args);
    try {
      // AXIOM WEAKENING (Troquard et al. 2018; Li & Lambrix 2024): apply the
      // remove+add BATCH (remove the culprit A ⊑ D, add the weaker A ⊑ D′) in
      // one applyBatch so the weaker axiom is preserved — less destructive than
      // a plain deletion. Undo restores the original (re-add culprit, remove D′).
      if (r.kind === 'weaken' && r.batch) {
        const removes = r.batch.removes.map((t) => ({
          subject: t.subject,
          predicate: t.predicate,
          object: t.object,
          graph: t.graph || graph,
        }));
        const adds = r.batch.adds.map((t) => ({
          subject: t.subject,
          predicate: t.predicate,
          object: t.object,
          graph: t.graph || graph,
        }));
        const { removed, added } = await rdfManager.applyBatch({ removes, adds }, graph);
        if (removed < 1) {
          toast.warning(
            `${r.id} matched no triples — the axiom may live in a different graph or was already weakened/removed.`,
          );
          return;
        }
        setApplied((s) => ({ ...s, [r.id]: true }));
        const addedLabel = adds.length > 0 ? `, added ${added} weaker axiom(s)` : '';
        toast.success(`Applied ${r.id} (weaken): removed ${removed} axiom(s)${addedLabel}`, {
          action: {
            label: 'Undo',
            onClick: async () => {
              try {
                // Reverse the batch: re-add what we removed, remove what we added.
                await rdfManager.applyBatch({ removes: adds, adds: removes }, graph);
                setApplied((s) => ({ ...s, [r.id]: false }));
                toast.success(`Undid ${r.id}`);
              } catch (err) {
                console.error('Undo weaken repair failed', err);
                toast.error('Undo failed (see console).');
              }
            },
          },
          duration: 8000,
        });
        offerRerun();
        return;
      }
      if (r.action.tool === 'removeLink') {
        const object = repairObjectTerm(objectIri ?? '', r.action.args);
        const removal = { subject: subjectIri, predicate: predicateIri, object, graph };
        const { removed } = await rdfManager.applyBatch({ removes: [removal], adds: [] }, graph);
        if (removed < 1) {
          // H1 + C1: nothing matched — do NOT claim success. The axiom likely
          // lives in a different graph or was already removed.
          toast.warning(
            `${r.id} matched no triples — the axiom may live in a different graph or was already removed.`,
          );
          return;
        }
        setApplied((s) => ({ ...s, [r.id]: true }));
        toast.success(`Applied ${r.id}: removed ${tripleLabel(r.action) ?? 'triple'}`, {
          action: {
            label: 'Undo',
            onClick: async () => {
              try {
                await rdfManager.applyBatch({ removes: [], adds: [removal] }, graph);
                setApplied((s) => ({ ...s, [r.id]: false }));
                toast.success(`Undid ${r.id}`);
              } catch (err) {
                console.error('Undo repair failed', err);
                toast.error('Undo failed (see console).');
              }
            },
          },
          duration: 8000,
        });
        offerRerun();
      } else if (r.action.tool === 'addTriple') {
        const rawValue = objectIri ?? objectValue;
        if (!rawValue) {
          toast.warning(`${r.id} needs a value — open the node and supply ${toPrefixed(predicateIri)} manually.`);
          return;
        }
        const object = repairObjectTerm(rawValue, r.action.args);
        const addition = { subject: subjectIri, predicate: predicateIri, object, graph };
        const { added } = await rdfManager.applyBatch({ removes: [], adds: [addition] }, graph);
        if (added < 1) {
          // H1: addition was a no-op (already present) — surface honestly.
          toast.warning(`${r.id} added no triple — it may already be present.`);
          return;
        }
        setApplied((s) => ({ ...s, [r.id]: true }));
        toast.success(`Applied ${r.id}: added ${tripleLabel(r.action) ?? 'triple'}`, {
          action: {
            label: 'Undo',
            onClick: async () => {
              try {
                await rdfManager.applyBatch({ removes: [addition], adds: [] }, graph);
                setApplied((s) => ({ ...s, [r.id]: false }));
                toast.success(`Undid ${r.id}`);
              } catch (err) {
                console.error('Undo repair failed', err);
                toast.error('Undo failed (see console).');
              }
            },
          },
          duration: 8000,
        });
        offerRerun();
      } else {
        toast.info(`${r.id} requires a manual node update.`);
      }
    } catch (e) {
      console.error('Apply repair failed', e);
      toast.error('Apply failed (see console).');
    } finally {
      inFlight.current.delete(r.id);
      setApplying((s) => {
        const next = { ...s };
        delete next[r.id];
        return next;
      });
    }
  }, [offerRerun]);

  // ── Apply the full verified hitting set in one batch ───────────────────────
  const applyAllVerified = useCallback(async (repairs: RepairSuggestion[]) => {
    // FIX1: guard against concurrent/double invocation of the batch apply.
    if (inFlight.current.has(ALL_VERIFIED_KEY)) return;
    inFlight.current.add(ALL_VERIFIED_KEY);
    setApplying((s) => ({ ...s, [ALL_VERIFIED_KEY]: true }));
    // C1 + H2: each removal carries its OWN source graph and exact object term
    // so the batch removes from urn:vg:ontologies / urn:vg:data as appropriate
    // and matches typed/lang literals precisely (applyBatch honours the per-entry
    // `graph` field; the default `DATA_GRAPH` only applies when none is recorded).
    //
    // FIX2: build the applied-id set from the EXACT same filtered list used to
    // build `removals` (removeLink + subject/predicate/object present), not the
    // broader inconsistency/!needsManualReview filter. A repair lacking
    // removeLink/objectIri is excluded from the batch, so it must NOT be marked
    // Applied (that would be a false success).
    const applicable = repairs.filter(
      (r) =>
        r.issue === 'inconsistency' &&
        !r.needsManualReview &&
        // Weakenings are per-axiom ALTERNATIVES to a deletion, not members of the
        // deletion hitting set — exclude them from "apply all" (the deletion of
        // the same culprit is already included).
        r.kind !== 'weaken' &&
        r.action.tool === 'removeLink' &&
        r.action.args.subjectIri &&
        r.action.args.predicateIri &&
        r.action.args.objectIri,
    );
    const removals = applicable.map((r) => ({
      subject: r.action.args.subjectIri!,
      predicate: r.action.args.predicateIri!,
      object: repairObjectTerm(r.action.args.objectIri!, r.action.args),
      graph: repairGraph(r.action.args),
    }));
    if (removals.length === 0) {
      toast.info('No verified repair set to apply.');
      inFlight.current.delete(ALL_VERIFIED_KEY);
      setApplying((s) => {
        const next = { ...s };
        delete next[ALL_VERIFIED_KEY];
        return next;
      });
      return;
    }
    try {
      // H1: trust the REAL removed count, not the requested length.
      const { removed } = await rdfManager.applyBatch({ removes: removals, adds: [] }, DATA_GRAPH);
      if (removed < 1) {
        toast.warning(
          'Repair set matched no triples — the axioms may live in a different graph or were already removed.',
        );
        return;
      }
      // FIX2: only the repairs actually included in the batch are marked Applied.
      const ids = applicable.reduce<Record<string, boolean>>((acc, r) => { acc[r.id] = true; return acc; }, {});
      setApplied((s) => ({ ...s, ...ids }));
      const partial = removed < removals.length ? ` (${removed} of ${removals.length} matched)` : '';
      toast.success(`Applied repair set — removed ${removed} axiom(s) to restore consistency${partial}`, {
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await rdfManager.applyBatch({ removes: [], adds: removals }, DATA_GRAPH);
              setApplied((s) => {
                const next = { ...s };
                for (const id of Object.keys(ids)) next[id] = false;
                return next;
              });
              toast.success('Undid repair set');
            } catch (err) {
              console.error('Undo repair set failed', err);
              toast.error('Undo failed (see console).');
            }
          },
        },
        duration: 10000,
      });
      offerRerun();
    } catch (e) {
      console.error('Apply all verified failed', e);
      toast.error('Apply all failed (see console).');
    } finally {
      inFlight.current.delete(ALL_VERIFIED_KEY);
      setApplying((s) => {
        const next = { ...s };
        delete next[ALL_VERIFIED_KEY];
        return next;
      });
    }
  }, [offerRerun]);

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="text-center text-muted-foreground py-8" role="status" aria-live="polite">
        Computing repair suggestions…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center text-destructive py-8" role="alert">
        Could not compute repairs: {error}
      </div>
    );
  }

  const repairs = computed?.repairs ?? [];
  if (repairs.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8">
        No automatic repairs available — the graph is consistent and conforms to its shapes.
      </div>
    );
  }

  const setVerified = computed?.repairSetVerifiedConsistent === true;
  const inconsistencyRepairs = repairs.filter((r) => r.issue === 'inconsistency' && !r.needsManualReview);

  return (
    <div className="space-y-3">
      {setVerified && inconsistencyRepairs.length > 1 && (
        <Card className="bg-success/10 border-success/20">
          <CardContent className="pt-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-success">
              <CheckCircle2 className="w-5 h-5 shrink-0" />
              <span className="text-sm font-medium">
                Applying all {inconsistencyRepairs.length} repairs together is verified to restore consistency.
              </span>
            </div>
            <Button
              size="sm"
              disabled={!!applying[ALL_VERIFIED_KEY] || rerunning}
              onClick={() => void applyAllVerified(repairs)}
              aria-label="Apply all verified repairs to restore consistency"
            >
              <Sparkles className="w-4 h-4 mr-1.5" aria-hidden="true" />
              Apply all verified
            </Button>
          </CardContent>
        </Card>
      )}

      {repairs.map((r) => {
        const label = tripleLabel(r.action);
        const isApplied = !!applied[r.id];
        const isApplying = !!applying[r.id];
        const verifiedAlone = r.verifiedConsistent === true;
        const verifiedAsSet = !verifiedAlone && r.verifiedSet === true;
        const isWeaken = r.kind === 'weaken';
        // For a weakening, show the BEFORE → AFTER axiom transition.
        const weakenBefore = isWeaken && r.batch?.removes[0];
        const weakenAfter = isWeaken && r.batch && r.batch.adds.length > 0 ? r.batch.adds[0] : null;
        return (
          <Card
            key={r.id}
            className={
              r.needsManualReview
                ? 'border-warning/30'
                : isWeaken
                  ? 'border-primary/40 bg-primary/5'
                  : 'border-border'
            }
          >
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
                {r.needsManualReview ? (
                  <ShieldQuestion className="w-4 h-4 text-warning shrink-0" aria-hidden="true" />
                ) : isWeaken ? (
                  <Sparkles className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
                ) : (
                  <Wrench className="w-4 h-4 text-primary shrink-0" aria-hidden="true" />
                )}
                <span className="font-mono text-xs text-muted-foreground">{r.id}</span>
                <Badge variant={r.issue === 'shacl' ? 'outline' : 'secondary'} className="text-[10px]">
                  {r.issue === 'shacl' ? 'SHACL' : 'OWL'}
                </Badge>
                {isWeaken && (
                  <Badge variant="default" className="text-[10px] bg-primary text-primary-foreground">
                    Weaken {r.alternativeTo ? `(alt to ${r.alternativeTo})` : ''}
                  </Badge>
                )}
                {!isWeaken && verifiedAlone && (
                  <Badge variant="default" className="text-[10px] bg-success text-success-foreground">
                    Verified consistent
                  </Badge>
                )}
                {isWeaken && r.weakeningVerified && (
                  <Badge variant="default" className="text-[10px] bg-success text-success-foreground">
                    Weakening verified
                  </Badge>
                )}
                {!isWeaken && verifiedAsSet && (
                  <Badge variant="outline" className="text-[10px]">
                    Part of verified set
                  </Badge>
                )}
                {r.needsValue && (
                  <Badge variant="outline" className="text-[10px]">
                    Value needed
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm">{r.rationale}</p>
              {isWeaken && weakenBefore ? (
                <code className="block text-xs font-mono break-all rounded bg-muted px-2 py-1 text-muted-foreground">
                  <span className="text-destructive">− {toPrefixed(weakenBefore.subject)} {toPrefixed(weakenBefore.predicate)} {toPrefixed(weakenBefore.object)}</span>
                  {weakenAfter && (
                    <>
                      <br />
                      <span className="text-success">+ {toPrefixed(weakenAfter.subject)} {toPrefixed(weakenAfter.predicate)} {toPrefixed(weakenAfter.object)}</span>
                    </>
                  )}
                </code>
              ) : label ? (
                <code className="block text-xs font-mono break-all rounded bg-muted px-2 py-1 text-muted-foreground">
                  {r.action.tool === 'removeLink' ? '− ' : '+ '}{label}
                </code>
              ) : null}
              {!r.needsManualReview && (
                <p className="text-xs text-muted-foreground flex items-center gap-1">
                  {isWeaken
                    ? 'Less destructive than deletion — replaces the axiom with a logically weaker one, preserving more knowledge.'
                    : verifiedAlone
                      ? 'Removing this alone restores consistency.'
                      : verifiedAsSet
                        ? 'Apply all to restore consistency (this is part of the verified set).'
                        : r.issue === 'shacl'
                          ? 'Satisfies the violated shape constraint.'
                          : 'Resolves at least one contradiction.'}
                </p>
              )}
              {r.needsManualReview ? (
                <div className="flex items-center gap-1.5 text-xs text-warning">
                  <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                  Manual review required — no automatic repair could be computed.
                </div>
              ) : (
                <Button
                  size="sm"
                  variant={isApplied ? 'outline' : 'default'}
                  disabled={isApplied || isApplying || rerunning}
                  onClick={() => void applyRepair(r)}
                  aria-label={`Apply repair ${r.id}: ${r.rationale}`}
                >
                  {isApplied ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 mr-1.5" aria-hidden="true" />
                      Applied
                    </>
                  ) : isWeaken ? (
                    <>
                      <Sparkles className="w-4 h-4 mr-1.5" aria-hidden="true" />
                      Apply weakening
                    </>
                  ) : (
                    <>
                      <Wrench className="w-4 h-4 mr-1.5" aria-hidden="true" />
                      Apply fix
                    </>
                  )}
                </Button>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
});

RepairSuggestions.displayName = 'RepairSuggestions';
