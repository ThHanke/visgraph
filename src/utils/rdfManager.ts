/**
 * @fileoverview RDF Manager
 * Manages RDF store operations, including updates, exports, and proper namespace handling.
 * Uses N3.js store for proper RDF data management.
 *
 * This file preserves the original RDFManager API used across the app and
 * adds a small change-notification API so consumers (ReactFlowCanvas) can
 * subscribe to RDF-change events:
 *   - onChange(cb: (count:number) => void)
 *   - offChange(cb)
 * Internally notifyChange() is invoked whenever quads are added/removed/graphs modified.
 */

import { Store, Parser, Writer, Quad, DataFactory } from "n3";
import { rdfParser } from "rdf-parse";
import { rdfSerializer } from "rdf-serialize";
import type * as RDF from "@rdfjs/types";

// Batch size used when draining/ingesting parsed quads to avoid blocking the main thread.
// Keep in sync with worker batch sizes.
const BATCH_SIZE = 1000;

const { namedNode, literal, quad, blankNode, defaultGraph } = DataFactory;

/*
  Global N3 Store prototype hook
  ------------------------------
  Patch N3's Store.prototype.addQuad / removeQuad once at module initialization
  so that any codepath which obtains an N3 Store instance (reasoner, parser worker,
  direct store usage) is observed. This emits a single compact diagnostic
  "[VG_DEBUG] n3Store.write" after each successful add/remove when the existing
  runtime debug gate is enabled.

  The patch is intentionally:
  - idempotent (checks __vg_store_hook_installed)
  - defensive (wraps in try/catch and performs non-critical read-only getQuads)
  - non-mutating (does not change stored quads; calls original methods first)
*/
try {
  if (typeof Store !== "undefined" && !(Store as any).__vg_store_hook_installed) {
    (Store as any).__vg_store_hook_installed = true;
    const __origAdd = (Store.prototype as any).addQuad;
    const __origRemove = (Store.prototype as any).removeQuad;

    // Use function() so `this` is the concrete store instance
    (Store.prototype as any).addQuad = function (...args: any[]) {
      // call original first so behavior is unchanged
      const result = __origAdd.apply(this, args);

      try {
        // Gate emission by existing runtime debug flags so no new config is required
        const enabled =
          typeof window !== "undefined" &&
          (!!((window as any).__VG_LOG_RDF_WRITES === true || (window as any).__VG_DEBUG__));
        if (!enabled) return result;

        try {
          // Build compact graph counts (fast, in-memory)
          const all = (typeof this.getQuads === "function") ? (this.getQuads(null, null, null, null) || []) : [];
          const graphCounts: Record<string, number> = {};
          for (const qq of all) {
            try {
              const g = qq && qq.graph && (qq.graph as any).value ? (qq.graph as any).value : "default";
              graphCounts[g] = (graphCounts[g] || 0) + 1;
            } catch (_) { /* ignore per-quad */ }
          }

          // Small preview of the quad that triggered the write
          const q = args && args[0] ? args[0] : null;
          const preview = q && q.subject ? {
            s: q.subject && q.subject.value ? String(q.subject.value) : null,
            p: q.predicate && q.predicate.value ? String(q.predicate.value) : null,
            o: q.object && q.object.value ? String(q.object.value) : null
          } : null;

          // write logging removed per request (use collectGraphCountsFromStore/store APIs on demand)
        } catch (_) {
          /* ignore logging errors */
        }
      } catch (_) {
        /* ignore top-level */
      }

      return result;
    };

    (Store.prototype as any).removeQuad = function (...args: any[]) {
      const result = __origRemove.apply(this, args);

      try {
        const enabled =
          typeof window !== "undefined" &&
          (!!((window as any).__VG_LOG_RDF_WRITES === true || (window as any).__VG_DEBUG__));
        if (!enabled) return result;

        try {
          const all = (typeof this.getQuads === "function") ? (this.getQuads(null, null, null, null) || []) : [];
          const graphCounts: Record<string, number> = {};
          for (const qq of all) {
            try {
              const g = qq && qq.graph && (qq.graph as any).value ? (qq.graph as any).value : "default";
              graphCounts[g] = (graphCounts[g] || 0) + 1;
            } catch (_) { /* ignore per-quad */ }
          }
          const q = args && args[0] ? args[0] : null;
          const preview = q && q.subject ? {
            s: q.subject && q.subject.value ? String(q.subject.value) : null,
            p: q.predicate && q.predicate.value ? String(q.predicate.value) : null,
            o: q.object && q.object.value ? String(q.object.value) : null
          } : null;

          // write logging removed per request (use collectGraphCountsFromStore/store APIs on demand)
        } catch (_) {
          /* ignore logging errors */
        }
      } catch (_) { /* ignore top-level */ }

      return result;
    };
  }
} catch (_) {
  /* fail silently — diagnostics must not break app logic */
}

/**
 * Helper: create a Node-style Readable from fetched content (string, ArrayBuffer or Uint8Array).
 *
 * Uses dynamic imports for "stream" and "buffer" so we avoid bundling Node-only modules
 * into the browser build. Returns a Node Readable when possible, otherwise returns undefined.
 * Callers should fall back to WHATWG Response.body when this returns undefined.
 */
async function createNodeReadableFromText(
  content: string | ArrayBuffer | Uint8Array,
): Promise<any | undefined> {
  // Safety: this helper only provides a Node-style Readable in Node-like runtimes.
  // In browser environments (window available) we must NOT import Node builtins
  // dynamically since that causes Vite to attempt to optimize polyfills into
  // the client bundle (stream/browser shims) which can fail in dev and in preview.
  // Returning undefined causes callers to fall back to WHATWG Response.body.
  try {
    if (typeof window !== "undefined") {
      return undefined;
    }
  } catch (_) {
    // If any unexpected error, fall back to undefined to avoid importing node-only modules.
    return undefined;
  }

  try {
    const _streamMod = await import("stream").catch(
      () => ({ Readable: undefined }) as any,
    );
    const Readable =
      _streamMod && _streamMod.Readable ? _streamMod.Readable : undefined;
    const _bufMod = await import("buffer").catch(
      () => ({ Buffer: (globalThis as any).Buffer }) as any,
    );
    const BufferImpl =
      _bufMod && _bufMod.Buffer ? _bufMod.Buffer : (globalThis as any).Buffer;

    // Prefer Readable.from when available
    if (
      Readable &&
      typeof (Readable as any).from === "function" &&
      typeof BufferImpl !== "undefined"
    ) {
      const chunk =
        typeof content === "string" ? BufferImpl.from(content) : (content as any);
      return (Readable as any).from([chunk]);
    }

    // Manual construction: create a Readable, push the content, then push EOF.
    if (
      Readable &&
      typeof Readable === "function" &&
      typeof BufferImpl !== "undefined"
    ) {
      const rs = new Readable();
      rs.push(typeof content === "string" ? BufferImpl.from(content) : (content as any));
      rs.push(null);
      return rs as any;
    }

    // Not available in this environment
    return undefined;
  } catch (_) {
    // Any failure importing node modules -> fall back to undefined (use browser streams)
    return undefined;
  }
}
import { useAppConfigStore } from "../stores/appConfigStore";
import { useOntologyStore } from "../stores/ontologyStore";
import { WELL_KNOWN } from "../utils/wellKnownOntologies";
import { debugLog, debug, fallback, incr } from "../utils/startupDebug";
import { text } from "stream/consumers";

/**
 * Manages RDF data with proper store operations
 */
export class RDFManager {
  private store: Store;
  private namespaces: Record<string, string> = {};
  private parser: Parser;
  private writer: Writer;

  // In-flight dedupe map to avoid parsing identical RDF content concurrently.
  private _inFlightLoads: Map<string, Promise<void>> = new Map();
  // Reconciliation in-flight promise (shared) so concurrent mutations await the same reconciliation run.
  private reconcileInProgress: Promise<void> | null = null;

  /**
   * Run a full reconciliation via the ontology store and expose a shared in-flight
   * promise so concurrent mutations await the same reconciliation run.
   *
   * Behavior:
   * - If a reconciliation is already in progress, returns the existing promise.
   *   resolves when reconciliation completes. Errors are propagated to callers (hard fail).
   */
  private runReconcile(quads?: any[]): Promise<void> {
    try {
      if (this.reconcileInProgress) {
        return this.reconcileInProgress;
      }
      let os: any = undefined;
      os = (useOntologyStore as any).getState();
      // Start the reconcile and store the in-flight promise so concurrent callers wait on it.
      this.reconcileInProgress = (async () => {
        await os.updateFatMap(quads);
        // clear the in-flight marker regardless of success/failure so future reconciles can run
        this.reconcileInProgress = null;
      })();

      return this.reconcileInProgress;
    } catch (err) {
      // propagate errors to caller
      return Promise.reject(err);
    }
  }

  // Change notification
  private changeCounter = 0;
  // Keep an explicit triple count so any direct store writes (or parser worker ingest)
  // can update a stable metric consumers can read immediately after writes.
  private tripleCount = 0;
  private changeSubscribers = new Set<(count: number) => void>();

  // Subject-level change notification (emits unique subject IRIs that were affected).
  // Consumers can subscribe via onSubjectsChange/offSubjectsChange to receive an array
  // of subject IRIs that have had triples added/removed. Emission is debounced inside
  // the RDFManager to coalesce bursts of quad operations.
  private subjectChangeSubscribers = new Set<(subjects: string[]) => void>();
  private subjectChangeBuffer: Set<string> = new Set();
  private subjectFlushTimer: number | null = null;
  // Track whether a parsing/load operation is in progress so we can defer emitting
  // subject-level notifications until namespaces/fat-map have been persisted.
  private parsingInProgress: boolean = false;
  // Buffer quads per subject to allow emitting the actual triples involved in a subject-level change.
  private subjectQuadBuffer: Map<string, Quad[]> = new Map();

  // Lightweight per-graph index to support fast paginated reads without materializing
  // all quads on every page request. Populated incrementally as quads are added/removed.
  // Structure: Map<graphName, { keys: string[]; map: Map<key, Quad>; tombstones: Set<key>; tombstoneCount: number; lastCompact: number }>
  private _graphIndex: Map<string, {
    keys: string[];
    map: Map<string, Quad>;
    tombstones: Set<string>;
    tombstoneCount: number;
    lastCompact: number;
  }> = new Map();

  // Blacklist configuration: prefixes and absolute namespace URIs that should be
  // ignored when emitting subject-level change notifications. Default set below
  // matches common RDF/OWL core vocabularies so they don't create canvas nodes.
  private blacklistedPrefixes: Set<string> = new Set([
    "owl",
    "rdf",
    "rdfs",
    "xml",
    "xsd",
  ]);
  private blacklistedUris: string[] = [
    "http://www.w3.org/2002/07/owl",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "http://www.w3.org/2000/01/rdf-schema#",
    "http://www.w3.org/XML/1998/namespace",
    "http://www.w3.org/2001/XMLSchema#",
  ];

  /**
   * Get the configured blacklist (prefixes + uris).
   */
  public getBlacklist(): { prefixes: string[]; uris: string[] } {
    return {
      prefixes: Array.from(this.blacklistedPrefixes),
      uris: Array.from(this.blacklistedUris),
    };
  }

  /**
   * Set the blacklist. This updates the in-memory manager configuration and (best-effort)
   * persists into the application config store if available.
   */
  public setBlacklist(
    prefixes: string[] | undefined | null,
    uris?: string[] | undefined | null,
  ): void {
    try {
      this.blacklistedPrefixes = new Set((prefixes || []).map(String));
      if (Array.isArray(uris)) this.blacklistedUris = uris.slice();
      // Best-effort: persist into app config if the store exposes setConfig
      try {
        if (
          typeof useAppConfigStore !== "undefined" &&
          (useAppConfigStore as any).getState
        ) {
          const st = (useAppConfigStore as any).getState();
          if (st && typeof st.setConfig === "function") {
            try {
              st.setConfig({
                ...(st.config || {}),
                blacklistedPrefixes: Array.from(this.blacklistedPrefixes),
                blacklistedUris: this.blacklistedUris,
              });
            } catch (_) {
              /* ignore */
            }
          }
        }
      } catch (_) {
        /* ignore */
      }
    } catch (err) {
      try {
        if (typeof fallback === "function")
          fallback("rdf.setBlacklist.failed", { error: String(err) });
      } catch (_) {
        /* ignore */
      }
    }
  }

  private isBlacklistedIri(val?: string | null): boolean {
    if (!val) return false;
    try {
      const s = String(val).trim();
      if (!s) return false;

      // 1) Prefixed form like rdf:label -> check configured prefix blacklist directly
      if (s.includes(":") && !/^https?:\/\//i.test(s)) {
        const prefix = s.split(":", 1)[0];
        if (this.blacklistedPrefixes.has(prefix)) return true;
      }

      // 2) Absolute IRI form -> build a set of namespace URI candidates derived from:
      //    - configured blacklistedUris
      //    - configured blacklistedPrefixes expanded via runtime namespaces or WELL_KNOWN defaults
      const uriCandidates = new Set<string>();
      (this.blacklistedUris || []).forEach((u) => {
        {
          uriCandidates.add(String(u));
        }
      });

      (Array.from(this.blacklistedPrefixes) || []).forEach((p) => {
        {
          // Prefer runtime-registered namespace
          const nsFromMgr = this.namespaces && this.namespaces[p];
          if (nsFromMgr) uriCandidates.add(nsFromMgr);
          // Fall back to known well-known prefix mapping
          try {
            const wk = (WELL_KNOWN && (WELL_KNOWN as any).prefixes) || {};
            if (wk && wk[p]) uriCandidates.add(String(wk[p]));
          } catch (_) {
            void 0;
          }
          const ontMap = (WELL_KNOWN && (WELL_KNOWN as any).ontologies) || {};
            for (const [ontUrl, meta] of Object.entries(ontMap || {})) {
                const m = meta as any;
                if (m && m.namespaces && m.namespaces[p]) {
                  uriCandidates.add(ontUrl);
                  if (Array.isArray(m.aliases)) {
                    m.aliases.forEach((a: any) => uriCandidates.add(String(a)));
                  }
                }

            }

        }
      });

      // Normalize candidates by ensuring common variants are present (with/without trailing #)
      const normalizedCandidates = Array.from(uriCandidates).reduce<string[]>(
        (acc, u) => {
          try {
            const su = String(u).trim();
            if (!su) return acc;
            acc.push(su);
            if (su.endsWith("#")) acc.push(su.replace(/#$/, ""));
            else acc.push(su + "#");
            if (su.endsWith("/")) acc.push(su.replace(/\/$/, ""));
            else acc.push(su + "/");
            return acc;
          } catch (_) {
            return acc;
          }
        },
        [],
      );

      for (const u of normalizedCandidates) {
        {
          if (!u) continue;
          if (s.startsWith(u)) return true;
        }
      }
    } catch (_) {
      {
        if (typeof fallback === "function") {
          fallback("emptyCatch", { error: String(_) });
        }
      }
    }
    return false;
  }

  constructor() {
    this.store = new Store();
    // Wrap store.getQuads/countQuads to accept flexible string inputs used across tests.
    // Many tests call getQuads using plain strings (subject/predicate/object) — normalize those
    // into N3 terms so the underlying N3 store does not throw when given non-term inputs.
    {
      const origGetQuads = (this.store as any).getQuads.bind(this.store);
      const origCountQuads = (this.store as any).countQuads.bind(this.store);
      const toTerm = (v: any, isObject = false) => {
        try {
          if (v === null || typeof v === "undefined") return null;
          if (typeof v === "object" && v.termType) return v;
          const s = String(v);
          if (!s) return null;
          if (/^_:/i.test(s)) return blankNode(String(s).replace(/^_:/, ""));
          if (isObject) {
            return /^https?:\/\//i.test(s) ? namedNode(s) : literal(s);
          }
          // default for subject/predicate/graph -> NamedNode when string
          return namedNode(s);
        } catch (_) {
          return v;
        }
      };
      (this.store as any).getQuads = (s: any, p: any, o: any, g: any) => {
        try {
          const ts = toTerm(s, false);
          const tp = toTerm(p, false);
          const to = toTerm(o, true);
          const tg = toTerm(g, false);
          return origGetQuads(ts, tp, to, tg);
        } catch (e) {
          return origGetQuads(s, p, o, g);
        }
      };
      (this.store as any).countQuads = (s: any, p: any, o: any, g: any) => {
        try {
          const ts = toTerm(s, false);
          const tp = toTerm(p, false);
          const to = toTerm(o, true);
          const tg = toTerm(g, false);
          return origCountQuads(ts, tp, to, tg);
        } catch (e) {
          return origCountQuads(s, p, o, g);
        }
      };
    }

    this.parser = new Parser();
    this.writer = new Writer();

    // Small, optional instrumentation: when enabled we wrap the underlying
    // store.addQuad / store.removeQuad functions to log a stack trace and a
    // brief quad summary. This can be enabled permanently in dev mode or
    // toggled at runtime via the browser console.
    const enableWriteTracing = () => {
      try {
        if (typeof window === "undefined") return;
        // Avoid double-wrapping
        if ((this.store as any).__vg_tracing_installed) return;
        (this.store as any).__vg_tracing_installed = true;

        const origAdd = this.store.addQuad.bind(this.store);
        const origRemove = this.store.removeQuad.bind(this.store);

        // Install a lightweight store-level wrapper that performs the essential
        // bookkeeping (tripleCount, subject buffering, notifyChange) and funnels a
        // single diagnostic emission through emitWriteGraphCounts. The emission itself
        // is gated inside emitWriteGraphCounts so enabling logging remains controlled
        // by the existing runtime/app flags.
        this.store.addQuad = ((q: Quad) => {
          // Delegate to original add
          const res = origAdd(q);
          try {
            // Keep explicit triple count in sync for direct store.addQuad callers.
            try { (this as any).tripleCount = ((this as any).tripleCount || 0) + 1; } catch (_) { /* ignore */ }
          } catch (_) { /* ignore count errors */ }
          try {
            if (typeof (this as any).bufferSubjectFromQuad === "function") {
              try { (this as any).bufferSubjectFromQuad(q); } catch (_) { /* ignore */ }
            }
          } catch (_) { /* ignore */ }
          try {
            if (typeof (this as any).notifyChange === "function") {
              try { (this as any).notifyChange({ kind: "direct-store-add" }); } catch (_) { /* ignore */ }
            }
          } catch (_) { /* ignore */ }

          // Emit a single unified diagnostic (emission gated internally).
          try { if (typeof (this as any).emitWriteGraphCounts === "function") (this as any).emitWriteGraphCounts("add", q); } catch (_) {/* noop */}

          return res;
        }) as any;

        this.store.removeQuad = ((q: Quad) => {
          try {
            if ((this as any).bufferSubjectFromQuad) {
              try { (this as any).bufferSubjectFromQuad(q); } catch (_) { /* ignore */ }
            }
          } catch (_) { /* ignore */ }
          const res = origRemove(q);
          try { if (typeof (this as any).emitWriteGraphCounts === "function") (this as any).emitWriteGraphCounts("remove", q); } catch (_) {/* noop */}
          return res;
        }) as any;
      } catch (err) {
        try {
          if (typeof fallback === "function") {
            fallback("vg.writeTrace.install_failed", { error: String(err) });
          }
        } catch (_) {
          try {
            if (typeof fallback === "function") {
              fallback("emptyCatch", { error: String(_) });
            }
          } catch (__) {
            /* ignore fallback errors */
          }
        }
      }
    };

    // Seed core RDF prefixes.
    this.namespaces = {
      rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      rdfs: "http://www.w3.org/2000/01/rdf-schema#",
      owl: "http://www.w3.org/2002/07/owl#",
      xsd: "http://www.w3.org/2001/XMLSchema#",
    };

    // Enable tracing automatically in dev mode, or when the runtime flag is set.
    try {
      if (typeof window !== "undefined") {
        // If running under Vite, import.meta.env.DEV will be truthy in development builds.
        // Fall back to checking a window flag if import.meta isn't available at runtime.
        const metaEnv =
          typeof (import.meta as any) !== "undefined" &&
          (import.meta as any).env
            ? (import.meta as any).env
            : {};
        // support explicit Vite-driven flag VITE_VG_LOG_RDF_WRITES=true
        // Do NOT automatically enable tracing in DEV; enable only when the explicit flag is set.
        const devMode =
          String(metaEnv.VITE_VG_LOG_RDF_WRITES) === "true" ||
          (window as any).__VG_LOG_RDF_WRITES === true;
        if (devMode) {
          (window as any).__VG_LOG_RDF_WRITES = true;
        }
        // install store-level write hook (logging gated inside emitWriteGraphCounts)
        enableWriteTracing();
        // Expose a runtime helper so you can enable tracing from the console:
        // window.__VG_ENABLE_RDF_WRITE_LOGGING && window.__VG_ENABLE_RDF_WRITE_LOGGING()
        (window as any).__VG_ENABLE_RDF_ENABLE_RDF_WRITE_LOGGING =
          (function () {
            // legacy compatibility alias (some dev envs may call the older name)
            try {
              (window as any).__VG_ENABLE_RDF_WRITE_LOGGING =
                (window as any).__VG_ENABLE_RDF_WRITE_LOGGING ||
                (() => {
                  try {
                    (window as any).__VG_LOG_RDF_WRITES = true;
                    enableWriteTracing();
                    return true;
                  } catch (err) {
                    return false;
                  }
                });
            } catch (_) {
              void 0;
            }
            return (window as any).__VG_ENABLE_RDF_WRITE_LOGGING;
          })();
        // Do not enable tracing proactively by default; keep it available via the console helper.
        // Tracing can be enabled by running:
        // window.__VG_ENABLE_RDF_WRITE_LOGGING && window.__VG_ENABLE_RDF_WRITE_LOGGING()
      }
    } catch (_) {
      try {
        if (typeof fallback === "function") {
          fallback("emptyCatch", { error: String(_) });
        }
      } catch (__) {
        /* ignore fallback errors */
      }
    }
  }

  // ---------- Change notification API ----------
  public onChange(cb: (count: number) => void): void {
    if (typeof cb !== "function") return;
    this.changeSubscribers.add(cb);
  }

  public offChange(cb: (count: number) => void): void {
    this.changeSubscribers.delete(cb);
  }

  private notifyChange(meta?: any) {
    try {
      // When persisting inferred quads (or performing other internal bulk writes)
      // we may want to suppress subject-level notifications to avoid re-triggering
      // mapping/reasoning loops. Callers (for example: the reasoning store) can
      // set the global flag __VG_REASONING_PERSIST_IN_PROGRESS to true while they
      // write inferred triples; here we honor that flag and skip invoking subscribers.
      try {
        if ((globalThis as any).__VG_REASONING_PERSIST_IN_PROGRESS) {
          // Update the counter for diagnostics but avoid invoking subscribers.
          this.changeCounter += 1;
          return;
        }
      } catch (_) {
        // ignore global flag read failures and proceed with normal notifications
      }

      this.changeCounter += 1;
      for (const cb of Array.from(this.changeSubscribers)) {
        try {
          // Pass both the numeric counter and an optional meta payload to subscribers.
          try {
            (cb as any)(this.changeCounter, meta);
          } catch (_) {
            // Fallback: call with just the numeric counter for subscribers that expect the old signature.
            cb(this.changeCounter);
          }
        } catch (_) {
          /* ignore individual subscriber errors */
        }
      }
    } catch (_) {
      try {
        if (typeof fallback === "function") {
          fallback("emptyCatch", { error: String(_) });
        }
      } catch (_) {
        /* ignore */
      }
    }
  }

  // Subject-level subscription API ------------------------------------------------
  public onSubjectsChange(cb: (subjects: string[]) => void): void {
    if (typeof cb !== "function") return;
    this.subjectChangeSubscribers.add(cb);
  }

  public offSubjectsChange(cb: (subjects: string[]) => void): void {
    this.subjectChangeSubscribers.delete(cb);
  }

  /**
   * Trigger subject-level change notifications for the provided list of subject IRIs.
   *
   * This public helper allows callers (for example: the reasoner or UI) to request
   * that the RDFManager emit the same subject-level events that would normally be
   * emitted when quads are added/removed via the manager's own APIs. The method
   * reads authoritative per-subject quads from the internal store (unless the
   * store is inaccessible) and runs the same reconciliation path used by the
   * internal subject flush so consumers receive consistent payloads.
   *
   * Note: callers must pass an array of IRIs (strings). The method will skip
   * blacklisted IRIs and will resolve only after subscribers have been invoked.
   */
  public async triggerSubjectUpdate(subjectIris: string[]): Promise<void> {
    try {
      // If the reasoner is persisting inferred triples, skip emitting subject updates
      // to avoid creating a feedback loop where reasoning writes -> notifications -> reasoning runs.
      try {
        if ((globalThis as any).__VG_REASONING_PERSIST_IN_PROGRESS) {
          try { console.debug("[VG_DEBUG] triggerSubjectUpdate.skipped_due_to_persist", { requestedCount: Array.isArray(subjectIris) ? subjectIris.length : 0, time: Date.now() }); } catch (_) { /* noop */ }
          return;
        }
      } catch (_) {
        /* ignore global flag read failures */
      }

      // Special debug marker for triggerSubjectUpdate invocations so we can trace explicit triggers
      try {
        console.debug("[VG_DEBUG_SPECIAL] triggerSubjectUpdate.called", {
          requestedCount: Array.isArray(subjectIris) ? subjectIris.length : 0,
          time: Date.now(),
        });
      } catch (_) {
        /* ignore logging failures */
      }
      if (!Array.isArray(subjectIris) || subjectIris.length === 0) return;

      const subjects: string[] = [];

      // Normalize and filter subjects (respect blacklist) and buffer them
      for (const sRaw of subjectIris) {
        try {
          const s = String(sRaw || "").trim();
          if (!s) continue;
          if (this.isBlacklistedIri && this.isBlacklistedIri(s)) continue;
          subjects.push(s);

          // Buffer authoritative per-subject quads when possible so scheduleSubjectFlush can emit them.
          try {
            const subjTerm = namedNode(String(s));
            const subjectQuads =
              this.store.getQuads(subjTerm, null, null, null) || [];
            if (Array.isArray(subjectQuads) && subjectQuads.length > 0) {
              const existing = this.subjectQuadBuffer.get(s) || [];
              existing.push(...subjectQuads);
              this.subjectQuadBuffer.set(s, existing);
            }
          } catch (_) {
            // ignore per-subject read failures but still ensure the subject is buffered
          }

          // Mark subject buffered so schedule/flush behavior is consistent
          try {
            this.subjectChangeBuffer.add(s);
          } catch (_) {
            /* ignore */
          }
        } catch (_) {
          /* ignore per-item failures */
        }
      }

      if (subjects.length === 0) return;

      // Schedule an immediate subject flush (async). scheduleSubjectFlush will
      // perform reconciliation and emit to subscribers in the same shape as normal.
      try {
        this.scheduleSubjectFlush(0);
      } catch (e) {
        try {
          if (typeof fallback === "function") {
            fallback("rdf.triggerSubjectUpdate.schedule_failed", {
              error: String(e),
            });
          }
        } catch (_) {
          /* ignore */
        }
      }
    } catch (err) {
      try {
        if (typeof fallback === "function") {
          fallback("rdf.triggerSubjectUpdate.failed", { error: String(err) });
        }
      } catch (_) {
        /* ignore fallback errors */
      }
    }
  }

  private scheduleSubjectFlush(delay = 50) {
    // If a parsing/load is still in progress, delay emitting subject-level notifications
    // until after namespaces/fat-map have been persisted. Parsing sets parsingInProgress = true
    // and finalize() will clear it and trigger an immediate flush.
    if (this.parsingInProgress) {
      return;
    }
    try {
      if (this.subjectFlushTimer) {
        window.clearTimeout(this.subjectFlushTimer);
      }
      this.subjectFlushTimer = window.setTimeout(async () => {
        try {
          if (this.subjectChangeBuffer.size === 0) {
            this.subjectFlushTimer = null;
            return;
          }
          // Filter out any blacklisted subjects before emitting. This ensures core vocab IRIs
          // (e.g., rdf:, rdfs:, owl:) do not trigger canvas updates even if they were buffered.
          const subjects = Array.from(this.subjectChangeBuffer).filter((s) => {
            try {
              return !(
                this.isBlacklistedIri && this.isBlacklistedIri(String(s))
              );
            } catch (_) {
              return true;
            }
          });

          // Build authoritative per-subject snapshots from the store (ensure parser writes are visible first).
          const _storeSnapshots: Quad[] = [];
          try {
            for (const s of subjects) {
              try {
                const subjTerm = namedNode(String(s));
                const subjectQuads =
                  this.store.getQuads(subjTerm, null, null, null) || [];
                if (Array.isArray(subjectQuads) && subjectQuads.length > 0) {
                  _storeSnapshots.push(...subjectQuads);
                }
              } catch (_) {
                /* ignore per-subject store read failures */
              }
            }
          } catch (_) {
            /* ignore overall snapshot build failures */
          }
          // Use undefined to signal a full rebuild only when there are no per-subject snapshots.
          const reconcileArg = _storeSnapshots;


          // After successful reconcile (or if none needed), clear buffered deltas and emit subscribers with authoritative quads.
          try {
            for (const s of subjects) {
              try {
                this.subjectQuadBuffer.delete(s);
              } catch (_) {
                void 0;
              }
            }
          } catch (_) {
            /* ignore */
          }

          try {
            this.subjectChangeBuffer.clear();
          } catch (_) {
            /* ignore */
          }
          try {
            this.subjectFlushTimer = null;
          } catch (_) {
            /* ignore */
          }

          const emitQuads: Quad[] = reconcileArg;
          for (const cb of Array.from(this.subjectChangeSubscribers)) {
            try {
              try {
                (cb as any)(subjects, emitQuads);
              } catch (_) {
                cb(subjects);
              }
            } catch (_) {
              /* ignore individual subscriber errors */
            }
          }
        } catch (e) {
          try {
            if (typeof fallback === "function") {
              fallback("rdf.subjectFlush.failed", { error: String(e) });
            }
          } catch (_) {
            /* ignore */
          }
        }
      }, delay);
    } catch (e) {
      try {
        if (typeof fallback === "function") {
          fallback("rdf.scheduleSubjectFlush.failed", { error: String(e) });
        }
      } catch (_) {
        /* ignore */
      }
    }
  }

  private bufferSubjectFromQuad(q: Quad | null | undefined) {
    try {
      if (!q || !q.subject || !q.subject.value) return;
      const subj = String((q.subject as any).value);
      // Respect configured blacklist: do not buffer or emit subjects from reserved vocabularies.
      if (this.isBlacklistedIri && this.isBlacklistedIri(subj)) {
        return;
      }

      // Buffer subject for emission
      this.subjectChangeBuffer.add(subj);

      // Also buffer the quad itself so consumers can receive the exact triples that changed.
      try {
        const existing = this.subjectQuadBuffer.get(subj) || [];
        existing.push(q as Quad);
        this.subjectQuadBuffer.set(subj, existing);
      } catch (_) {
        /* ignore quad buffering failures */
      }

      this.scheduleSubjectFlush();
    } catch (e) {
      try {
        if (typeof fallback === "function") {
          fallback("rdf.bufferSubject.failed", { error: String(e) });
        }
      } catch (_) {
        /* ignore */
      }
    }
  }

  // Helper: add a quad to the store with buffering and track addedQuads
  private addQuadToStore(toAdd: Quad, g: any, addedQuads: Quad[]): void {
    try {
      const exists =
        this.store.countQuads(toAdd.subject, toAdd.predicate, toAdd.object, g) >
        0;
      if (!exists) {
        this.store.addQuad(toAdd);
        try {
          // Update the explicit triple count so consumers relying on counts observe the new triples.
          try { (this as any).tripleCount = ((this as any).tripleCount || 0) + 1; } catch (_) { /* ignore */ }
        } catch (_) { /* ignore count errors */ }
        try {
          this.bufferSubjectFromQuad(toAdd);
        } catch (_) {
          /* ignore */
        }
        if (Array.isArray(addedQuads)) addedQuads.push(toAdd);

      }
    } catch (_) {
      try {
        // best-effort add
        this.store.addQuad(toAdd);
        if (Array.isArray(addedQuads)) addedQuads.push(toAdd);
      } catch (_) {
        /* ignore */
      }
    }
  }

  // Helper: finalize a load - apply prefixes, run reconciliation, notify and schedule subject flush
  private async finalizeLoad(
    addedQuads: Quad[],
    prefixes?: Record<string, any>,
    loadId?: string,
    graphName?: string,
  ): Promise<void> {
    try {
      // Capture raw parsed prefixes for inspection instead of merging them.
      // Push the raw object into a dev-only collection on window so developers can
      // inspect exactly what parsers emit before we decide a strict runtime type.
      // Normalize collected prefixes into the shape expected by applyParsedNamespaces.
      const normalizedPrefixMap: Record<string, any> = {};
      // prefixes may contain strings, NamedNode-like objects, or our new { prefix, raw } objects.
      for (const [p, v] of Object.entries(prefixes || {})) {
        try {
          const key = p === null || typeof p === "undefined" ? "" : String(p);
          let uri: string | undefined = undefined;
          if (v && typeof (v as any).raw === "string" && String((v as any).raw).trim() !== "") {
            uri = String((v as any).raw).trim();
          } else if (typeof v === "string" && String(v).trim() !== "") {
            uri = String(v).trim();
          } else if (v && typeof (v as any).value === "string" && String((v as any).value).trim() !== "") {
            uri = String((v as any).value).trim();
          }
          if (typeof uri === "string" && uri !== "") {
            // Keep the new object shape for downstream consumers.
            // Store default (empty) prefix under the literal ":" key as requested.
            const storageKey = key === "" ? ":" : key;
            normalizedPrefixMap[storageKey] = { prefix: storageKey, raw: uri };
          }
        } catch (_) {
          /* ignore per-entry */
        }
      }
      // Preserve raw & normalized prefixes for developer inspection
      try {
        (window as any).__VG_RAW_PARSED_PREFIXES = (window as any).__VG_RAW_PARSED_PREFIXES || [];
        (window as any).__VG_RAW_PARSED_PREFIXES.push({
          id: loadId || null,
          raw: prefixes,
          normalized: normalizedPrefixMap,
          time: Date.now(),
        });
      } catch (_) {
        /* ignore */
      }
      // Allow subject-level notification flushes now that parsing finished
      try {
        this.parsingInProgress = false;
      } catch (_) {
        /* ignore */
      }
      // Only merge parsed namespaces when the incoming load targeted the authoritative data graph (urn:vg:data).
      // Other named-graph loads (ontologies, inferred, etc.) may contain prefixes that should not be merged.
      try {
        if (String(graphName || "").includes("urn:vg:data")) {
          this.applyParsedNamespaces(normalizedPrefixMap);
        } else {
          // Persist raw parsed prefixes for diagnostics but skip merging for non-data graphs.
          try {
            (window as any).__VG_RAW_PARSED_PREFIXES =
              (window as any).__VG_RAW_PARSED_PREFIXES || [];
            (window as any).__VG_RAW_PARSED_PREFIXES.push({
              id: loadId || null,
              raw: prefixes,
              normalized: normalizedPrefixMap,
              time: Date.now(),
              note: "skipped-merge-non-data-graph",
              graphName: graphName || null,
            });
          } catch (_) {
            /* ignore */
          }
        }
      } catch (_) {
        /* ignore */
      }

      try {
        if (Array.isArray(addedQuads) && addedQuads.length > 0) {
            await (this as any).runReconcile(addedQuads);
          } else {
            this.notifyChange();
          }
      } catch (e) {
        try {
          fallback("rdf.finalizeLoad.reconcile_failed", { error: String(e) });
        } catch (_) {
          /* ignore */
        }
      }

      // Schedule subject-level flush immediately (only if window is available)
      try {
        if (typeof window !== "undefined") {
          this.scheduleSubjectFlush(0);
        }
      } catch (_) {
        /* ignore */
      }

      // After a load finalizes, proactively emit subject-level notifications for the
      // subjects that were part of this load. Emit directly (synchronously) so
      // subscribers registered before the load are guaranteed to receive the event.
      try {
        if (Array.isArray(addedQuads) && addedQuads.length > 0) {
          try {
            const subs = Array.from(
              new Set(
                (addedQuads || [])
                  .map((q: any) =>
                    q && q.subject && (q.subject as any).value
                      ? String((q.subject as any).value)
                      : null,
                  )
                  .filter((s) => s),
              ),
            );
            if (subs.length > 0) {
              // Build authoritative per-subject snapshots from the internal store
              const emitQuads: Quad[] = [];
              try {
                for (const s of subs) {
                  try {
                    const subjTerm = namedNode(String(s));
                    const subjectQuads =
                      this.store.getQuads(subjTerm, null, null, null) || [];
                    if (Array.isArray(subjectQuads) && subjectQuads.length > 0) {
                      emitQuads.push(...subjectQuads);
                    }
                  } catch (_) {
                    /* ignore per-subject read failures */
                  }
                }
              } catch (_) {
                /* ignore snapshot build failures */
              }

              // Emit directly to registered subject-change subscribers.
              console.debug("[VG_DEBUG] rdfManager.finalizeLoad.emitSubjects", {
                subs,
                emitCount: Array.isArray(emitQuads) ? emitQuads.length : 0,
              });
              for (const cb of Array.from(this.subjectChangeSubscribers)) {
                try {
                  (cb as any)(subs, emitQuads);
                } catch (e) {
                  console.error("[VG_ERROR] rdfManager.finalizeLoad.emitSubjects.failed", { error: String(e) });
                }
              }

              // Clear buffered deltas for these subjects to avoid duplicate emission later.
              try {
                for (const s of subs) {
                  try {
                    this.subjectQuadBuffer.delete(s);
                  } catch (_) {
                    /* ignore */
                  }
                }
                this.subjectChangeBuffer.clear();
              } catch (_) {
                /* ignore */
              }
            }
          } catch (_) {
            /* ignore per-load emission failures */
          }
        }
      } catch (_) {
        /* ignore overall errors */
      }

      // Developer debug: report per-graph triple counts after a batch load
      try {
        const allQuads = this.store.getQuads(null, null, null, null) || [];
        const graphCounts: Record<string, number> = {};
        for (const qq of allQuads) {
          try {
            const g =
              qq && qq.graph && (qq.graph as any).value
                ? (qq.graph as any).value
                : "default";
            graphCounts[g] = (graphCounts[g] || 0) + 1;
          } catch (_) {
            /* ignore per-quad counting failures */
          }
        }
        // per-load batchCounts logging removed — use collectGraphCountsFromStore(store) on demand for diagnostics
      } catch (_) {
        /* ignore */
      }
    } catch (err) {
      try {
        if (typeof fallback === "function")
          fallback("rdf.finalizeLoad.failed", { error: String(err) });
      } catch (_) {
        /* ignore */
      }
    }
  }

  async loadRDFIntoGraph(
    rdfContent: string,
    graphName?: string,
    mimeType?: string,
    filename?: string,
  ): Promise<void> {
    // Defensive guard: ensure we do not pass null/empty input into the parsers
    if (
      rdfContent === null ||
      typeof rdfContent !== "string" ||
      rdfContent.trim() === ""
    ) {
      throw new Error("Empty RDF content provided to loadRDFIntoGraph");
    }
    if (!graphName)
      return this.loadRDFIntoGraph(rdfContent, "urn:vg:data", mimeType);

    const rawKey =
      typeof rdfContent === "string" ? rdfContent : String(rdfContent);
    const normalized = rawKey.replace(/\s+/g, " ").trim();
    const key =
      normalized.length > 1000 ? `len:${normalized.length}` : normalized;

    if (this._inFlightLoads.has(key)) {
      return this._inFlightLoads.get(key)!;
    }

    const _vg_loadId = `load-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      incr("rdfLoads", 1);
      debugLog("rdf.load.start", {
        id: _vg_loadId,
        key,
        graphName: graphName || null,
        contentLen: (rdfContent && rdfContent.length) || 0,
        mimeType,
      });
    } catch (_) {
      try {
        if (typeof fallback === "function") {
          fallback("emptyCatch", { error: String(_) });
        }
      } catch (_) {
        /* ignore */
      }
    }

    let resolveFn!: () => void;
    let rejectFn!: (err: any) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    this._inFlightLoads.set(key, promise);
    // Mark that parsing is in progress so subject-level notification flushes are deferred
    {
      this.parsingInProgress = true;
    }

    const finalize = (prefixes?: Record<string, string>) => {
      // Notify subscribers that RDF changed
      this.notifyChange();
      {
        this.parsingInProgress = false;
      }
      {
        this.scheduleSubjectFlush(0);
      }
      {
        this.notifyChange();
      }

      // Developer debug: report per-graph triple counts after a batch load
      {
        const allQuads = this.store.getQuads(null, null, null, null) || [];
        const graphCounts: Record<string, number> = {};
        for (const qq of allQuads) {
          try {
            const g =
              qq && qq.graph && (qq.graph as any).value
                ? (qq.graph as any).value
                : "default";
            graphCounts[g] = (graphCounts[g] || 0) + 1;
          } catch (_) {
            /* ignore per-quad counting failures */
          }
        }
        // per-load batchCounts logging removed — use collectGraphCountsFromStore(store) on demand for diagnostics
      }

      resolveFn();
    };

    try {
      // Prefer the fast Turtle path, but detect XML/OWL and route to rdf-parse when appropriate.
      const g = namedNode(graphName);
      const addedQuads: Quad[] = [];

      // Do not mutate server-provided RDF content.
      rdfContent = rdfContent.replace(/^\s+/, "");

      // Heuristic detection for XML/RDF formats (filename or mimeType hints, or content markers).
      const looksLikeXml =
        (typeof mimeType === "string" && /xml/i.test(mimeType)) ||
        (typeof filename === "string" && /\.(rdf|owl|xml|rdfxml)$/i.test(filename)) ||
        /^\s*<\?xml/i.test(rdfContent) ||
        /<rdf:RDF\b/i.test(rdfContent) ||
        /<rdf:Description\b/i.test(rdfContent);

      if (looksLikeXml) {
        // Create a Node-style readable and hand off to rdf-parse which understands RDF/XML and others.
        // Prefer a Node-style readable for rdf-parse. createNodeReadableFromText will
        // return a Node Readable in Node-like environments; if it returns a WHATWG
        // ReadableStream, convert to a Node Readable when possible (Node 17+ Readable.fromWeb).
        let inputStream: any = await createNodeReadableFromText(rdfContent);
        if (!inputStream) {
          const maybeBody = (new Response(rdfContent).body as any);
          // If Node supports Readable.fromWeb, convert WHATWG ReadableStream to Node Readable.
          try {
            if (maybeBody && typeof maybeBody.getReader === "function") {
              const _stream = await import("stream").catch(() => null);
              const Readable = _stream ? (_stream as any).Readable : undefined;
              if (Readable && typeof (Readable as any).fromWeb === "function") {
                inputStream = (Readable as any).fromWeb(maybeBody);
              } else {
                // fallback to reading whole text and creating a Readable.from([Buffer])
                const _buf = await import("buffer").catch(() => null);
                const BufferImpl = _buf ? (_buf as any).Buffer : (globalThis as any).Buffer;
                if (BufferImpl) {
                  const _stream2 = await import("stream").catch(() => null);
                  const Readable2 = _stream2 ? (_stream2 as any).Readable : undefined;
                  if (Readable2 && typeof (Readable2 as any).from === "function") {
                    inputStream = (Readable2 as any).from([BufferImpl.from(String(rdfContent))]);
                  } else {
                    inputStream = maybeBody;
                  }
                } else {
                  inputStream = maybeBody;
                }
              }
            } else {
              inputStream = maybeBody;
            }
          } catch (_) {
            inputStream = (new Response(rdfContent).body as any);
          }
        }
        // Let rdf-parse infer content-type from provided mimeType or use RDF/XML as a sensible default.
        const quadStream = rdfParser.parse(inputStream, {
          contentType: mimeType || "application/rdf+xml",
          path: filename,
          baseIRI: undefined,
        });
        return await this.loadQuadsToDiagram(quadStream, graphName || "urn:vg:data");
      }

      // If content wasn't detected as XML, prefer the fast N3.Parser (Turtle) path.
      // On parser error, attempt a single rdf-parse fallback using the string content.
      this.parser.parse(rdfContent, async (error, quadItem, prefixes) => {
        if (error) {
          // Attempt rdf-parse fallback once for non-turtle inputs provided as text.
          // Prefer Node-style readable where possible; convert WHATWG streams to Node streams
          let inputStream: any = await createNodeReadableFromText(rdfContent);
          if (!inputStream) {
            const maybeBody = (new Response(rdfContent).body as any);
            try {
              if (maybeBody && typeof maybeBody.getReader === "function") {
                const _stream = await import("stream").catch(() => null);
                const Readable = _stream ? (_stream as any).Readable : undefined;
                if (Readable && typeof (Readable as any).fromWeb === "function") {
                  inputStream = (Readable as any).fromWeb(maybeBody);
                } else {
                  const _buf = await import("buffer").catch(() => null);
                  const BufferImpl = _buf ? (_buf as any).Buffer : (globalThis as any).Buffer;
                  if (BufferImpl) {
                    const _stream2 = await import("stream").catch(() => null);
                    const Readable2 = _stream2 ? (_stream2 as any).Readable : undefined;
                    if (Readable2 && typeof (Readable2 as any).from === "function") {
                      inputStream = (Readable2 as any).from([BufferImpl.from(String(rdfContent))]);
                    } else {
                      inputStream = maybeBody;
                    }
                  } else {
                    inputStream = maybeBody;
                  }
                }
              } else {
                inputStream = maybeBody;
              }
            } catch (_) {
              inputStream = (new Response(rdfContent).body as any);
            }
          }

          try {
            const quadStream = rdfParser.parse(inputStream, {
              contentType: mimeType || undefined,
              path: filename,
              baseIRI: undefined,
            });
            await this.loadQuadsToDiagram(quadStream, graphName || "urn:vg:data");
            resolveFn();
            return;
          } catch (fallbackErr) {
            // Fallback failed — expose diagnostic info and reject with the original parser error for context.
            if (typeof window !== "undefined") {
              try {
                (window as any).__VG_LAST_RDF = rdfContent;
              } catch (_) {
                /* ignore */
              }
              try {
                const lines = String(rdfContent || "").split(/\r?\n/);
                const snippet = lines.slice(0, Math.min(lines.length, 40)).join("\n");
                const errMsg = String(error);
                try {
                  (window as any).__VG_LAST_RDF_ERROR = { message: errMsg, snippet };
                } catch (_) {
                  /* ignore */
                }
                try {
                  window.dispatchEvent(new CustomEvent("vg:rdf-parse-error", { detail: { message: errMsg, snippet } }));
                } catch (_) {
                  /* ignore */
                }
                console.error("[VG_RDF_PARSE_ERROR]", errMsg.slice(0, 200), "snippet:", snippet.slice(0, 1000));
              } catch (_) {
                /* ignore diagnostic failures */
              }
            }
            rejectFn(error);
            return;
          }
        }

        if (quadItem) {
          // Add parsed quad into target graph
          if (quadItem && quadItem.subject && quadItem.predicate && quadItem.object) {
            const toAdd = quad(quadItem.subject, quadItem.predicate, quadItem.object, g);
            try {
              this.addQuadToStore(toAdd, g, addedQuads);
            } catch (_) {
              // Best-effort fallback
              try {
                this.store.addQuad(toAdd);
                if (Array.isArray(addedQuads)) addedQuads.push(toAdd);
              } catch (_) {
                /* ignore */
              }
            }
          }
        } else {
          // Parser finished: merge prefixes & finalize
          try {
            this.parsingInProgress = false;
          } catch (_) {
            /* ignore */
          }
          (async () => {
            try {
              await (this as any).finalizeLoad(addedQuads, prefixes, _vg_loadId, graphName);
            } catch (e) {
              try {
                rejectFn(e);
              } catch (_) {
                /* ignore */
              }
              return;
            }
            try {
              resolveFn();
            } catch (_) {
              /* ignore */
            }
          })();
        }
      });
    } catch (err) {
      try {
        rejectFn(err);
      } catch (_) {
        try {
          if (typeof fallback === "function") {
            fallback("emptyCatch", { error: String(_) });
          }
        } catch (_) {
          try {
            if (typeof fallback === "function") {
              fallback("emptyCatch", { error: String(_) });
            }
          } catch (__) {
            /* ignore fallback errors */
          }
        }
      }
    } finally {
      promise.finally(() => {
        try {
          this._inFlightLoads.delete(key);
        } catch (_) {
          try {
            if (typeof fallback === "function") {
              fallback("emptyCatch", { error: String(_) });
            }
          } catch (_) {
            /* ignore */
          }
        }
      });
    }

    return promise;
  }

  /**
   * Fetch a URL and return its RDF/text content and detected mime type.
   *
   * Pure browser-worker-only implementation:
   * - Spawn the browser worker which will fetch the URL itself and parse it.
   * - Worker emits batched plain quads, prefixes, and end/error messages which we ingest.
   * - On worker error we surface the error to the caller (no main-thread parsing fallback).
   */
    public async loadRDFFromUrl(
      url: string,
      graphName?: string,
      options?: { timeoutMs?: number; useWorker?: boolean },
    ): Promise<void> {
      if (!url) throw new Error("loadRDFFromUrl requires a url");
      // Use a long default timeout for large ontologies (configurable per-call)
      const timeoutMs = options?.timeoutMs ?? 120000;
      // Allow callers/tests to explicitly disable worker usage (main-thread parse fallback).
      const useWorker = options && typeof options.useWorker === "boolean" ? !!options.useWorker : true;

      // If caller requests no worker, perform a main-thread fetch + parse path.
      if (!useWorker) {
        try {
          const fetcher = typeof fetch === "function" ? fetch : undefined;
          if (!fetcher) throw new Error("fetch not available for main-thread loadRDFFromUrl");
          const resp = await fetcher(url);
          if (!resp || typeof resp.text !== "function") throw new Error("fetch failed in loadRDFFromUrl main-thread path");
          const txt = await resp.text();
          await this.loadRDFIntoGraph(txt, graphName, undefined, url);
          return;
        } catch (err) {
          // Surface fetch/parse errors to caller
          throw err;
        }
      }

    console.debug("[VG_RDF] loadRDFFromUrl (worker-only) start", {
      url,
      graphName,
      timeoutMs,
    });

    const loadId = `wl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
    const addedQuads: Quad[] = [];
    const collectedPrefixes: Record<string, any> = {};
    const targetGraph = namedNode(String(graphName || "urn:vg:data"));

    // Prefer worker parsing, but fall back to a main-thread fetch+parse when Worker is unavailable
    // (e.g. Node test environments). This keeps tests deterministic without a browser worker.
    let w: any = null;
    if (typeof Worker === "undefined" || typeof (globalThis as any).Worker === "undefined") {
      try {
        const fetcher = typeof fetch === "function" ? fetch : undefined;
        if (!fetcher) {
          throw new Error("Worker unavailable and fetch is not defined for main-thread fallback");
        }
        const resp = await fetcher(url);
        if (!resp || typeof resp.text !== "function") {
          throw new Error("Failed to fetch RDF for main-thread fallback");
        }
        const txt = await resp.text();

        // Try to create a Node Readable and parse with rdfParser (preferred for rdf-xml and node parsers)
        try {
          const { Readable } = await import("stream");
          const _buf = await import("buffer");
          const BufferImpl = (_buf && _buf.Buffer) || (globalThis as any).Buffer;
          if (!Readable || !BufferImpl) throw new Error("Node stream/buffer not available");

          const rs = Readable.from([BufferImpl.from(String(txt))]);
          const quadStream = rdfParser.parse(rs as any, { path: url, contentType: undefined });
          await this.loadQuadsToDiagram(quadStream, graphName || "urn:vg:data");
          return;
        } catch (nodeStreamErr) {
          // As a safe fallback, use the existing string-based loader which detects format and parses on main thread.
          await this.loadRDFIntoGraph(txt, graphName, undefined, url);
          return;
        }
      } catch (err) {
        // If fallback fails, surface the error to callers.
        throw err;
      }
    } else {
      const workerUrl = new URL("../workers/parseRdf.worker.ts", import.meta.url);
      w = new Worker(workerUrl as any, { type: "module" });
    }

    return new Promise<void>((resolve, reject) => {
      const tH = setTimeout(() => {
        try {
          w.terminate();
        } catch (_) { /* ignore */ }
        reject(new Error("parser worker timeout"));
      }, timeoutMs);

      let seenAny = false;

      const cleanupWorker = () => {
        try {
          w.removeEventListener("message", onMessage as any);
        } catch (_) { /* ignore */ }
        try { w.terminate(); } catch (_) { /* ignore */ }
        try { clearTimeout(tH); } catch (_) { /* ignore */ }
      };

      const onMessage = async (ev: MessageEvent) => {
        const m = ev && ev.data ? ev.data : {};
        try { seenAny = true; } catch (_) { /* noop */ }

        if (!m || !m.type) return;

        if (m.type === "start") {
          // worker indicates start; treat this as a liveness signal and clear the watchdog timer
          try {
            clearTimeout(tH);
            if (m.contentType) {
              console.debug("[VG_RDF] worker.start contentType", m.contentType);
            }
          } catch (_) { /* ignore */ }
          return;
        }

        if (m.type === "prefix" && m.prefixes) {
          try { Object.assign(collectedPrefixes, m.prefixes || {}); } catch (_) { /* ignore */ }
          return;
        }

        if (m.type === "quads" && Array.isArray(m.quads)) {
          try {
            const plain = m.quads as any[];
            for (const pq of plain) {
              try {
                const sTerm = /^_:/.test(String(pq.s || "")) ? blankNode(String(pq.s).replace(/^_:/, "")) : namedNode(String(pq.s));
                const pTerm = namedNode(String(pq.p));
                let oTerm: any = null;
                if (pq.o && pq.o.t === "iri") oTerm = namedNode(String(pq.o.v));
                else if (pq.o && pq.o.t === "bnode") oTerm = blankNode(String(pq.o.v));
                else if (pq.o && pq.o.t === "lit") {
                  if (pq.o.dt) oTerm = literal(String(pq.o.v), namedNode(String(pq.o.dt)));
                  else if (pq.o.ln) oTerm = literal(String(pq.o.v), String(pq.o.ln));
                  else oTerm = literal(String(pq.o.v));
                } else oTerm = literal(String((pq.o && pq.o.v) || ""));
                const gTerm = pq.g ? namedNode(String(pq.g)) : targetGraph;
                const toAdd = quad(sTerm, pTerm, oTerm, gTerm);
                try {
                  this.addQuadToStore(toAdd, gTerm, addedQuads);
                } catch (_) {
                  try { this.store.addQuad(toAdd); addedQuads.push(toAdd); } catch (_) { /* ignore */ }
                }
              } catch (_) {
                /* ignore per-quad ingestion errors */
              }
            }
            // ACK to worker so it can continue
            try { w.postMessage({ type: "ack", id: String(m.id || loadId) }); } catch (_) { /* ignore */ }
          } catch (e) {
            /* ignore batch processing errors */
          }
          return;
        }

        if (m.type === "end") {
          try {
            cleanupWorker();
            clearTimeout(tH);
          } catch (_) { /* ignore */ }
          try {
            (async () => {
            try {
            await (this as any).finalizeLoad(addedQuads, collectedPrefixes || {}, loadId, graphName);
          } catch (e) {
            try { console.error("[VG_RDF] worker finalize failed", e); } catch (_) { /* ignore */ }
            reject(e);
            return;
          }
          resolve();
            })();
          } catch (e) {
            reject(e);
          }
          return;
        }

        if (m.type === "error") {
          try { cleanupWorker(); clearTimeout(tH); } catch (_) { /* ignore */ }
          try {
            // Propagate only the worker-provided error text (string) to callers and clear parsing flag
            const msgText = m && m.message ? String(m.message) : "worker error";
            try { (this as any).parsingInProgress = false; } catch (_) { /* ignore */ }
            reject(msgText);
          } catch (_) { /* ignore */ }
          return;
        }
      };

      w.addEventListener("message", onMessage as any);

      // Start worker fetching & parsing for the URL
      try {
        w.postMessage({ type: "parseUrl", id: loadId, url, timeoutMs, headers: { Accept: "text/turtle, application/rdf+xml, application/ld+json, */*" } });
      } catch (err) {
        try { cleanupWorker(); } catch (_) { /* ignore */ }
        reject(err);
      }
    });
  }

  exportToTurtle(): Promise<string> {
    return new Promise((resolve, reject) => {
      const writer = new Writer({
        prefixes: this.namespaces,
        format: "text/turtle",
      });

      // Export only triples from the authoritative data graph (urn:vg:data)
      const dataGraph = namedNode("urn:vg:data");
      let quads = this.store.getQuads(null, null, null, dataGraph) || [];

      // Defensive filter: ensure only well-formed quads with N3 Terms reach the writer.
      quads = quads.filter((q: any) => {
        try {
          return (
            q &&
            q.subject &&
            q.predicate &&
            q.object &&
            typeof (q.subject as any).termType === "string" &&
            typeof (q.predicate as any).termType === "string" &&
            // object may be literal or named node; ensure termType present
            typeof (q.object as any).termType === "string"
          );
        } catch (_) {
          return false;
        }
      });

      // Convert named-graph quads into plain triples (no graph) so the writer emits
      // standard triple statements rather than named-graph blocks.
      const triples = (quads || []).map((q: any) => {
        try {
          return quad(
            (q as any).subject,
            (q as any).predicate,
            (q as any).object,
            defaultGraph(),
          );
        } catch (_) {
          return q;
        }
      });

      writer.addQuads(triples);

      writer.end((error, result) => {
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
      });
    });
  }

  /**
   * Export the current store to JSON-LD format
   */
  exportToJsonLD(): Promise<string> {
    return new Promise((resolve, reject) => {
      const writer = new Writer({
        prefixes: this.namespaces,
        format: "application/ld+json",
      });

      // Export only triples from the authoritative data graph (urn:vg:data)
      const dataGraph = namedNode("urn:vg:data");
      let quads = this.store.getQuads(null, null, null, dataGraph) || [];
      quads = quads.filter((q: any) => {
        try {
          return (
            q &&
            q.subject &&
            q.predicate &&
            q.object &&
            typeof (q.subject as any).termType === "string" &&
            typeof (q.predicate as any).termType === "string" &&
            typeof (q.object as any).termType === "string"
          );
        } catch (_) {
          return false;
        }
      });

      // Convert to triples (drop graph) so JSON-LD writer doesn't emit named graph wrappers.
      const triplesForJsonLd = (quads || []).map((q: any) => {
        try {
          return quad(
            (q as any).subject,
            (q as any).predicate,
            (q as any).object,
            defaultGraph(),
          );
        } catch (_) {
          return q;
        }
      });
      writer.addQuads(triplesForJsonLd);

      writer.end((error, result) => {
        if (error) {
          reject(error);
        } else {
          try {
            // Unwrap any named-graph wrapper for the data graph so JSON-LD writer receives plain triples.
            // For JSON-LD we prefer to return the writer's result unchanged except when a named-graph
            // wrapper is present in Turtle form - handle conservatively by returning the result as-is.
            resolve(result);
          } catch (e) {
            resolve(result);
          }
        }
      });
    });
  }

  /**
   * Export the current store to RDF/XML format
   */
  exportToRdfXml(): Promise<string> {
    return new Promise((resolve, reject) => {
      const writer = new Writer({
        prefixes: this.namespaces,
        format: "application/rdf+xml",
      });

      // Export only triples from the authoritative data graph (urn:vg:data)
      const dataGraph = namedNode("urn:vg:data");
      let quads = this.store.getQuads(null, null, null, dataGraph) || [];
      quads = quads.filter((q: any) => {
        try {
          return (
            q &&
            q.subject &&
            q.predicate &&
            q.object &&
            typeof (q.subject as any).termType === "string" &&
            typeof (q.predicate as any).termType === "string" &&
            typeof (q.object as any).termType === "string"
          );
        } catch (_) {
          return false;
        }
      });

      // Convert to triples (drop graph) so RDF/XML writer emits triples rather than named-graph constructs.
      const triplesForXml = (quads || []).map((q: any) => {
        try {
          return quad(
            (q as any).subject,
            (q as any).predicate,
            (q as any).object,
            defaultGraph(),
          );
        } catch (_) {
          return q;
        }
      });
      writer.addQuads(triplesForXml);

      writer.end((error, result) => {
        if (error) {
          reject(error);
        } else {
          try {
            // For RDF/XML ensure we return the writer output; named-graph wrappers are unlikely here,
            // but keep a defensive passthrough.
            resolve(result);
          } catch (e) {
            resolve(result);
          }
        }
      });
    });
  }

  /**
   * Get all namespaces/prefixes
   */
  getNamespaces(): Record<string, string> {
    return { ...(this.namespaces || {}) };
  }

  /**
   * Add a new namespace
   *
   * Only accept well-formed namespace URIs. Accept either:
   * - a string URI, or
   * - an object with a string `.value` property (RDFJS NamedNode)
   *
   * If the incoming value cannot be converted to a non-empty string, the prefix is ignored.
   */
  addNamespace(prefix: string, uri: any): void {
    // allow empty-string prefix (default namespace). Only skip truly missing keys.
    if (prefix === null || typeof prefix === "undefined") return;
    // coerce incoming uri to a string only for supported shapes
    let uriStr = "";
    if (typeof uri === "string") uriStr = uri;
    else if (uri && typeof (uri as any).value === "string")
      uriStr = String((uri as any).value);
    if (!uriStr) return;

    const prev = Object.prototype.hasOwnProperty.call(this.namespaces, prefix)
      ? this.namespaces[prefix]
      : undefined;
    const changed = prev === undefined || String(prev) !== uriStr;

    // Update internal map
    this.namespaces[prefix] = uriStr;

    // Persisting the registry is handled by the reconcile/fat-map path only.
    if (changed) {
      {
        this.notifyChange({ kind: "namespaces", prefixes: [prefix] });
      }
    }
  }

  /**
   * Remove a namespace prefix (or a namespace URI) and remove quads that reference that namespace.
   *
   * This is a best-effort cleanup: it will remove any triple where the subject, predicate,
   * or object IRI starts with the namespace URI. It accepts either a known prefix (e.g. "foaf")
   * or a full namespace URI. If a prefix is provided the corresponding URI from the manager's
   * namespace map is used.
   */
  removeNamespaceAndQuads(prefixOrUri: string): void {
    try {
      // Resolve to a namespace URI and prefix if possible
      let nsUri: string | undefined;
      let prefixToRemove: string | undefined;

      if (this.namespaces[prefixOrUri]) {
        prefixToRemove = prefixOrUri;
        nsUri = this.namespaces[prefixOrUri];
      } else {
        // treat input as a URI and find matching prefix
        for (const [p, u] of Object.entries(this.namespaces)) {
          if (u === prefixOrUri) {
            prefixToRemove = p;
            nsUri = u;
            break;
          }
        }
        // if not found as exact match, accept prefixOrUri as URI-like if it looks like one
        if (
          !nsUri &&
          (prefixOrUri.startsWith("http://") ||
            prefixOrUri.startsWith("https://"))
        ) {
          nsUri = prefixOrUri;
        }
      }

      if (!nsUri) return;

      // Remove quads whose subject/predicate/object starts with nsUri
      try {
        const all = this.store.getQuads(null, null, null, null) || [];
        all.forEach((q: Quad) => {
          try {
            const subj = (q.subject && (q.subject as any).value) || "";
            const pred = (q.predicate && (q.predicate as any).value) || "";
            const obj = (q.object && (q.object as any).value) || "";
            if (
              subj.startsWith(nsUri) ||
              pred.startsWith(nsUri) ||
              obj.startsWith(nsUri)
            ) {
              try {
                this.store.removeQuad(q);
              } catch (_) {
                try {
                  if (typeof fallback === "function") {
                    fallback("emptyCatch", { error: String(_) });
                  }
                } catch (_) {
                  /* ignore */
                }
              }
            }
          } catch (_) {
            try {
              if (typeof fallback === "function") {
                fallback("emptyCatch", { error: String(_) });
              }
            } catch (_) {
              /* ignore */
            }
          }
        });
      } catch (e) {
        try {
          if (typeof fallback === "function") {
            fallback("emptyCatch", { error: String(e) });
          }
        } catch (_) {
          try {
            if (typeof fallback === "function") {
              fallback("emptyCatch", { error: String(_) });
            }
          } catch (__) {
            /* ignore fallback errors */
          }
        }
      }

      // Finally remove the prefix mapping if we found a prefix to remove
      if (prefixToRemove) {
        try {
          delete this.namespaces[prefixToRemove];
        } catch (_) {
          try {
            if (typeof fallback === "function") {
              fallback("emptyCatch", { error: String(_) });
            }
          } catch (_) {
            /* ignore */
          }
        }
      } else {
        // If no prefix matched but caller provided a URI, remove any prefixes that map to that URI
        try {
          for (const [p, u] of Object.entries({ ...this.namespaces })) {
            if (u === nsUri) {
              try {
                delete this.namespaces[p];
              } catch (_) {
                try {
                  if (typeof fallback === "function") {
                    fallback("emptyCatch", { error: String(_) });
                  }
                } catch (_) {
                  /* ignore */
                }
              }
            }
          }
        } catch (_) {
          try {
            if (typeof fallback === "function") {
              fallback("emptyCatch", { error: String(_) });
            }
          } catch (_) {
            /* ignore */
          }
        }
      }

      // Notify subscribers that namespaces changed (best-effort)
      try {
        this.notifyChange({
          kind: "namespaces",
          prefixes: prefixToRemove ? [prefixToRemove] : [],
        });
      } catch (_) {
        /* ignore */
      }
    } catch (err) {
      // best-effort: log and continue
      try {
        try {
          if (typeof fallback === "function") {
            try {
              fallback(
                "console.warn",
                {
                  args: [
                    err && (err as any).message
                      ? (err as any).message
                      : String(err),
                  ],
                },
                { level: "warn" },
              );
            } catch (_) {
              void 0;
            }
          }
        } catch (_) {
          void 0;
        }
        console.warn("removeNamespaceAndQuads failed:", err);
      } catch (_) {
        try {
          if (typeof fallback === "function") {
            fallback("emptyCatch", { error: String(err) });
          }
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  /**
   * Remove all quads stored in the named graph identified by graphName.
   * Best-effort and idempotent.
   */
  removeGraph(graphName: string): void {
    try {
      if (!graphName) return;
      const g = namedNode(graphName);
      const quads = this.store.getQuads(null, null, null, g) || [];
      quads.forEach((q: Quad) => {
        try {
          // Buffer removed quad so subject-level subscribers are notified.
          try {
            this.bufferSubjectFromQuad(q);
          } catch (_) {
            /* ignore */
          }
          try {
            // Keep index in sync (best-effort)
            try { this.indexRemove(graphName, q); } catch (_) { /* ignore */ }
          } catch (_) { /* ignore */ }
          this.store.removeQuad(q);
        } catch (_) {
          try {
            if (typeof fallback === "function") {
              fallback("emptyCatch", { error: String(_) });
            }
          } catch (_) {
            /* ignore */
          }
        }
      });
      // Notify subscribers that RDF changed (graph removal)
      try {
        this.notifyChange();
      } catch (_) {
        /* ignore */
      }
    } catch (err) {
      try {
        try {
          if (typeof fallback === "function") {
            try {
              fallback(
                "console.warn",
                {
                  args: [
                    err && (err as any).message
                      ? (err as any).message
                      : String(err),
                  ],
                },
                { level: "warn" },
              );
            } catch (_) {
              void 0;
            }
          }
        } catch (_) {
          void 0;
        }
        console.warn("removeGraph failed:", err);
      } catch (_) {
        try {
          if (typeof fallback === "function") {
            fallback("emptyCatch", { error: String(err) });
          }
        } catch (_) {
          /* ignore */
        }
      }
    }
  }

  /**
   * Remove quads in a specific named graph that match any of the provided namespace URIs.
   * Useful for removing an ontology's quads from a shared ontologies graph without touching other graphs.
   */
  public removeQuadsInGraphByNamespaces(
    graphName: string,
    namespaceUris?: string[] | null,
  ): void {
    try {
      if (
        !graphName ||
        !Array.isArray(namespaceUris) ||
        namespaceUris.length === 0
      )
        return;
      const g = namedNode(graphName);
      const quads = this.store.getQuads(null, null, null, g) || [];
      quads.forEach((q: Quad) => {
        try {
          const subj = (q.subject && (q.subject as any).value) || "";
          const pred = (q.predicate && (q.predicate as any).value) || "";
          const obj = (q.object && (q.object as any).value) || "";
          const matches = (namespaceUris || []).some(
            (ns) =>
              ns &&
              (subj.startsWith(ns) ||
                pred.startsWith(ns) ||
                obj.startsWith(ns)),
          );
          if (matches) {
            try {
              // Buffer removed quad so subject-level subscribers are notified.
              try {
                this.bufferSubjectFromQuad(q);
              } catch (_) {
                /* ignore */
              }
              this.store.removeQuad(q);
            } catch (_) {
              /* ignore */
            }
          }
        } catch (_) {
          /* ignore */
        }
      });
      try {
        this.notifyChange();
      } catch (_) {
        /* ignore */
      }
    } catch (err) {
      try {
        if (typeof fallback === "function") {
          fallback("rdf.removeQuadsInGraphByNamespaces.failed", {
            graphName,
            error: String(err),
          });
        }
      } catch (_) {
        /* ignore */
      }
    }
  }

  /**
   * Remove all quads for a given IRI appearing either as subject or as a named-node object
   * inside the specified named graph (defaults to urn:vg:data). This is idempotent and emits
   * a single notifyChange() after the removals. Blank-node subjects (prefixed "_:b0") are supported.
   */
  public async removeAllQuadsForIri(
    iri: string,
    graphName: string = "urn:vg:data",
  ): Promise<void> {
    try {
      if (!iri) return;
      const g = namedNode(String(graphName));
      // Subject term may be a blank node or named node
      const subjTerm = /^_:/i.test(String(iri))
        ? blankNode(String(iri).replace(/^_:/, ""))
        : namedNode(String(iri));
      // Remove quads where subject === iri
      try {
        const subjQuads = this.store.getQuads(subjTerm, null, null, g) || [];
        for (const q of subjQuads) {
          try {
            this.bufferSubjectFromQuad(q);
          } catch (_) {
            void 0;
          }
          try {
            this.store.removeQuad(q);
          } catch (_) {
            void 0;
          }
        }
      } catch (_) {
        /* ignore per-subject remove failures */
      }

      // Remove quads where object === iri (object must be a named node to match IRIs)
      try {
        const objTerm = namedNode(String(iri));
        const objQuads = this.store.getQuads(null, null, objTerm, g) || [];
        for (const q of objQuads) {
          try {
            this.bufferSubjectFromQuad(q);
          } catch (_) {
            void 0;
          }
          try {
            this.store.removeQuad(q);
          } catch (_) {
            void 0;
          }
        }
      } catch (_) {
        /* ignore per-object remove failures */
      }

      // Notify subscribers once
      try {
        this.notifyChange({
          kind: "removeAllQuadsForIri",
          iri,
          graph: graphName,
        });
      } catch (_) {
        void 0;
      }
    } catch (err) {
      try {
        fallback("rdf.removeAllQuadsForIri.failed", {
          iri,
          graphName,
          error: String(err),
        });
      } catch (_) {
        void 0;
      }
    }
  }

  /**
   * Expand a prefixed URI to full URI
   */
  expandPrefix(prefixedUri: string): string {
    const colonIndex = prefixedUri.indexOf(":");
    if (colonIndex === -1) return prefixedUri;

    const prefix = prefixedUri.substring(0, colonIndex);
    const localName = prefixedUri.substring(colonIndex + 1);
    const namespaceUri = this.namespaces[prefix];

    // If prefix is known, expand normally
    if (namespaceUri) {
      return `${namespaceUri}${localName}`;
    }

    // Common fallback for widely-used prefixes when not explicitly declared.
    const wellKnownFallbacks: Record<string, string> = {
      dc: "http://purl.org/dc/elements/1.1/",
      foaf: "http://xmlns.com/foaf/0.1/",
      skos: "http://www.w3.org/2004/02/skos/core#",
    };

    // Also consult WELL_KNOWN prefixes as a non-persistent fallback (do not overwrite existing mappings).
    {
      const wk = (WELL_KNOWN && (WELL_KNOWN as any).prefixes) || {};
      Object.entries(wk).forEach(([k, v]) => {
        try {
          if (!wellKnownFallbacks[k] && typeof v === "string")
            wellKnownFallbacks[k] = v;
        } catch (_) {
          void 0;
        }
      });
    }

    if (wellKnownFallbacks[prefix]) {
      // Add fallback to namespaces so exports include the prefix
      this.namespaces[prefix] = wellKnownFallbacks[prefix];
      return `${wellKnownFallbacks[prefix]}${localName}`;
    }

    // As a last resort, try to discover a namespace from WELL_KNOWN.ontologies entries
    // by looking for any ontology that declares this prefix in its namespaces map.
    try {
      const wkOnt = (WELL_KNOWN && (WELL_KNOWN as any).ontologies) || {};
      for (const [, meta] of Object.entries(wkOnt || {})) {
        try {
          const m = meta as any;
          if (m && m.namespaces && m.namespaces[prefix]) {
            const ns = String(m.namespaces[prefix]);
            // Persist discovered mapping so subsequent calls will expand normally
            this.namespaces[prefix] = ns;
            return `${ns}${localName}`;
          }
        } catch (_) {
          /* ignore per-entry failures */
        }
      }
    } catch (_) {
      try {
        if (typeof fallback === "function") {
          fallback("emptyCatch", { error: String(_) });
        }
      } catch (__) {
        /* ignore fallback errors */
      }
    }

    // Unknown prefix – return original string so caller can decide how to handle it
    return prefixedUri;
  }

  /**
   * Unified helper: emit a compact write-diagnostic after any write action.
   * - action: short string describing the cause (e.g. "add", "remove", "addWorkerBatch")
   * - sample: optional quad or term-like sample for quick inspection (kept small)
   *
   * This is gated by the existing runtime debug flags so it follows the app config.
   */
  private emitWriteGraphCounts(action: string, sample?: any) {
    try {
      if (typeof window === "undefined") return;
      const enabled = !!((window as any).__VG_LOG_RDF_WRITES === true || (window as any).__VG_DEBUG__);
      if (!enabled) return;
        // write logging disabled (use collectGraphCountsFromStore(store) explicitly when needed)
        return;
      } catch (_) {
        /* ignore top-level */
      }
  }

  /**
   * Return counts grouped by graph name (string -> number).
   * Graph name is the NamedNode.value or "default" for default graph.
   * This is a fast in-memory scan of the N3 store and intended for diagnostic use only.
   */
  public getGraphCounts(): Record<string, number> {
    try {
      const all = this.store.getQuads(null, null, null, null) || [];
      const graphCounts: Record<string, number> = {};
      for (const q of all) {
        try {
          const g = q && q.graph && (q.graph as any).value ? (q.graph as any).value : "default";
          graphCounts[g] = (graphCounts[g] || 0) + 1;
        } catch (_) {
          /* ignore per-quad */
        }
      }
      return graphCounts;
    } catch (_) {
      return {};
    }
  }

  /**
   * Get the store instance for direct access
   */
  getStore(): Store {
    return this.store;
  }

  // ---------- Lightweight per-graph index helpers ----------
  // Create a stable, unique string key for a quad (used by the per-graph index)
  private quadKey(q: Quad | { subject?: any; predicate?: any; object?: any; graph?: any }): string {
    try {
      const s = q && (q as any).subject && (q as any).subject.value ? String((q as any).subject.value) : String((q as any).subject || "");
      const p = q && (q as any).predicate && (q as any).predicate.value ? String((q as any).predicate.value) : String((q as any).predicate || "");
      const o = q && (q as any).object && (q as any).object.value ? String((q as any).object.value) : String((q as any).object || "");
      const g = q && (q as any).graph && (q as any).graph.value ? String((q as any).graph.value) : String((q as any).graph || "");
      return `${s}|${p}|${o}|${g}`;
    } catch (_) {
      return String(Math.random()).slice(2);
    }
  }

  // Ensure an index exists for the named graph. If absent, build it lazily from the store.
  private ensureIndexForGraph(graphName: string) {
    try {
      if (!graphName) return;
      if (this._graphIndex.has(graphName)) return;
      const gTerm = namedNode(String(graphName));
      const quads = this.store.getQuads(null, null, null, gTerm) || [];
      const keys: string[] = [];
      const map = new Map<string, Quad>();
      for (const q of quads) {
        try {
          const k = this.quadKey(q);
          if (!map.has(k)) {
            map.set(k, q);
            keys.push(k);
          }
        } catch (_) { /* ignore per-quad */ }
      }
      this._graphIndex.set(graphName, {
        keys,
        map,
        tombstones: new Set(),
        tombstoneCount: 0,
        lastCompact: Date.now(),
      });
    } catch (_) {
      /* ignore */
    }
  }

  // Add a quad to the per-graph index (called after successful store.addQuad)
  private indexAdd(graphName: string, q: Quad) {
    try {
      if (!graphName || !q) return;
      this.ensureIndexForGraph(graphName);
      const idx = this._graphIndex.get(graphName);
      if (!idx) return;
      const k = this.quadKey(q);
      if (idx.map.has(k)) return;
      idx.map.set(k, q);
      idx.keys.push(k);
    } catch (_) {
      /* ignore */
    }
  }

  // Remove a quad from the per-graph index (mark tombstone / decrement count)
  private indexRemove(graphName: string, q: Quad) {
    try {
      if (!graphName || !q) return;
      const idx = this._graphIndex.get(graphName);
      if (!idx) return;
      const k = this.quadKey(q);
      if (!idx.map.has(k)) return;
      idx.map.delete(k);
      if (!idx.tombstones.has(k)) {
        idx.tombstones.add(k);
        idx.tombstoneCount = (idx.tombstoneCount || 0) + 1;
      }
      // Periodic compaction: if too many tombstones, rebuild the keys array
      try {
        const THRESHOLD_RATIO = 0.10; // 10%
        if (idx.tombstoneCount > 1000 || (idx.tombstoneCount / Math.max(1, idx.keys.length)) > THRESHOLD_RATIO) {
          const newKeys: string[] = [];
          for (const key of idx.keys) {
            if (!idx.tombstones.has(key)) newKeys.push(key);
          }
          idx.keys = newKeys;
          idx.tombstones.clear();
          idx.tombstoneCount = 0;
          idx.lastCompact = Date.now();
        }
      } catch (_) { /* ignore compaction errors */ }
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Fetch a page of quads from a named graph using the internal index for performance.
   *
   * Options:
   *  - serialize (default true) : return plain string triples {subject,predicate,object,graph}
   *  - fields: optional projection
   *  - filter: simple exact-match filters (subject/predicate/object) - best-effort (may scan keys)
   */
  public async fetchQuadsPage(
    graphName: string,
    offset: number,
    limit: number,
    options?: { serialize?: boolean; fields?: ("subject"|"predicate"|"object"|"graph")[]; filter?: { subject?: string; predicate?: string; object?: string } }
  ): Promise<{ total: number; offset: number; limit: number; items: any[] }> {
    try {
      if (!graphName) return { total: 0, offset: 0, limit: 0, items: [] };
      const serialize = options && typeof options.serialize === "boolean" ? !!options.serialize : true;
      const filter = options && options.filter ? options.filter : undefined;

      // Ensure index exists (lazy build)
      this.ensureIndexForGraph(graphName);
      const idx = this._graphIndex.get(graphName);
      if (!idx) {
        return { total: 0, offset, limit, items: [] };
      }

      // If a filter is provided we need to scan keys and collect matching items.
      if (filter && (filter.subject || filter.predicate || filter.object)) {
        const matched: any[] = [];
        for (const k of idx.keys) {
          if (idx.tombstones.has(k)) continue;
          const q = idx.map.get(k);
          if (!q) continue;
          try {
            if (filter.subject && String((q.subject as any).value || q.subject || "") !== String(filter.subject)) continue;
            if (filter.predicate && String((q.predicate as any).value || q.predicate || "") !== String(filter.predicate)) continue;
            if (filter.object && String((q.object as any).value || q.object || "") !== String(filter.object)) continue;
            matched.push(q);
          } catch (_) { /* ignore */ }
          if (matched.length >= offset + limit) break;
        }
        const total = matched.length;
        const slice = matched.slice(offset, offset + limit);
        const items = serialize ? slice.map((q: any) => ({ subject: q.subject && q.subject.value ? String(q.subject.value) : String(q.subject || ""), predicate: q.predicate && q.predicate.value ? String(q.predicate.value) : String(q.predicate || ""), object: q.object && q.object.value ? String(q.object.value) : String(q.object || ""), graph: q.graph && q.graph.value ? String(q.graph.value) : String(q.graph || "") })) : slice;
        return { total, offset, limit, items };
      }

      // Normal path: stable keys available; compute total and slice directly.
      const total = Math.max(0, idx.keys.length - idx.tombstoneCount);
      // Clamp offset
      const off = Math.max(0, offset || 0);
      const result: any[] = [];
      let collected = 0;
      let position = 0;
      // Fast-forward to offset by iterating keys but skipping tombstones without allocating all quads.
      for (let i = 0; i < idx.keys.length && collected < offset + limit; i++) {
        const k = idx.keys[i];
        if (idx.tombstones.has(k)) continue;
        if (position < off) { position++; continue; }
        const q = idx.map.get(k);
        if (!q) continue;
        result.push(q);
        collected++;
      }

      const items = serialize ? result.map((q: any) => ({ subject: q.subject && q.subject.value ? String(q.subject.value) : String(q.subject || ""), predicate: q.predicate && q.predicate.value ? String(q.predicate.value) : String(q.predicate || ""), object: q.object && q.object.value ? String(q.object.value) : String(q.object || ""), graph: q.graph && q.graph.value ? String(q.graph.value) : String(q.graph || "") })) : result;
      return { total, offset: off, limit, items };
    } catch (e) {
      try { fallback("rdf.fetchQuadsPage.failed", { graphName, offset, limit, error: String(e) }); } catch(_) { /* ignore */ }
      return { total: 0, offset, limit, items: [] };
    }
  }

  /**
   * Emit subject-level change notifications for every subject found in the specified graph.
   *
   * Convenience wrapper that collects all unique subject IRIs from the given named graph
   * (defaults to "urn:vg:data") and delegates to triggerSubjectUpdate which performs
   * blacklist filtering and authoritative per-subject snapshot building.
   *
   * Returns a Promise that resolves after triggerSubjectUpdate completes.
   */
  public async emitAllSubjects(graphName: string = "urn:vg:data"): Promise<void> {
    try {
      if (!graphName) return;
      // Special debug marker so developers can easily find emitAllSubjects calls in the browser console.
      // Example: open http://localhost:8080/?rdfUrl=... and look for "[VG_DEBUG_SPECIAL] emitAllSubjects.triggered"
      try {
        console.debug("[VG_DEBUG_SPECIAL] emitAllSubjects.triggered", {
          graphName,
          bufferedSubjectsCount: Array.from((this as any).subjectChangeBuffer || []).length,
          time: Date.now(),
        });
      } catch (_) {
        /* ignore logging failures */
      }
      const g = namedNode(String(graphName));
      const allQuads = this.store.getQuads(null, null, null, g) || [];

      // Collect unique subject IRIs and ensure the resulting array is strongly typed as string[]
      const rawSubjects = (allQuads || []).map((q: any) =>
        q && q.subject && (q.subject as any).value
          ? String((q.subject as any).value)
          : null,
      );
      const subjects = Array.from(new Set(rawSubjects.filter((s): s is string => !!s)));

      if (!Array.isArray(subjects) || subjects.length === 0) return;
      await this.triggerSubjectUpdate(subjects as string[]);
    } catch (err) {
      try {
        if (typeof fallback === "function")
          fallback("rdf.emitAllSubjects.failed", {
            graphName,
            error: String(err),
          });
      } catch (_) {
        /* ignore */
      }
    }
  }

  /**
   * updateNode - convenience helper to update node-level information (annotationProperties, rdfTypes)
   * Backwards-compatible helper used by tests and some callers. Applies idempotent adds (and optional removes)
   * into urn:vg:data using applyBatch or addTriple as available on this manager.
   *
   * This method is best-effort and will swallow errors to avoid breaking callers/tests.
   */
  public updateNode(entityUri: string, updates: any): void {
    {
      if (!entityUri || !updates) return;

      const subjIri = String(entityUri);
      const gName = "urn:vg:data";
      const g = namedNode(gName);
      const s = namedNode(subjIri);

      // determine rdf:type predicate IRI
      const rdfTypePred =
        typeof this.expandPrefix === "function"
          ? this.expandPrefix("rdf:type")
          : "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

      // Build incoming annotation predicate set and prepared rdfTypes
      const incomingAnn = Array.isArray(updates.annotationProperties)
        ? updates.annotationProperties
        : [];
      const incomingPreds = new Set<string>();
      for (const ap of incomingAnn) {
        try {
          const predRaw =
            (ap && (ap.propertyUri || ap.property || ap.key)) || "";
          const pred =
            predRaw && typeof this.expandPrefix === "function"
              ? this.expandPrefix(String(predRaw))
              : String(predRaw);
          if (pred) incomingPreds.add(String(pred));
        } catch (_) {
          /* ignore */
        }
      }
      const incomingTypes = Array.isArray(updates.rdfTypes)
        ? updates.rdfTypes.map((t: any) =>
            typeof this.expandPrefix === "function"
              ? this.expandPrefix(String(t))
              : String(t),
          )
        : [];

      // Replacement semantics implemented via applyBatch removes to ensure atomicity:
      // - Build a set of removes that clear all existing non-rdf:type annotation triples
      //   for the subject and (optionally) existing rdf:type triples when updates.rdfTypes is provided.
      // - Build adds for incoming annotationProperties and rdfTypes.
      // - Call applyBatch({ removes, adds }, gName) so removals and additions happen in a single operation.
      const removes: any[] = [];
      try {
        // Collect existing predicates (non rdf:type) to remove
        const existing = this.store.getQuads(s, null, null, g) || [];
        const predsToRemove = new Set<string>();
        for (const q of existing) {
          try {
            const p = (q.predicate as any).value;
            if (!p) continue;
            if (String(p) === String(rdfTypePred)) continue;
            predsToRemove.add(String(p));
          } catch (_) {
            /* ignore per-quad */
          }
        }
        for (const p of Array.from(predsToRemove)) {
          removes.push({ subject: subjIri, predicate: String(p), object: "" });
        }

        // If incomingTypes provided, remove all existing rdf:type triples for the subject
        if (Array.isArray(updates.rdfTypes)) {
          removes.push({
            subject: subjIri,
            predicate: String(rdfTypePred),
            object: "",
          });
        }
      } catch (_) {
        /* ignore building removes */
      }

      // Build adds array from incoming properties/types
      const adds: any[] = [];
      for (const ap of incomingAnn) {
        try {
          const predRaw =
            (ap && (ap.propertyUri || ap.property || ap.key)) || "";
          const pred =
            predRaw && typeof this.expandPrefix === "function"
              ? this.expandPrefix(String(predRaw))
              : String(predRaw);
          if (!pred) continue;
          adds.push({
            subject: subjIri,
            predicate: String(pred),
            object: String(ap.value),
          });
        } catch (_) {
          /* ignore per-item */
        }
      }

      for (const t of incomingTypes) {
        try {
          const expanded = String(t || "");
          if (!expanded) continue;
          adds.push({
            subject: subjIri,
            predicate: String(rdfTypePred),
            object: String(expanded),
          });
        } catch (_) {
          /* ignore per-type */
        }
      }

      // Apply removals then additions synchronously so callers observe immediate store changes.
      try {
        // Perform removals
        for (const r of removes) {
          try {
            const subj = namedNode(String(r.subject));
            const pred = namedNode(String(r.predicate));
            const found = this.store.getQuads(subj, pred, null, g) || [];
            for (const q of found) {
              try {
                this.bufferSubjectFromQuad(q);
              } catch (_) {
                void 0;
              }
              this.store.removeQuad(q);
            }
          } catch (_) {
            /* ignore per-remove */
          }
        }

        // Perform adds
        for (const a of adds) {
          try {
            const subj = namedNode(String(a.subject));
            const pred = namedNode(String(a.predicate));
            const obj = /^https?:\/\//i.test(String(a.object))
              ? namedNode(String(a.object))
              : literal(String(a.object));
            const exists = this.store.countQuads(subj, pred, obj as any, g) > 0;
            if (!exists) {
              this.store.addQuad(quad(subj as any, pred as any, obj as any, g));
              try {
                this.bufferSubjectFromQuad(
                  quad(subj as any, pred as any, obj as any, g),
                );
              } catch (_) {
                void 0;
              }
            }
          } catch (_) {
            void 0;
          }
        }

        // Notify and dedupe multiple objects per predicate (keep the last)
        try {
          this.notifyChange();
          const incomingPredsArray = Array.from(incomingPreds || []);
          for (const predI of incomingPredsArray) {
            try {
              const predTerm = namedNode(String(predI));
              const qts = this.store.getQuads(s, predTerm, null, g) || [];
              if (Array.isArray(qts) && qts.length > 1) {
                for (let i = 0; i < qts.length - 1; i++) {
                  try {
                    this.bufferSubjectFromQuad(qts[i]);
                  } catch (_) {
                    void 0;
                  }
                  try {
                    this.store.removeQuad(qts[i]);
                  } catch (_) {
                    void 0;
                  }
                }
              }
            } catch (_) {
              /* ignore per-predicate dedupe failures */
            }
          }
        } catch (_) {
          /* ignore notify/dedupe failures */
        }
      } catch (_) {
        /* ignore apply failures */
      }
    }
  }

  /**
   * Primitive API helpers (add/remove triple, apply a batch)
   *
   * These helpers provide a small, well-defined primitive surface so callers
   * can perform idempotent add/remove operations and apply a batch of changes
   * with a single notifyChange emission. This simplifies caller logic (dialogs
   * can accumulate removes/adds and flush them atomically) and centralizes
   * buffering/notification.
   */

  /**
   * addTriple - idempotently add a triple to the specified graph
   */
  public addTriple(
    subject: string,
    predicate: string,
    object: string,
    graphName: string = "urn:vg:data",
  ): void {
    try {
      const g = namedNode(String(graphName));
      const s = namedNode(String(subject));
      const p = namedNode(String(predicate));
      const o =
        object && /^_:/i.test(String(object))
          ? blankNode(String(object).replace(/^_:/, ""))
          : object && /^https?:\/\//i.test(String(object))
            ? namedNode(String(object))
            : literal(String(object));
      const exists = this.store.countQuads(s, p, o as any, g) > 0;
      if (!exists) {
        this.store.addQuad(quad(s as any, p as any, o as any, g));
        try {
          this.bufferSubjectFromQuad(quad(s as any, p as any, o as any, g));
        } catch (_) {
          void 0;
        }
      }
    } catch (e) {
      try {
        fallback("rdf.addTriple.failed", {
          subject,
          predicate,
          object,
          error: String(e),
        });
      } catch (_) {
        void 0;
      }
    }
  }

  /**
   * removeTriple - idempotently remove matching triple(s) from the specified graph
   * Matches exact subject/predicate/object shapes (object must match value & literal form).
   */
  public removeTriple(
    subject: string,
    predicate: string,
    object: string,
    graphName: string = "urn:vg:data",
  ): void {
    try {
      // Strict policy: require an explicit graph name for removals. This enforces
      // callers to choose between 'urn:vg:data' (ABox/user edits) and
      // 'urn:vg:ontologies' (TBox/ontology provenance). Passing no graph will
      // throw so callers cannot accidentally remove triples from the wrong graph.
      if (
        !graphName ||
        typeof graphName !== "string" ||
        String(graphName).trim() === ""
      ) {
        throw new Error(
          "rdfManager.removeTriple requires an explicit graphName (e.g. 'urn:vg:data' or 'urn:vg:ontologies')",
        );
      }

      const g = namedNode(String(graphName));
      const s = namedNode(String(subject));
      const p = namedNode(String(predicate));
      // match literal or named node based on object shape
      const objs: any[] = [];
      try {
        if (
          object === null ||
          typeof object === "undefined" ||
          String(object) === ""
        ) {
          // remove any object for the predicate from the specified graph
          const found = this.store.getQuads(s, p, null, g) || [];
          for (const q of found) {
            try {
              this.bufferSubjectFromQuad(q);
            } catch (_) {
              void 0;
            }
            this.store.removeQuad(q);
          }
          return;
        }
        if (/^_:/i.test(String(object))) {
          objs.push(blankNode(String(object).replace(/^_:/, "")));
        } else if (/^https?:\/\//i.test(String(object))) {
          objs.push(namedNode(String(object)));
        } else {
          objs.push(literal(String(object)));
        }
      } catch (_) {
        objs.push(literal(String(object)));
      }

      for (const o of objs) {
        {
          const found = this.store.getQuads(s, p, o as any, g) || [];
          for (const q of found) {
            try {
              this.bufferSubjectFromQuad(q);
            } catch (_) {
              void 0;
            }
            this.store.removeQuad(q);
          }
        }
      }
    } catch (e) {
      {
        fallback("rdf.removeTriple.failed", {
          subject,
          predicate,
          object,
          error: String(e),
        });
      }
    }
  }

  /**
   * applyBatch - apply a batch of removes then adds atomically (single notify)
   * changes: { removes: Array<{subject,predicate,object}>, adds: Array<{subject,predicate,object}> }
   */
  public async applyBatch(
    changes: { removes?: any[]; adds?: any[] },
    graphName: string = "urn:vg:data",
  ): Promise<void> {
    try {
      const removes = Array.isArray(changes && changes.removes)
        ? changes.removes.slice()
        : [];
      const adds = Array.isArray(changes && changes.adds)
        ? changes.adds.slice()
        : [];
      const g = namedNode(String(graphName));

      const toTermIfNeeded = (v: any, isObject = false) => {
        try {
          if (v === null || typeof v === "undefined") return null;
          if (typeof v === "object" && (v as any).termType) return v;
          const s = String(v);
          if (!s) return null;
          if (/^_:/i.test(s)) return blankNode(String(s).replace(/^_:/, ""));
          if (isObject) {
            // treat any scheme-like string as NamedNode
            return /^[a-z][a-z0-9+.-]*:/i.test(s) ? namedNode(s) : literal(s);
          }
          return namedNode(s);
        } catch (_) {
          return v;
        }
      };

      // Perform removals first
      for (const r of removes) {
        try {
          const subj = toTermIfNeeded(r.subject, false) || namedNode(String(r.subject));
          const pred = toTermIfNeeded(r.predicate, false) || namedNode(String(r.predicate));

          // Empty object -> remove all objects for predicate
          if (r.object === null || typeof r.object === "undefined" || String(r.object) === "") {
            const found = this.store.getQuads(subj, pred, null, g) || [];
            for (const q of found) {
              try { this.bufferSubjectFromQuad(q); } catch (_) { void 0; }
              try { this.store.removeQuad(q); } catch (_) { void 0; }
            }
            continue;
          }

          // If caller provided a Term object, use it directly
          if (typeof r.object === "object" && (r.object as any).termType) {
            const oTerm = r.object;
            try {
              const found = this.store.getQuads(subj, pred, oTerm as any, g) || [];
              for (const q of found) {
                try { this.bufferSubjectFromQuad(q); } catch (_) { void 0; }
                try { this.store.removeQuad(q); } catch (_) { void 0; }
              }
            } catch (_) {
              /* ignore per-object */
            }
            continue;
          }

          // Legacy string case: try exact literal/name match first, then fallback to lexical literal match
          const sObj = String(r.object);
          let matched = false;
          try {
            // Try named/blank node exact match first (treat scheme-like strings as IRIs)
            if (/^_:/i.test(sObj)) {
              const bn = blankNode(sObj.replace(/^_:/, ""));
              const found = this.store.getQuads(subj, pred, bn as any, g) || [];
              for (const q of found) {
                try { this.bufferSubjectFromQuad(q); } catch (_) { void 0; }
                try { this.store.removeQuad(q); } catch (_) { void 0; }
              }
              matched = found.length > 0;
            } else if (/^[a-z][a-z0-9+.-]*:/i.test(sObj)) {
              const nn = namedNode(sObj);
              const found = this.store.getQuads(subj, pred, nn as any, g) || [];
              for (const q of found) {
                try { this.bufferSubjectFromQuad(q); } catch (_) { void 0; }
                try { this.store.removeQuad(q); } catch (_) { void 0; }
              }
              matched = found.length > 0;
            } else {
              // treat as literal: try exact typed literal first
              const lit = literal(sObj);
              const found = this.store.getQuads(subj, pred, lit as any, g) || [];
              for (const q of found) {
                try { this.bufferSubjectFromQuad(q); } catch (_) { void 0; }
                try { this.store.removeQuad(q); } catch (_) { void 0; }
              }
              matched = found.length > 0;
            }
          } catch (_) {
            /* ignore */
          }

          if (matched) continue;

          // Fallback: remove any literal with the same lexical value regardless of datatype/lang
          try {
            const foundAll = this.store.getQuads(subj, pred, null, g) || [];
            for (const q of foundAll) {
              try {
                const objTerm = (q as any).object;
                if (objTerm && typeof objTerm.termType === "string" && objTerm.termType === "Literal" && String(objTerm.value) === sObj) {
                  try { this.bufferSubjectFromQuad(q); } catch (_) { void 0; }
                  try { this.store.removeQuad(q); } catch (_) { void 0; }
                }
              } catch (_) {
                /* ignore per-quad */
              }
            }
          } catch (_) {
            /* ignore fallback */
          }
        } catch (_) {
          /* ignore per-remove */
        }
      }

      // Then perform adds (idempotent)
      for (const a of adds) {
        try {
          const subj = toTermIfNeeded(a.subject, false) || namedNode(String(a.subject));
          const pred = toTermIfNeeded(a.predicate, false) || namedNode(String(a.predicate));
          let obj: any;

          // If caller provided a Term object, use it directly
          if (typeof a.object === "object" && (a.object as any).termType) {
            obj = a.object;
          } else {
            const sObj = String(a.object);
            try {
                if (/^_:/i.test(sObj)) obj = blankNode(sObj.replace(/^_:/, ""));
                else if (/^[a-z][a-z0-9+.-]*:/i.test(sObj)) obj = namedNode(sObj);
                else obj = literal(sObj);
            } catch (_) {
              obj = literal(sObj);
            }
          }

          const exists = this.store.countQuads(subj, pred, obj as any, g) > 0;
          if (!exists) {
            try {
              this.store.addQuad(quad(subj as any, pred as any, obj as any, g));
              try { this.bufferSubjectFromQuad(quad(subj as any, pred as any, obj as any, g)); } catch (_) { void 0; }
            } catch (_) {
              // best-effort add
              try {
                this.store.addQuad(quad(subj as any, pred as any, obj as any, g));
              } catch (_) { void 0; }
            }
          }
        } catch (_) {
          void 0;
        }
      }

      // Notify once after batch applied
      try {
        this.notifyChange();
      } catch (_) {
        void 0;
      }
    } catch (e) {
      try {
        fallback(
          "rdf.applyBatch.failed",
          { error: String(e) },
          { level: "warn" },
        );
      } catch (_) {
        void 0;
      }
      try {
        this.notifyChange();
      } catch (_) {
        void 0;
      }
    }
  }

  /**
   * Clear the store
   */
  clear(): void {
    this.store = new Store();
    // Restore core RDF prefixes only.
    this.namespaces = {
      // rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      // rdfs: "http://www.w3.org/2000/01/rdf-schema#",
      // owl: "http://www.w3.org/2002/07/owl#",
      // xsd: "http://www.w3.org/2001/XMLSchema#",
    };
    // Notify subscribers that RDF cleared
    try {
      this.notifyChange();
    } catch (err) {
      try {
        if (typeof fallback === "function") {
          fallback("rdf.clear.failed", { error: String(err) });
        }
      } catch (_) {
        /* ignore */
      }
    }
  }

  /**
   * Type-guard: true only for parser-emitted prefix maps where every value is a non-empty string.
   * This ensures applyParsedNamespaces only accepts the exact shape produced by rdf-parse / N3 parser.
   */
  private isParserPrefixMap(obj: any): obj is Record<string, string> {
    try {
      if (!obj || typeof obj !== "object") return false;
      const entries = Object.entries(obj);
      if (!Array.isArray(entries) || entries.length === 0) return false;
      for (const [, v] of entries) {
        if (typeof v !== "string" || String(v).trim() === "") return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Accept parser-emitted prefix maps that may contain either string URIs or RDFJS NamedNode-like objects.
   *
   * We sanitize the input strictly to produce a Record<string,string> where each value is a non-empty URI string.
   * - Accepted input shapes per value: string or { value: string } (NamedNode-like).
   * - Values that cannot be coerced to a non-empty string are skipped.
   *
   * This preserves parser information while ensuring only string URIs are stored in the manager.
   */
  /**
   * Sanitizer (STRICT): accept only RDF.NamedNode-like values and return a map of NamedNode objects.
   *
   * Behavior:
   * - If an input entry already appears as a NamedNode-like (has .value string) it is kept.
   * - Plain string values are NOT coerced here; they are recorded in diagnostics and skipped.
   * - Returns a Record<string, RDF.NamedNode> suitable for applyParsedNamespaces.
   */
  private sanitizeParserPrefixes(
    namespaces: Record<string, any> | undefined | null,
  ): Record<string, RDF.NamedNode> {
    const out: Record<string, RDF.NamedNode> = {};
    {
      if (!namespaces || typeof namespaces !== "object") return out;
      for (const [p, v] of Object.entries(namespaces || {})) {
        try {
          if (!p) continue;

          // Accept only NamedNode-like objects (have a string .value)
          if (v && typeof (v as any).value === "string") {
            const s = String((v as any).value).trim();
            if (s) {
              // Keep original object shape (trust parser-provided object)
              out[p] = v as RDF.NamedNode;
            } else {
              try {
                (window as any).__VG_NAMESPACE_WRITER_LOG =
                  (window as any).__VG_NAMESPACE_WRITER_LOG || [];
                (window as any).__VG_NAMESPACE_WRITER_LOG.push({
                  kind: "sanitizer.empty_namednode",
                  prefix: p,
                  raw: v,
                  time: Date.now(),
                });
              } catch (_) {
                /* ignore */
              }
              try {
                console.warn("[VG_PREFIX_SKIPPED_EMPTY_NAMEDNODE]", {
                  prefix: p,
                  raw: v,
                });
              } catch (_) {
                /* ignore */
              }
            }
            continue;
          }

          // If value is a plain string, record diagnostic and skip (do NOT coerce)
          if (typeof v === "string") {
            try {
              (window as any).__VG_NAMESPACE_WRITER_LOG =
                (window as any).__VG_NAMESPACE_WRITER_LOG || [];
              (window as any).__VG_NAMESPACE_WRITER_LOG.push({
                kind: "sanitizer.skipped_string_value",
                prefix: p,
                raw: v,
                time: Date.now(),
              });
            } catch (_) {
              /* ignore */
            }
            try {
              console.warn("[VG_PREFIX_SKIPPED_STRING]", { prefix: p, raw: v });
            } catch (_) {
              /* ignore */
            }
            continue;
          }

          // Skip other shapes and log
          try {
            (window as any).__VG_NAMESPACE_WRITER_LOG =
              (window as any).__VG_NAMESPACE_WRITER_LOG || [];
            (window as any).__VG_NAMESPACE_WRITER_LOG.push({
              kind: "sanitizer.skipped_other_shape",
              prefix: p,
              raw: v,
              time: Date.now(),
            });
          } catch (_) {
            /* ignore */
          }
        } catch (_) {
          /* ignore per-entry errors */
        }
      }
    }
    return out;
  }

  /**
   * Merge parsed namespaces into the manager's namespace map.
   *
   * Behavior:
   * - Accepts parser-emitted maps that may contain string or NamedNode-like values.
   * - Sanitizes input via sanitizeParserPrefixes and merges only sanitized entries.
   * - Logs merged result and records diagnostics for any skipped entries.
   */
  applyParsedNamespaces(
    namespaces: Record<string, any> | undefined | null,
  ): void {
    try {
      // Reject non-object inputs early
      if (!namespaces || typeof namespaces !== "object") return;

      const mergedPrefixes: string[] = [];

      for (const [rawKey, val] of Object.entries(namespaces || {})) {
        try {
          // Accept empty-string or ":" as possible keys; normalize storage key:
          // user requested to keep ':' as the literal prefix key for default namespace.
          const key = rawKey === "" ? ":" : String(rawKey);

          // Derive a URI string from possible value shapes:
          // - { prefix: string, raw: string } (our new object shape)
          // - NamedNode-like { value: string }
          // - plain string "http://..."
          let uriStr: string | undefined = undefined;
          try {
            if (val && typeof (val as any).raw === "string" && String((val as any).raw).trim() !== "") {
              uriStr = String((val as any).raw).trim();
            } else if (val && typeof (val as any).value === "string" && String((val as any).value).trim() !== "") {
              uriStr = String((val as any).value).trim();
            } else if (typeof val === "string" && String(val).trim() !== "") {
              uriStr = String(val).trim();
            }
          } catch (_) {
            // ignore per-entry extraction failures
          }

          if (!uriStr) {
            // Record diagnostic for skipped/invalid entries
            try {
              (window as any).__VG_NAMESPACE_WRITER_LOG =
                (window as any).__VG_NAMESPACE_WRITER_LOG || [];
              (window as any).__VG_NAMESPACE_WRITER_LOG.push({
                kind: "applyParsedNamespaces.invalid_value",
                prefix: key,
                raw: val,
                time: Date.now(),
              });
            } catch (_) {
              /* ignore */
            }
            try {
              console.warn("[VG_PREFIX_SKIPPED_INVALID]", { prefix: key, raw: val });
            } catch (_) {
              /* ignore */
            }
            continue;
          }

          // Persist string URI directly (do not wrap in NamedNode).
          const prev = this.namespaces[key];
          if (String(prev) !== uriStr) {
            this.namespaces[key] = uriStr;
            mergedPrefixes.push(String(key));
          }
        } catch (_) {
          /* ignore per-entry failures */
        }
      }

      if (mergedPrefixes.length > 0) {
        // Debug: print the new namespaces map for inspection
        try {
          console.info("[VG_NAMESPACES_MERGED]", {
            mergedPrefixes,
            namespaces: { ...(this.namespaces || {}) },
          });
        } catch (_) {
          /* ignore console failures */
        }

        try {
          debugLog("rdf.namespaces.merged", {
            mergedPrefixes,
            namespaces: { ...(this.namespaces || {}) },
          });
        } catch (_) {
          /* ignore */
        }

        // Emit a single notify with namespace-change kind so consumers update once.
        try {
          this.notifyChange({ kind: "namespaces", prefixes: mergedPrefixes });
        } catch (_) {
          /* ignore */
        }
      }
    } catch (err) {
      try {
        if (typeof fallback === "function")
          fallback("rdf.applyParsedNamespaces.failed", { error: String(err) });
      } catch (_) {
        /* ignore */
      }
    }
  }

  /**
   * Remove all quads stored in the named graph identified by graphName.
   * Best-effort and idempotent.
   */
  public async loadQuadsToDiagram(
    quadStream: any,
    graphName: string = "urn:vg:data",
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!quadStream || typeof quadStream.on !== "function") {
        return reject(
          new Error("Invalid quad stream provided to loadQuadsToDiagram"),
        );
      }

      const g = namedNode(String(graphName));
      const prefixes: Record<string, any> = {};
      const addedQuads: any[] = [];

      // Buffered onData handler: collect incoming quads into a buffer and drain them in batches
      // using requestIdleCallback (fallback to setTimeout) to avoid blocking the main thread.
      const incomingBuffer: any[] = [];
      let draining = false;
      const yieldFn = (fn: () => void) => {
        try {
          if (typeof (globalThis as any).requestIdleCallback === "function") {
            (globalThis as any).requestIdleCallback(() => fn());
          } else {
            setTimeout(fn, 0);
          }
        } catch (_) {
          setTimeout(fn, 0);
        }
      };

      const drainBuffer = async (): Promise<void> => {
        if (draining) return;
        draining = true;
        try {
          while (incomingBuffer.length > 0) {
            // Take one batch
            const batch = incomingBuffer.splice(0, BATCH_SIZE);
            try {
              for (const q of batch) {
                try {
                  const subj = q && q.subject ? q.subject : null;
                  const pred = q && q.predicate ? q.predicate : null;
                  const obj = q && q.object ? q.object : null;
                  if (!subj || !pred || !obj) continue;
                  const toAdd = quad(subj, pred, obj, g);
                  try {
                    this.addQuadToStore(toAdd, g, addedQuads);
                  } catch (_) {
                    try {
                      this.store.addQuad(toAdd);
                      addedQuads.push(toAdd);
                    } catch (_) {
                      /* ignore per-quad add failure */
                    }
                  }
                } catch (_) {
                  /* ignore per-quad */
                }
              }
            } catch (_) {
              /* ignore batch-level errors */
            }
            // Yield to the browser before continuing with the next batch
            await new Promise<void>((res) => yieldFn(res));
          }
        } finally {
          draining = false;
        }
      };

      const onData = (q: any) => {
        try {
          // Buffer the quad for asynchronous batch insertion
          incomingBuffer.push(q);
          // If buffer reached threshold, schedule a drain
          if (incomingBuffer.length >= BATCH_SIZE) {
            // Start draining asynchronously (no await here)
            void drainBuffer();
          }
        } catch (err) {
          try {
            console.debug("[VG_RDF] loadQuadsToDiagram.buffer.error", String(err).slice(0, 200));
          } catch (_) {
            /* ignore */
          }
        }
      };

      const onPrefix = (prefix: string, iri: any) => {
        {
          try {
            const pKey = String(prefix || "");
            let raw: string | undefined = undefined;
            if (typeof iri === "string") raw = iri;
            else if (iri && typeof (iri as any).value === "string") raw = (iri as any).value;
            else if (iri !== undefined && iri !== null) raw = String(iri);
            prefixes[pKey] = { prefix: pKey, raw: raw || "" };
          } catch (_) {
            /* ignore */
          }
        }
      };

      const cleanup = () => {
        {
          quadStream.removeListener("data", onData);
          quadStream.removeListener("error", onError);
          quadStream.removeListener("end", onEnd);
          quadStream.removeListener("prefix", onPrefix);
        }
      };

      const onError = (err: any) => {
        {
          // Capture stream-level errors for diagnostic inspection (dev-only surface)
          try {
            (window as any).__VG_PARSED_PREFIXES_ERRORS =
              (window as any).__VG_PARSED_PREFIXES_ERRORS || [];
            (window as any).__VG_PARSED_PREFIXES_ERRORS.push({
              id: null,
              kind: "quad-stream",
              time: Date.now(),
              message: err && err.message ? String(err.message) : String(err),
              stack: err && err.stack ? String(err.stack) : undefined,
            });
          } catch (_) {
            /* ignore capture failures */
          }

          try {
            console.error("[VG_PARSED_PREFIXES_ERROR] (quad-stream)", err);
          } catch (_) {
            /* ignore */
          }
        }

        {
          cleanup();
        }
        reject(err);
      };

      const onEnd = async () => {
        try {
          cleanup();
          // Finalize via shared helper (applies prefixes, runs reconcile, notifies, schedules flush)
            try {
            await (this as any).finalizeLoad(addedQuads, prefixes, undefined, graphName);
          } catch (e) {
            try {
              fallback("rdf.loadQuadsToDiagram.reconcile_failed", {
                error: String(e),
              });
            } catch (_) {
              /* ignore */
            }
          }

          resolve();
        } catch (err) {
          reject(err);
        }
      };

      try {
        quadStream.on("data", onData);
        quadStream.on("error", onError);
        quadStream.on("end", onEnd);
        // some parsers emit prefix and context events
        if (typeof quadStream.on === "function") {
          try {
            quadStream.on("prefix", onPrefix);
          } catch (_) {
            /* ignore */
          }
          try {
            quadStream.on("context", (ctx: any) => {
              try {
                (window as any).__VG_PARSED_PREFIXES_DETAILED =
                  (window as any).__VG_PARSED_PREFIXES_DETAILED || [];
                (window as any).__VG_PARSED_PREFIXES_DETAILED.push({
                  id: null,
                  kind: "quad-stream-context",
                  time: Date.now(),
                  context: ctx,
                });
              } catch (_) {
                /* ignore */
              }
              try {
                console.info("[VG_PARSED_CONTEXT] (quad-stream)", {
                  context: ctx,
                });
              } catch (_) {
                /* ignore */
              }
            });
          } catch (_) {
            /* ignore */
          }
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }
}

export const rdfManager = new RDFManager();

// Ensure we do NOT enable persistent automatic store write logging by default.
// Some earlier debug runs enabled window flags which caused noisy per-write logs.
// Disable those flags by default so write-logging only occurs when explicitly enabled.
try {
  if (typeof window !== "undefined") {
    try { (window as any).__VG_LOG_RDF_WRITES = false; } catch (_) {/* noop */}
    try { (window as any).__VG_DEBUG__ = !!(window as any).__VG_DEBUG__; } catch (_) {/* noop */}
  }
  (globalThis as any).__VG_RDF_WRITE_LOGGING_ENABLED = false;
} catch (_) { /* ignore */ }

// Expose a small explicit API so developers can opt-in to write-logging and
// collect graph counts on demand. This keeps the runtime quiet unless debug
// is intentionally enabled.
export function enableN3StoreWriteLogging(enable: boolean = true) {
  try {
    (globalThis as any).__VG_RDF_WRITE_LOGGING_ENABLED = !!enable;
    if (typeof window !== "undefined") {
      (window as any).__VG_LOG_RDF_WRITES = !!enable;
    }
    return !!enable;
  } catch (_) {
    return false;
  }
}

/**
 * Collect per-graph triple counts from any N3 Store-like instance.
 * Returns a simple Record<string, number> mapping graph IRI (or 'default') to counts.
 * This is safe to call on demand and is intended as the single API for diagnostics.
 */
export function collectGraphCountsFromStore(store: any): Record<string, number> {
  try {
    if (!store || typeof store.getQuads !== "function") return { "urn:vg:inferred": 0 };
    const all = store.getQuads(null, null, null, null) || [];
    const graphCounts: Record<string, number> = {};
    for (const q of all) {
      try {
        const g = q && q.graph && (q.graph as any).value ? (q.graph as any).value : "default";
        graphCounts[g] = (graphCounts[g] || 0) + 1;
      } catch (_) { /* ignore per-quad */ }
    }
    // Ensure inferred graph key is always present for diagnostics (zero when absent)
    try {
      if (!Object.prototype.hasOwnProperty.call(graphCounts, "urn:vg:inferred")) {
        graphCounts["urn:vg:inferred"] = 0;
      }
    } catch (_) { /* ignore */ }
    return graphCounts;
  } catch (_) {
    return { "urn:vg:inferred": 0 };
  }
}
