import { create } from "zustand";
import { DataFactory } from "n3";
const { namedNode } = DataFactory;
import { WELL_KNOWN } from "../utils/wellKnownOntologies";
import { useAppConfigStore } from "./appConfigStore";

let reasoningWorker: any = null;

/**
 * Reasoning store
 *
 * Changes:
 * - Removed the previous "mock" heuristics that constructed errors/warnings from
 *   application-level graph structure.
 * - Start reasoning now prefers to invoke the real N3 reasoner (when available).
 *   The implementation:
 *     1. Snapshots store quads (before)
 *     2. Attempts to dynamically import 'n3' and instantiate Reasoner exactly as
 *        provided by the package.
 *     3. Parses rules from public/reasoning-rules/default-rules.n3 (if present) into
 *        a rules Store and calls reasoner.reason(rulesStore).
 *     4. Snapshots store quads (after) and derives "inferences" from the delta.
 *     5. Constructs a ReasoningResult using the real reasoner output (inferred quads).
 * - If the N3 reasoner is not available or invocation fails, falls back to a
 *   small, conservative RDFS-style inference pass (transitive subClassOf / domain/range)
 *   to produce inferences; errors/warnings arrays are left empty unless we can
 *   deterministically derive something actionable.
 *
 * The calling UI (KnowledgeCanvas) is responsible for mapping reasoning results
 * into node/edge messages (the canvas already reacts to currentReasoning).
 */

const __vg_safe = (a: any) => (a && (a as any).message) ? (a as any).message : String(a || "");

interface ReasoningResult {
  id: string;
  timestamp: number;
  status: "running" | "completed" | "error";
  duration?: number;
  errors: ReasoningError[];
  warnings: ReasoningWarning[];
  inferences: Inference[];
  // Plain serialized inferred quads (subject/predicate/object/graph) for UI tables.
  inferredQuads?: { subject: string; predicate: string; object: string; graph?: string }[];
}

interface ReasoningError {
  nodeId?: string;
  edgeId?: string;
  message: string;
  rule: string;
  severity: "critical" | "error";
}

interface ReasoningWarning {
  nodeId?: string;
  edgeId?: string;
  message: string;
  rule: string;
  severity?: "critical" | "warning" | "info";
}

interface Inference {
  type: "property" | "class" | "relationship";
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

interface ReasoningStore {
  currentReasoning: ReasoningResult | null;
  reasoningHistory: ReasoningResult[];
  isReasoning: boolean;
  startReasoning: (nodes: any[], edges: any[], rdfStore?: any) => Promise<ReasoningResult>;
  abortReasoning: () => void;
  clearHistory: () => void;
  getLastResult: () => ReasoningResult | null;
}

function quadKey(q: any) {
  try {
    const g = q.graph && q.graph.value ? String(q.graph.value) : "";
    return `${String(q.subject && q.subject.value)}|${String(q.predicate && q.predicate.value)}|${String(q.object && q.object.value)}|${g}`;
  } catch (_) {
    return Math.random().toString(36).slice(2);
  }
}

function expandPredicate(prefixed: string) {
  try {
    if (!prefixed || typeof prefixed !== "string") return prefixed;
    const prefixes = (WELL_KNOWN && (WELL_KNOWN as any).prefixes) || {};
    const match = Object.keys(prefixes).find((p) => prefixed.startsWith(p + ":"));
    if (match) {
      return prefixed.replace(new RegExp(`^${match}:`), prefixes[match]);
    }
    return prefixed;
  } catch (_) {
    return prefixed;
  }
}

export const useReasoningStore = create<ReasoningStore>((set, get) => ({
  currentReasoning: null,
  reasoningHistory: [],
  isReasoning: false,

  startReasoning: async (nodes, edges, rdfStore) => {
    const id = `reasoning-${Date.now()}`;
    const start = Date.now();

    set({ isReasoning: true });

    const baseResult: ReasoningResult = {
      id,
      timestamp: start,
      status: "running",
      errors: [],
      warnings: [],
      inferences: [],
    };

    set({ currentReasoning: baseResult });

    // Per-run reasoning state used by worker/local paths
    let usedReasoner = false;
    let tempStoreForReasoner: any = null;
    let __vg_prev_write_logging: boolean = false;
    let __vg_prev_window_flag: boolean = false;

    // Per-run diagnostics guard to avoid duplicate before/after logs in a single reasoning invocation.
    let beforeLogged = false;
    const afterLogged = false;

    try {
      // Snapshot "before" quads if a store is available. Support both raw N3 Store
      // instances and manager-like objects that expose getStore().
      const _beforeStore = rdfStore && typeof rdfStore.getStore === "function" ? rdfStore.getStore() : rdfStore;
      const beforeQuads = (_beforeStore && typeof _beforeStore.getQuads === "function")
        ? (_beforeStore.getQuads(null, null, null, null) || [])
        : [];

      // Triple-count diagnostic (before): use rdfManager helper when available and log total + per-graph counts.
      try {
        const mod = await import("../utils/rdfManager");
        if (mod && typeof mod.collectGraphCountsFromStore === "function") {
          try {
            const countsBefore = (mod && mod.rdfManager && typeof mod.rdfManager.getStore === "function")
              ? mod.collectGraphCountsFromStore(mod.rdfManager.getStore())
              : (rdfStore ? mod.collectGraphCountsFromStore(rdfStore) : {});
            if (!beforeLogged) {
              console.debug("[VG_DEBUG] reasoning.tripleCounts.before", {
                totalBefore: Array.isArray(beforeQuads) ? beforeQuads.length : 0,
                countsBefore,
              });
              beforeLogged = true;
            }
          } catch (_) { /* ignore per-collect errors */ }
        }
      } catch (_) { /* ignore import/diagnostic failures */ }
      

      // Diagnostic: collect graph counts before reasoning using rdfManager helper if available
      try {
        let graphCountsBefore: Record<string, number> = {};
        try {
          const mod = await import("../utils/rdfManager");
          if (mod && typeof mod.collectGraphCountsFromStore === "function") {
            graphCountsBefore = rdfStore ? mod.collectGraphCountsFromStore(rdfStore) : {};
          }
        } catch (_) {
          // fallback: simple scan
          try {
            if (rdfStore && typeof rdfStore.getQuads === "function") {
              const all = rdfStore.getQuads(null, null, null, null) || [];
              for (const qq of all) {
                try {
                  const g = qq && qq.graph && qq.graph.value ? qq.graph.value : "default";
                  graphCountsBefore[g] = (graphCountsBefore[g] || 0) + 1;
                } catch (_) { /* per-quad */ }
              }
            }
          } catch (_) { /* ignore */ }
        }
        try { console.debug("[VG_DEBUG] reasoning.graphCounts.before", { candidateBeforeCount: beforeQuads.length, graphCountsBefore }); } catch (_) {/* noop */}
      } catch (_) { /* ignore overall */ }

      // Collect graph-level triple counts before reasoning (diagnostic). Use rdfManager API if available.
      try {
        let graphCountsBefore: Record<string, number> = {};
        try {
          const mod = await import("../utils/rdfManager");
          if (mod && typeof mod.collectGraphCountsFromStore === "function") {
            graphCountsBefore = rdfStore ? mod.collectGraphCountsFromStore(rdfStore) : {};
          }
        } catch (_) {
          // Fall back to a simple scan if rdfManager diagnostics not present.
          try {
            if (rdfStore && typeof rdfStore.getQuads === "function") {
              const all = rdfStore.getQuads(null, null, null, null) || [];
              for (const qq of all) {
                try {
                  const g = qq && qq.graph && qq.graph.value ? qq.graph.value : "default";
                  graphCountsBefore[g] = (graphCountsBefore[g] || 0) + 1;
                } catch (_) { /* per-quad */ }
              }
            }
          } catch (_) { /* ignore */ }
        }
        try { console.debug("[VG_DEBUG] reasoning.graphCounts.before", { candidateBeforeCount: beforeQuads.length, graphCountsBefore }); } catch (_) {/* noop */}
      } catch (_) { /* ignore overall */ }

      // Worker-only reasoning path: send snapshot & ruleset names to the worker and await its result.
      // This enforces a single reasoning path: the worker is authoritative for rule fetching, parsing and reasoning.
      try {
        // Determine ruleset names from config
        const selected = (useAppConfigStore.getState().config && Array.isArray(useAppConfigStore.getState().config.reasoningRulesets))
          ? useAppConfigStore.getState().config.reasoningRulesets
          : [];
        const rulesets: string[] = Array.isArray(selected) ? selected : [];

        // Serialize current authoritative store snapshot in chunks to avoid blocking the main thread.
        const snapshot: any[] = [];
        try {
          const srcStore = rdfStore && typeof rdfStore.getStore === "function" ? rdfStore.getStore() : rdfStore;
          const existing = srcStore && typeof srcStore.getQuads === "function" ? srcStore.getQuads(null, null, null, null) || [] : [];
          const CHUNK = 200;
          for (let i = 0; i < existing.length; i += CHUNK) {
            const slice = existing.slice(i, i + CHUNK);
            for (const q of slice) {
              try {
                const subj = q.subject && (q.subject as any).value ? String((q.subject as any).value) : "";
                const pred = q.predicate && (q.predicate as any).value ? String((q.predicate as any).value) : "";
                const objTerm = (q as any).object;
                let obj: any = { t: "lit", v: "" };
                if (objTerm) {
                  if (objTerm.termType === "NamedNode") obj = { t: "iri", v: String(objTerm.value) };
                  else if (objTerm.termType === "BlankNode") obj = { t: "bnode", v: String(objTerm.value) };
                  else if (objTerm.termType === "Literal") {
                    const dt = objTerm.datatype && objTerm.datatype.value ? String(objTerm.datatype.value) : undefined;
                    const ln = objTerm.language || undefined;
                    obj = { t: "lit", v: String(objTerm.value), dt, ln };
                  } else {
                    obj = { t: "lit", v: String(objTerm.value || "") };
                  }
                }
                const g = q.graph && (q.graph as any).value ? String((q.graph as any).value) : undefined;
                snapshot.push({ s: subj, p: pred, o: obj, g });
              } catch (_) { /* per-quad */ }
            }
            // yield to event loop
            // eslint-disable-next-line no-await-in-loop
            await Promise.resolve();
          }
        } catch (_) { /* ignore snapshot errors */ }
        try { console.debug("[VG_DEBUG] reasoner.snapshot.serialized", { snapshotLength: snapshot.length }); } catch (_) { /* noop */ }
        try { console.debug("[VG_DEBUG] reasoner.rules.requested", { rulesetsLength: Array.isArray(rulesets) ? rulesets.length : 0 }); } catch (_) { /* noop */ }

        if (typeof window !== "undefined" && typeof (globalThis as any).Worker !== "undefined") {
          try {
            const workerUrl = new URL("../workers/reasoner.worker.ts", import.meta.url);
            try { if (reasoningWorker && typeof reasoningWorker.terminate === "function") { reasoningWorker.terminate(); } } catch (_) { /* ignore */ }
            reasoningWorker = new Worker(workerUrl as any, { type: "module" });
            const w = reasoningWorker;

            let __vg_worker_error: any = null;
            const workerResult: any = await new Promise((resolve, reject) => {
              const tH = setTimeout(() => {
                try { w.terminate(); } catch (_) { /* noop */ } finally { try { reasoningWorker = null; } catch (_) { /* noop */ } }
                reject(new Error("reasoner worker timeout"));
              }, 120000);

              const onMessage = (ev: MessageEvent) => {
                const m = ev && ev.data ? ev.data : {};
                if (!m || m.id !== id) return;
                // stage messages: surface as debug
                if (m.type === "stage") {
                  try { console.debug("[VG_DEBUG_STAGE]", m.stage, m); } catch (_) {}
                  return;
                }
                if (m.type === "result") {
                  try { clearTimeout(tH); w.removeEventListener("message", onMessage as any); } catch (_) {}
                  resolve(m.afterQuads || []);
                } else if (m.type === "error") {
                  try {
                    console.error("[VG_ERROR] reasoner.worker.error", m);
                    __vg_worker_error = m;
                  } catch (_) {}
                  // keep waiting for a 'result' or terminal error
                } else if (m.type === "cancelled") {
                  try { clearTimeout(tH); w.removeEventListener("message", onMessage as any); } catch (_) {}
                  reject(new Error("reasoner worker cancelled"));
                }
              };
              w.addEventListener("message", onMessage as any);
              try {
                w.postMessage({ type: "run", id, quads: snapshot, rules: rulesets });
              } catch (postErr) {
                try { clearTimeout(tH); w.removeEventListener("message", onMessage as any); } catch (_) {}
                try { w.terminate(); } catch (_) {}
                reject(postErr);
              }
            });

            try { console.debug("[VG_DEBUG] reasoner.worker.result.length", { workerResultLength: Array.isArray(workerResult) ? workerResult.length : 0 }); } catch (_) { /* noop */ }
            if (__vg_worker_error) {
              try { console.error("[VG_ERROR] reasoner.worker.reported_issues", __vg_worker_error); } catch (_) {}
            }

            // Convert worker result into a tempStoreForReasoner so later code can compute the delta
            try {
              tempStoreForReasoner = { getQuads: () => {
                try {
                  const arr: any[] = [];
                  for (const sq of workerResult || []) {
                    try {
                      const s = /^_:/.test(String(sq.s || "")) ? DataFactory.blankNode(String(sq.s).replace(/^_:/, "")) : DataFactory.namedNode(String(sq.s || ""));
                      const p = DataFactory.namedNode(String(sq.p || ""));
                      let o: any = DataFactory.literal(String((sq.o && sq.o.v) || ""));
                      if (sq.o && sq.o.t === "iri") o = DataFactory.namedNode(String(sq.o.v));
                      else if (sq.o && sq.o.t === "bnode") o = DataFactory.blankNode(String(sq.o.v));
                      else if (sq.o && sq.o.t === "lit") {
                        if (sq.o.dt) o = DataFactory.literal(String(sq.o.v), DataFactory.namedNode(String(sq.o.dt)));
                        else if (sq.o.ln) o = DataFactory.literal(String(sq.o.v), String(sq.o.ln));
                        else o = DataFactory.literal(String(sq.o.v));
                      }
                      const g = sq.g ? DataFactory.namedNode(String(sq.g)) : undefined;
                      arr.push(DataFactory.quad(s, p, o, g));
                    } catch (_) { /* per-quad */ }
                  }
                  return arr;
                } catch (_) { return []; }
              } };
              // We'll compute added quads by comparing beforeQuads and serialized after quads below.
              usedReasoner = true;
            } catch (_) { /* ignore */ } finally {
              try { w.terminate(); } catch (_) { /* noop */ }
            }
          } catch (workerErr) {
            console.debug("[VG_DEBUG] reasoner worker failed", String(workerErr).slice(0,200));
            // Worker failed — enforce worker-only behavior: surface error by throwing so caller sets error result
            throw workerErr;
          }
        } else {
          // No browser Worker available — enforce worker-only reasoning.
          // Previously a main-thread fallback ran here for Node tests; that fallback
          // is intentionally removed to ensure deterministic, worker-based reasoning.
          try { console.error("[VG_ERROR] reasoner: Worker unavailable; reasoning requires a browser Worker"); } catch (_) { /* noop */ }
          throw new Error("Reasoner requires a browser Worker; none available in this environment");
        }
      } catch (e) {
        try { console.error("[VG_ERROR] worker-only reasoning encountered unexpected error", __vg_safe(e)); } catch (_) {}
        // Worker-only mode enforced — rethrow so the outer handler returns an error result
        // instead of allowing a main-thread fallback to run.
        throw e;
      }


      // Snapshot "after" quads if a store is available and compute delta.
      // Prefer the temp store the reasoner wrote into (if present); otherwise use the authoritative rdfStore.
      const afterQuads = (() => {
        try {
          const s = tempStoreForReasoner || (rdfStore && typeof rdfStore.getStore === "function" ? rdfStore.getStore() : rdfStore);
          if (!s || typeof s.getQuads !== "function") return [];
          const a = s.getQuads(null, null, null, null) || [];
          return Array.isArray(a) ? a : [];
        } catch (_) {
          return [];
        }
      })();

      // Triple-count diagnostic (after): use rdfManager helper when available and log total + per-graph counts.
      try {
        const mod = await import("../utils/rdfManager");
        if (mod && typeof mod.collectGraphCountsFromStore === "function") {
          try {
            const countsAfter = (mod && mod.rdfManager && typeof mod.rdfManager.getStore === "function")
              ? mod.collectGraphCountsFromStore(mod.rdfManager.getStore())
              : (rdfStore ? mod.collectGraphCountsFromStore(rdfStore) : {});
            console.debug("[VG_DEBUG] reasoning.tripleCounts.after", {
              totalAfter: Array.isArray(afterQuads) ? afterQuads.length : 0,
              countsAfter,
            });
          } catch (_) { /* ignore per-collect errors */ }
        }
      } catch (_) { /* ignore import/diagnostic failures */ }
      // Triple-count diagnostic after reasoning: call rdfManager helper when available.
      try {
        const mod = await import("../utils/rdfManager");
        if (mod && typeof mod.collectGraphCountsFromStore === "function") {
          try {
            const countsAfter = (mod && mod.rdfManager && typeof mod.rdfManager.getStore === "function")
              ? mod.collectGraphCountsFromStore(mod.rdfManager.getStore())
              : (rdfStore ? mod.collectGraphCountsFromStore(rdfStore) : {});
            try { console.debug("[VG_DEBUG] reasoning.tripleCounts.after", { totalAfter: Array.isArray(afterQuads) ? afterQuads.length : 0, countsAfter }); } catch (_) {/* noop */}
          } catch (_) { /* ignore per-collect */ }
        }
      } catch (_) { /* ignore import/diagnostic failures */ }

      // Diagnostic: collect graph counts after reasoning using rdfManager helper if available
      try {
        let graphCountsAfter: Record<string, number> = {};
        try {
          const mod = await import("../utils/rdfManager");
          if (mod && typeof mod.collectGraphCountsFromStore === "function") {
            graphCountsAfter = rdfStore ? mod.collectGraphCountsFromStore(rdfStore) : {};
          }
        } catch (_) {
          // fallback: simple scan
          try {
            if (rdfStore && typeof rdfStore.getQuads === "function") {
              const all = rdfStore.getQuads(null, null, null, null) || [];
              for (const qq of all) {
                try {
                  const g = qq && qq.graph && qq.graph.value ? qq.graph.value : "default";
                  graphCountsAfter[g] = (graphCountsAfter[g] || 0) + 1;
                } catch (_) { /* per-quad */ }
              }
            }
          } catch (_) { /* ignore */ }
        }
        try { console.debug("[VG_DEBUG] reasoning.graphCounts.after", { candidateAfterCount: afterQuads.length, graphCountsAfter }); } catch (_) {/* noop */}
      } catch (_) { /* ignore overall */ }
      const beforeMap = new Map<string, any>();
      for (const q of beforeQuads || []) beforeMap.set(quadKey(q), q);
      const added: any[] = [];
      for (const q of afterQuads || []) {
        const k = quadKey(q);
        if (!beforeMap.has(k)) {
          // Exclude any quads that use the internal inferred graph marker (if any)
          if (q.graph && q.graph.value === "urn:vg:inferred") {
            added.push(q);
          } else {
            // Also include added quads in default graph (some reasoners add there)
            added.push(q);
          }
        }
      }

      // Persist added quads into a single authoritative graph so subsequent runs
      // report a stable inferred-triple set (urn:vg:inferred).
      try {
        const inferredGraph = namedNode("urn:vg:inferred");
        // Build Term-shaped adds for the manager
        const addsForManager: any[] = [];
        for (const aq of added) {
          try {
            addsForManager.push({ subject: aq.subject, predicate: aq.predicate, object: aq.object });
          } catch (_) { /* ignore per-item */ }
        }

        // Try to use the rdfManager.applyBatch API if available so the manager
        // uses the canonical store instance and emits a single notify.
        try {
          const mod = await import("../utils/rdfManager");
          const mgr = mod && mod.rdfManager ? mod.rdfManager : null;
          if (mgr && typeof mgr.applyBatch === "function") {
            await mgr.applyBatch({ removes: [], adds: addsForManager }, String(inferredGraph.value));
            // Post-apply verification: query authoritative manager store counts (ensure inferred graph appears)
            try {
              const verifiedStore = mgr.getStore ? mgr.getStore() : rdfStore;
              try {
                const counts = (await import("../utils/rdfManager")).collectGraphCountsFromStore(verifiedStore);
                try {
                  // Log the authoritative inferred-graph count specifically and a single persisted marker.
                  console.debug("[VG_DEBUG] reasoning.inferred.persisted", {
                    inferredCount: counts && counts["urn:vg:inferred"] ? counts["urn:vg:inferred"] : 0,
                    counts,
                  });
                } catch (_) {/* noop */}
              } catch (_) {/* noop */}
            } catch (_) {/* noop */}
          } else {
            // Fallback: direct store writes
            const isN3Store = rdfStore && typeof rdfStore.getQuads === "function" && typeof rdfStore.addQuad === "function";
            for (const aq of added) {
              try {
                const subj = aq.subject;
                const pred = aq.predicate;
                const obj = aq.object;
                const exists = isN3Store
                  ? ((rdfStore.getQuads(subj, pred, obj, inferredGraph) || []).length > 0)
                  : false;
                if (!exists) {
                  if (isN3Store) {
                    rdfStore.addQuad(DataFactory.quad(subj, pred, obj, inferredGraph));
                  } else if (rdfStore && typeof rdfStore.addQuad === "function") {
                    rdfStore.addQuad(DataFactory.quad(subj, pred, obj, inferredGraph));
                  }
                }
              } catch (_) { /* per-item */ }
            }
            // Post-apply verification for fallback path
            try {
              const mod = await import("../utils/rdfManager");
              const verified = mod && mod.rdfManager && typeof mod.rdfManager.getStore === "function" ? mod.rdfManager.getStore() : rdfStore;
              const counts = mod.collectGraphCountsFromStore(verified);
              try {
                console.debug("[VG_DEBUG] reasoning.inferred.persisted", {
                  inferredCount: counts && counts["urn:vg:inferred"] ? counts["urn:vg:inferred"] : 0,
                  counts,
                });
              } catch (_) {/* noop */}
            } catch (_) {/* noop */}
          }
        } catch (e) {
          // Final fallback: attempt direct writes
          try {
            const isN3Store = rdfStore && typeof rdfStore.getQuads === "function" && typeof rdfStore.addQuad === "function";
            for (const aq of added) {
              try {
                if (isN3Store) {
                  rdfStore.addQuad(DataFactory.quad(aq.subject, aq.predicate, aq.object, inferredGraph));
                } else if (rdfStore && typeof rdfStore.addQuad === "function") {
                  rdfStore.addQuad(DataFactory.quad(aq.subject, aq.predicate, aq.object, inferredGraph));
                }
              } catch (_) { /* per-item */ }
            }
          } catch (_) {
            /* ignore final fallback errors */
          }
        }
        } catch (e) {
        console.debug("[VG_DEBUG] persisting inferred quads failed", __vg_safe(e));
      }

      // Build serialized inferredQuads for UI consumption (plain objects).
      const inferredQuadsSerialized: { subject: string; predicate: string; object: string; graph?: string }[] = [];
      try {
        for (const aq of (added || [])) {
          try {
            const subj = aq && aq.subject && aq.subject.value ? String(aq.subject.value) : (aq && aq.subject ? String(aq.subject) : "");
            const pred = aq && aq.predicate && aq.predicate.value ? String(aq.predicate.value) : (aq && aq.predicate ? String(aq.predicate) : "");
            const obj = aq && aq.object && aq.object.value ? String(aq.object.value) : (aq && aq.object ? String(aq.object) : "");
            const g = (aq && aq.graph && aq.graph.value) ? String(aq.graph.value) : (aq && (aq.g ? String(aq.g) : (aq.graph ? String(aq.graph) : undefined)));
            inferredQuadsSerialized.push({ subject: subj, predicate: pred, object: obj, graph: g });
          } catch (_) { /* per-item */ }
        }
      } catch (_) { /* ignore overall */ }

      // Cleanup: ensure temporary reasoner store does not remain subscribed or referenced.
      try {
        // Restore prior write-logging flags (if any) so normal diagnostics state is preserved.
        try {
          if (typeof globalThis !== "undefined") (globalThis as any).__VG_RDF_WRITE_LOGGING_ENABLED = Boolean(__vg_prev_write_logging);
        } catch (_) {/* noop */}
        try {
          if (typeof window !== "undefined") (window as any).__VG_LOG_RDF_WRITES = Boolean(__vg_prev_window_flag);
        } catch (_) {/* noop */}
      } catch (_) {/* noop */}

      try { tempStoreForReasoner = null; } catch (_) {/* noop */}

      // Build warnings/errors from SHACL-style ValidationResult triples in urn:vg:inferred
      const generatedWarnings: ReasoningWarning[] = [];
      try {
        const inferredGraph = namedNode("urn:vg:inferred");
        const shValidation = "http://www.w3.org/ns/shacl#ValidationResult";
        const shFocus = "http://www.w3.org/ns/shacl#focusNode";
        const shMessage = "http://www.w3.org/ns/shacl#resultMessage";
        const shSeverity = "http://www.w3.org/ns/shacl#resultSeverity";

        if (rdfStore && typeof rdfStore.getQuads === "function") {
          const resQuads = rdfStore.getQuads(null, namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type"), namedNode(shValidation), inferredGraph) || [];
          for (const rq of resQuads) {
            try {
              const resNode = rq.subject;
              const focusQ = rdfStore.getQuads(resNode, namedNode(shFocus), null, inferredGraph) || [];
              const msgQ = rdfStore.getQuads(resNode, namedNode(shMessage), null, inferredGraph) || [];
              const sevQ = rdfStore.getQuads(resNode, namedNode(shSeverity), null, inferredGraph) || [];

              const focusVal = (focusQ[0] && focusQ[0].object && focusQ[0].object.value) ? focusQ[0].object.value : "";
              const message = (msgQ[0] && msgQ[0].object && msgQ[0].object.value) ? String(msgQ[0].object.value) : "Validation issue";
              const severityUri = (sevQ[0] && sevQ[0].object && sevQ[0].object.value) ? String(sevQ[0].object.value) : "http://www.w3.org/ns/shacl#Warning";
              const severity = severityUri.includes("Violation") ? "critical" : "warning";

              generatedWarnings.push({
                nodeId: focusVal,
                message,
                rule: "sh:ValidationResult",
                severity,
              });
            } catch (_) { /* per-item */ }
          }
        }
      } catch (e) {
        console.debug("[VG_DEBUG] extracting SHACL validation results failed", __vg_safe(e));
      }

      // If N3 reasoner didn't run, attempt a minimal RDFS-style inference pass to produce inferences.
      const inferences: Inference[] = [];
      if (!usedReasoner) {
        // Build a small index from available quads (combine before+after so we reason over the current graph)
        const allQuads = afterQuads || [];
        try {
          // transitive rdfs:subClassOf inference
          const subClassOf = "http://www.w3.org/2000/01/rdf-schema#subClassOf";
          const rdfType = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
          const bySubject = new Map<string, any[]>();
          for (const q of allQuads) {
            const s = q.subject && q.subject.value ? q.subject.value : "";
            if (!bySubject.has(s)) bySubject.set(s, []);
            bySubject.get(s)!.push(q);
          }
          // transitive closure (naive)
          for (const q of allQuads) {
            if (q.predicate && q.predicate.value === subClassOf) {
              // find any classes that are subclass of the object
              const obj = q.object && q.object.value ? q.object.value : "";
              for (const q2 of allQuads) {
                if (q2.predicate && q2.predicate.value === subClassOf && q2.subject && q2.subject.value === obj) {
                  inferences.push({
                    type: "class",
                    subject: q.subject.value,
                    predicate: "rdfs:subClassOf",
                    object: q2.object.value,
                    confidence: 0.8,
                  });
                }
              }
            }
            // domain/range simple derivation
            if (q.predicate && q.predicate.value === "http://www.w3.org/2000/01/rdf-schema#domain") {
              const prop = q.subject && q.subject.value ? q.subject.value : "";
              for (const inst of allQuads) {
                if (inst.predicate && inst.predicate.value === prop) {
                  inferences.push({
                    type: "class",
                    subject: inst.subject && inst.subject.value ? inst.subject.value : "",
                    predicate: "rdf:type",
                    object: q.object && q.object.value ? q.object.value : "",
                    confidence: 0.7,
                  });
                }
              }
            }
            if (q.predicate && q.predicate.value === "http://www.w3.org/2000/01/rdf-schema#range") {
              const prop = q.subject && q.subject.value ? q.subject.value : "";
              for (const inst of allQuads) {
                if (inst.predicate && inst.predicate.value === prop && inst.object && inst.object.termType === "NamedNode") {
                  inferences.push({
                    type: "class",
                    subject: inst.object.value,
                    predicate: "rdf:type",
                    object: q.object && q.object.value ? q.object.value : "",
                    confidence: 0.7,
                  });
                }
              }
            }
          }
        } catch (e) {
          console.debug("[VG_DEBUG] fallback RDFS inference failed:", __vg_safe(e));
        }
      } else {
        // Construct inferences array from the persistent inferred graph (urn:vg:inferred).
        try {
          const inferredGraph = namedNode("urn:vg:inferred");
          const inferredQuads = (rdfStore && typeof rdfStore.getQuads === "function")
            ? (rdfStore.getQuads(null, null, null, inferredGraph) || [])
            : (added || []);

          // Deduplicate quads (some reasoners or earlier logic may result in duplicates)
          const unique = new Map<string, any>();
          for (const q of inferredQuads) {
            try {
              const k = quadKey(q);
              if (!unique.has(k)) unique.set(k, q);
            } catch (_) { /* ignore per-item */ }
          }
          // Also include any newly added quads that may not yet be persisted in the inferred graph
          for (const q of (added || [])) {
            try {
              const k = quadKey(q);
              if (!unique.has(k)) unique.set(k, q);
            } catch (_) { /* ignore per-item */ }
          }

          for (const q of unique.values()) {
            try {
              const pred = q.predicate && q.predicate.value ? String(q.predicate.value) : "";
              const subj = q.subject && q.subject.value ? String(q.subject.value) : "";
              const obj = q.object && q.object.value ? String(q.object.value) : "";
              if (!pred || !subj) continue;
              if (pred === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type") {
                inferences.push({ type: "class", subject: subj, predicate: "rdf:type", object: obj, confidence: 0.95 });
              } else {
                inferences.push({ type: "relationship", subject: subj, predicate: pred, object: obj, confidence: 0.9 });
              }
            } catch (_) { /* per-item */ }
          }
        } catch (e) {
          console.debug("[VG_DEBUG] extracting inferred quads failed", __vg_safe(e));
        }
      }

      const completed: ReasoningResult = {
        id,
        timestamp: start,
        status: "completed",
        duration: Date.now() - start,
        errors: (generatedWarnings || []).filter((w) => String((w as any).severity) === "critical").map((w) => ({
          nodeId: w.nodeId,
          edgeId: w.edgeId,
          message: w.message,
          rule: w.rule,
          severity: "critical" as const,
        })) as ReasoningError[],
        // Include only SHACL-derived warnings here. Inferred triples are reported
        // separately in the `inferences` array and the UI renders them in their own tab.
        warnings: ((generatedWarnings || []).filter((w) => String((w as any).severity) !== "critical").map((w) => ({
          nodeId: w.nodeId,
          edgeId: w.edgeId,
          message: w.message,
          rule: w.rule,
          severity: (w as any).severity || "warning",
        })) as ReasoningWarning[]),
        // Plain serialized inferred quads for UI tables
        inferredQuads: inferredQuadsSerialized,
        inferences,
      };

      set((state) => ({
        currentReasoning: completed,
        isReasoning: false,
        reasoningHistory: [completed, ...state.reasoningHistory.slice(0, 9)],
      }));

      return completed;
    } catch (err) {
      const errorResult: ReasoningResult = {
        id,
        timestamp: start,
        status: "error",
        duration: Date.now() - start,
        errors: [
          {
            message: "Reasoning process failed",
            rule: "system-error",
            severity: "critical",
          },
        ],
        warnings: [],
        inferences: [],
      };

      set((state) => ({
        currentReasoning: errorResult,
        isReasoning: false,
        reasoningHistory: [errorResult, ...state.reasoningHistory.slice(0, 9)],
      }));

      return errorResult;
    }
  },

  abortReasoning: () => {
    set({ isReasoning: false, currentReasoning: null });
  },

  clearHistory: () => {
    set({ reasoningHistory: [] });
  },

  getLastResult: () => {
    const { reasoningHistory } = get();
    return reasoningHistory[0] || null;
  },
}));
