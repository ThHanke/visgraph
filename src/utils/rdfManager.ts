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

 
import {
  Store,
  Parser,
  Writer,
  Quad,
  DataFactory,
} from "n3";
import { rdfParser } from "rdf-parse";
import { rdfSerializer } from "rdf-serialize";
import type * as RDF from "@rdfjs/types";



const { namedNode, literal, quad, blankNode, defaultGraph } = DataFactory;

/**
 * Helper: create a Node-style Readable from fetched content (string, ArrayBuffer or Uint8Array).
 *
 * Uses dynamic imports for "stream" and "buffer" so we avoid bundling Node-only modules
 * into the browser build. Returns a Node Readable when possible, otherwise returns undefined.
 * Callers should fall back to WHATWG Response.body when this returns undefined.
 */
async function createNodeReadableFromText(content: string | ArrayBuffer | Uint8Array): Promise<any | undefined> {
  {
    const _streamMod = await import("stream").catch(() => ({ Readable: undefined } as any));
    const Readable = (_streamMod && _streamMod.Readable) ? _streamMod.Readable : undefined;
    const _bufMod = await import("buffer").catch(() => ({ Buffer: (globalThis as any).Buffer } as any));
    const BufferImpl = (_bufMod && _bufMod.Buffer) ? _bufMod.Buffer : (globalThis as any).Buffer;

    // Prefer Readable.from when available
    if (Readable && typeof (Readable as any).from === "function" && typeof BufferImpl !== "undefined") {
      try {
        const chunk = typeof content === "string" ? BufferImpl.from(content) : (content as any);
        return (Readable as any).from([chunk]);
      } catch (_) {
        // fall through to manual construction
      }
    }

    // Manual construction: create a Readable, push the content, then push EOF.
    if (Readable && typeof Readable === "function" && typeof BufferImpl !== "undefined") {
      try {
        const rs = new Readable();
        rs.push(typeof content === "string" ? BufferImpl.from(content) : (content as any));
        rs.push(null);
        return rs as any;
      } catch (_) {
        // fall through to undefined
      }
    }

    // Not available in this environment
    return undefined;
  }
}
import { useAppConfigStore } from "../stores/appConfigStore";
import { useOntologyStore } from "../stores/ontologyStore";
import { WELL_KNOWN } from "../utils/wellKnownOntologies";
import {
  debugLog,
  debug,
  fallback,
  incr,
} from "../utils/startupDebug";

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
        try {
          // Call the explicit store API (no fallbacks) so tests and runtime instrumentation
          // can reliably observe the fat-map update invocation.
          await os.updateFatMap(quads);
        } finally {
          // clear the in-flight marker regardless of success/failure so future reconciles can run
          this.reconcileInProgress = null;
        }
      })();

      return this.reconcileInProgress;
    } catch (err) {
      // propagate errors to caller
      return Promise.reject(err);
    }
  }

  // Change notification
  private changeCounter = 0;
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

  // Blacklist configuration: prefixes and absolute namespace URIs that should be
  // ignored when emitting subject-level change notifications. Default set below
  // matches common RDF/OWL core vocabularies so they don't create canvas nodes.
  private blacklistedPrefixes: Set<string> = new Set(["owl", "rdf", "rdfs", "xml", "xsd"]);
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
  public setBlacklist(prefixes: string[] | undefined | null, uris?: string[] | undefined | null): void {
    try {
      this.blacklistedPrefixes = new Set((prefixes || []).map(String));
      if (Array.isArray(uris)) this.blacklistedUris = uris.slice();
      // Best-effort: persist into app config if the store exposes setConfig
      try {
        if (typeof useAppConfigStore !== "undefined" && (useAppConfigStore as any).getState) {
          const st = (useAppConfigStore as any).getState();
          if (st && typeof st.setConfig === "function") {
            try {
              st.setConfig({ ...(st.config || {}), blacklistedPrefixes: Array.from(this.blacklistedPrefixes), blacklistedUris: this.blacklistedUris });
            } catch (_) { /* ignore */ }
          }
        }
      } catch (_) { /* ignore */ }
    } catch (err) {
      try {
        if (typeof fallback === "function") fallback("rdf.setBlacklist.failed", { error: String(err) });
      } catch (_) { /* ignore */ }
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
          } catch (_) { void 0; }
          // Also consider any ontology entries whose namespaces include this prefix and add their ontology keys/aliases
          try {
            const ontMap = (WELL_KNOWN && (WELL_KNOWN as any).ontologies) || {};
            for (const [ontUrl, meta] of Object.entries(ontMap || {})) {
              try {
                const m = meta as any;
                if (m && m.namespaces && m.namespaces[p]) {
                  uriCandidates.add(ontUrl);
                  if (Array.isArray(m.aliases)) {
                    m.aliases.forEach((a: any) => uriCandidates.add(String(a)));
                  }
                }
              } catch (_) { void 0; }
            }
          } catch (_) { void 0; }
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

        this.store.addQuad = ((q: Quad) => {
          try {
            // Log minimal quad info and stack to help identify caller
            console.debug(
              "[VG_RDF_WRITE] addQuad",
              (q as any)?.subject?.value,
              (q as any)?.predicate?.value,
              (q as any)?.object?.value,
            );
            try {
              const st = new Error().stack || "";
              // remove the leading "Error:" line for cleaner logs
              console.debug("[VG_RDF_WRITE_STACK]", st.replace(/^Error:\\s*/, ""));
            } catch (_) {
              /* ignore stack formatting failures */
            }
          } catch (_) {
            /* ignore logging failures */
          }
          return origAdd(q);
        }) as any;

        this.store.removeQuad = ((q: Quad) => {
          try {
            console.debug(
              "[VG_RDF_WRITE] removeQuad",
              (q as any)?.subject?.value,
              (q as any)?.predicate?.value,
              (q as any)?.object?.value,
            );
            try {
              const st = new Error().stack || "";
              console.debug("[VG_RDF_REMOVE_STACK]", st.replace(/^Error:\\s*/, ""));
            } catch (_) {
              /* ignore stack formatting failures */
            }
          } catch (_) {
            /* ignore */
          }
          // Buffer the removed quad so subject-level subscribers receive this removal.
          try {
            if ((this as any).bufferSubjectFromQuad) {
              try {
                (this as any).bufferSubjectFromQuad(q);
              } catch (_) { /* ignore buffering failures */ }
            }
          } catch (_) {
            /* ignore buffering failures */
          }
          return origRemove(q);
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
        // install tracing if requested
        if ((window as any).__VG_LOG_RDF_WRITES === true) {
          enableWriteTracing();
        }
        // Expose a runtime helper so you can enable tracing from the console:
        // window.__VG_ENABLE_RDF_WRITE_LOGGING && window.__VG_ENABLE_RDF_WRITE_LOGGING()
        (window as any).__VG_ENABLE_RDF_ENABLE_RDF_WRITE_LOGGING = (function() {
          // legacy compatibility alias (some dev envs may call the older name)
          try { (window as any).__VG_ENABLE_RDF_WRITE_LOGGING = (window as any).__VG_ENABLE_RDF_WRITE_LOGGING || (() => { try { (window as any).__VG_LOG_RDF_WRITES = true; enableWriteTracing(); return true; } catch (err) { return false; } }); } catch (_) { void 0; }
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
            const subjectQuads = this.store.getQuads(subjTerm, null, null, null) || [];
            if (Array.isArray(subjectQuads) && subjectQuads.length > 0) {
              const existing = this.subjectQuadBuffer.get(s) || [];
              existing.push(...subjectQuads);
              this.subjectQuadBuffer.set(s, existing);
            }
          } catch (_) {
            // ignore per-subject read failures but still ensure the subject is buffered
          }

          // Mark subject buffered so schedule/flush behavior is consistent
          try { this.subjectChangeBuffer.add(s); } catch (_) { /* ignore */ }
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
            fallback("rdf.triggerSubjectUpdate.schedule_failed", { error: String(e) });
          }
        } catch (_) { /* ignore */ }
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
              return !(this.isBlacklistedIri && this.isBlacklistedIri(String(s)));
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
                const subjectQuads = this.store.getQuads(subjTerm, null, null, null) || [];
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

          // Do NOT clear buffered quads yet; perform reconcile first so the emitted quads are exactly the ones reconciled.
          // Run reconciliation for these snapshots (runReconcile is quads-only and returns a shared in-flight promise).
          if (Array.isArray(reconcileArg)) {
            await (this as any).runReconcile(reconcileArg);
          }

          // After successful reconcile (or if none needed), clear buffered deltas and emit subscribers with authoritative quads.
          try {
            for (const s of subjects) {
              try { this.subjectQuadBuffer.delete(s); } catch (_) { void 0; }
            }
          } catch (_) { /* ignore */ }

          try { this.subjectChangeBuffer.clear(); } catch (_) { /* ignore */ }
          try { this.subjectFlushTimer = null; } catch (_) { /* ignore */ }

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
      const exists = this.store.countQuads(toAdd.subject, toAdd.predicate, toAdd.object, g) > 0;
      if (!exists) {
        this.store.addQuad(toAdd);
        try { this.bufferSubjectFromQuad(toAdd); } catch (_) { /* ignore */ }
        if (Array.isArray(addedQuads)) addedQuads.push(toAdd);
      }
    } catch (_) {
      try {
        // best-effort add
        this.store.addQuad(toAdd);
        if (Array.isArray(addedQuads)) addedQuads.push(toAdd);
      } catch (_) { /* ignore */ }
    }
  }

  // Helper: finalize a load - apply prefixes, run reconciliation, notify and schedule subject flush
  private async finalizeLoad(addedQuads: Quad[], prefixes?: Record<string, any>, loadId?: string): Promise<void> {
    try {
      // Capture raw parsed prefixes for inspection instead of merging them.
      // Push the raw object into a dev-only collection on window so developers can
      // inspect exactly what parsers emit before we decide a strict runtime type.
      try {
        if (prefixes && typeof prefixes === "object" && Object.keys(prefixes).length > 0) {
          try {
            // Lightweight capture (keeps original object)
            (window as any).__VG_PARSED_PREFIXES = (window as any).__VG_PARSED_PREFIXES || [];
            (window as any).__VG_PARSED_PREFIXES.push({
              id: loadId || (`load-${Date.now()}`),
              kind: "n3-parser",
              prefixes,
              time: Date.now(),
            });

            // Detailed diagnostics per-prefix to reveal runtime shape without mutating values.
            (window as any).__VG_PARSED_PREFIXES_DETAILED = (window as any).__VG_PARSED_PREFIXES_DETAILED || [];
            try {
              const diag: Record<string, any> = {};
              for (const [k, v] of Object.entries(prefixes || {})) {
                try {
                  const hasValueProp = v && typeof (v as any).value === "string";
                  diag[String(k)] = {
                    raw: v,
                    typeof: typeof v,
                    ctor: v && (v as any).constructor ? (v as any).constructor.name : null,
                    hasValueProp: Boolean(hasValueProp),
                    valueProp: hasValueProp ? String((v as any).value) : undefined,
                    toString: (() => { try { return String(v); } catch (_) { return null; } })(),
                    keys: (v && typeof v === "object") ? Object.keys(v).slice(0, 20) : undefined,
                  };
                } catch (_) {
                  /* per-value diag failure - ignore */
                }
              }
              (window as any).__VG_PARSED_PREFIXES_DETAILED.push({
                id: loadId || (`load-${Date.now()}`),
                kind: "n3-parser",
                time: Date.now(),
                count: Object.keys(diag).length,
                diag,
              });
            } catch (_) {
              /* ignore diag construction failures */
            }

            // Expose convenience clearers
            try {
              (window as any).__VG_CLEAR_PARSED_PREFIXES = () => { (window as any).__VG_PARSED_PREFIXES = []; return true; };
            } catch (_) { /* ignore */ }
            try {
              (window as any).__VG_CLEAR_PARSED_PREFIXES_DETAILED = () => { (window as any).__VG_PARSED_PREFIXES_DETAILED = []; return true; };
            } catch (_) { /* ignore */ }

            // Print a concise console line for immediate inspection in devtools.
            try { console.info("[VG_PARSED_PREFIXES_DETAILED] (n3-parser)", { id: loadId || null, count: Object.keys(prefixes || {}).length }); } catch (_) { /* ignore */ }
          } catch (_) {
            /* ignore capture failures */
          }
        }
      } catch (_) { /* ignore prefix capture failures */ }

      // Pass only NamedNode-like prefix values to applyParsedNamespaces; do NOT coerce plain strings.
      try {
        try {
          if (typeof (this as any).applyParsedNamespaces === "function") {
            try {
              const filtered: Record<string, RDF.NamedNode> = {};
              try {
                for (const [k, v] of Object.entries(prefixes || {})) {
                  try {
                    if (v && typeof (v as any).value === "string") {
                      filtered[k] = v as RDF.NamedNode;
                    } else {
                      // record that this load contained non-NamedNode prefix values (strings or other shapes)
                      try {
                        (window as any).__VG_NAMESPACE_WRITER_LOG = (window as any).__VG_NAMESPACE_WRITER_LOG || [];
                        (window as any).__VG_NAMESPACE_WRITER_LOG.push({ kind: "finalizeLoad.skipped_non_namednode", prefix: k, raw: v, time: Date.now() });
                      } catch (_) { /* ignore */ }
                      try { console.warn("[VG_PREFIX_FINALIZE_SKIPPED]", { prefix: k, raw: v }); } catch (_) { /* ignore */ }
                    }
                  } catch (_) { /* ignore per-entry */ }
                }
              } catch (_) { /* ignore filtering failures */ }
              try { this.applyParsedNamespaces(filtered); } catch (_) { /* ignore */ }
            } catch (_) { /* ignore */ }
          }
        } catch (_) { /* ignore apply failures */ }
      } catch (_) { /* ignore */ }

      // Run reconciliation with the quads we added so consumers get authoritative snapshot
      try {
        if (Array.isArray(addedQuads) && addedQuads.length > 0) {
          await (this as any).runReconcile(addedQuads);
        } else {
          try { this.notifyChange(); } catch (_) { /* ignore */ }
        }
      } catch (e) {
        try { fallback("rdf.finalizeLoad.reconcile_failed", { error: String(e) }); } catch (_) { /* ignore */ }
      }

      // Schedule subject-level flush immediately (only if window is available)
      try {
        if (typeof window !== "undefined") {
          this.scheduleSubjectFlush(0);
        }
      } catch (_) { /* ignore */ }

      // Developer debug: report per-graph triple counts after a batch load
      try {
        const allQuads = this.store.getQuads(null, null, null, null) || [];
        const graphCounts: Record<string, number> = {};
        for (const qq of allQuads) {
          try {
            const g = (qq && qq.graph && (qq.graph as any).value) ? (qq.graph as any).value : "default";
            graphCounts[g] = (graphCounts[g] || 0) + 1;
          } catch (_) { /* ignore per-quad counting failures */ }
        }
        try { debugLog("rdf.load.batchCounts", { id: loadId || "unknown", graphCounts }); } catch (_) { void 0; }
        try { console.debug("[VG_DEBUG] rdf.load.batchCounts", { id: loadId || "unknown", graphCounts }); } catch (_) { void 0; }
      } catch (_) { /* ignore */ }

    } catch (err) {
      try { if (typeof fallback === "function") fallback("rdf.finalizeLoad.failed", { error: String(err) }); } catch (_) { /* ignore */ }
    }
  }

  async loadRDFIntoGraph(
    rdfContent: string,
    graphName?: string,
    mimeType?: string,
  ): Promise<void> {
    // Defensive guard: ensure we do not pass null/empty input into the parsers
    if (rdfContent === null || typeof rdfContent !== "string" || rdfContent.trim() === "") {
      throw new Error("Empty RDF content provided to loadRDFIntoGraph");
    }
    if (!graphName) return this.loadRDFIntoGraph(rdfContent, "urn:vg:data", mimeType);

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
    { this.parsingInProgress = true; }

    const finalize = (prefixes?: Record<string, string>) => {
      // Notify subscribers that RDF changed
      this.notifyChange();
      { this.parsingInProgress = false; }
      { this.scheduleSubjectFlush(0); }
      {
        this.notifyChange();
      }

      // Developer debug: report per-graph triple counts after a batch load
      {
        const allQuads = this.store.getQuads(null, null, null, null) || [];
        const graphCounts: Record<string, number> = {};
        for (const qq of allQuads) {
          try {
            const g = (qq && qq.graph && (qq.graph as any).value) ? (qq.graph as any).value : "default";
            graphCounts[g] = (graphCounts[g] || 0) + 1;
          } catch (_) {
            /* ignore per-quad counting failures */
          }
        }
        try { debugLog("rdf.load.batchCounts", { id: _vg_loadId, graphCounts }); } catch (_) { void 0; }
        try { console.debug("[VG_DEBUG] rdf.load.batchCounts", { id: _vg_loadId, graphCounts }); } catch (_) { void 0; }
      }

      resolveFn();
    };

    try {
      // Simplified: assume rdfContent is Turtle. Use N3 Parser directly.
      const g = namedNode(graphName);
      const addedQuads: Quad[] = [];

      // NOTE: removed automatic prefix-prepend logic.
      // We must not mutate server-provided RDF content (e.g. JSON-LD) by injecting
      // Turtle @prefix lines. Network-loaded RDF is parsed via rdf-parse/rdf-serialize
      // and namespaces are discovered from the parser output; keep rdfContent unchanged.

      rdfContent = rdfContent.replace(/^\s+/, "");
      this.parser.parse(rdfContent, (error, quadItem, prefixes) => {
        if (error) {
          try {
            // Expose the last RDF content to the browser runtime for quick inspection in devtools.
            if (typeof window !== "undefined") {
              try {
                (window as any).__VG_LAST_RDF = rdfContent;
              } catch (_) {
                /* ignore */
              }
              // Build a concise snippet for UI/console consumption (first ~40 lines)
              try {
                const lines = String(rdfContent || "").split(/\r?\n/);
                const snippet = lines
                  .slice(0, Math.min(lines.length, 40))
                  .join("\n");
                const errMsg = String(error);
                // Expose structured parse error so UI can consume it deterministically
                try {
                  (window as any).__VG_LAST_RDF_ERROR = {
                    message: errMsg,
                    snippet,
                  };
                } catch (_) {
                  /* ignore */
                }
                // Dispatch a DOM event so any listeners may react (optional)
                try {
                  window.dispatchEvent(
                    new CustomEvent("vg:rdf-parse-error", {
                      detail: { message: errMsg, snippet },
                    }),
                  );
                } catch (_) {
                  /* ignore */
                }
                // Log a concise console line for developers

                console.error(
                  "[VG_RDF_PARSE_ERROR]",
                  errMsg.slice(0, 200),
                  "snippet:",
                  snippet.slice(0, 1000),
                );
              } catch (_) {
                /* ignore snippet logging failures */
              }
            }
          } catch (_) {
            /* ignore outer logging failures */
          }
          try {
            rejectFn(error);
          } catch (_) {
            try {
              if (typeof fallback === "function") {
                fallback("emptyCatch", { error: String(_) });
              }
            } catch (_) {
              /* ignore */
            }
          }
          return;
        }

        if (quadItem) {
          try {
            // Build a quad under the target graph and delegate adding to the helper so
            // we keep consistent add/buffer behavior and track addedQuads for reconciliation.
            if (quadItem && quadItem.subject && quadItem.predicate && quadItem.object) {
              try {
                const toAdd = quad(quadItem.subject, quadItem.predicate, quadItem.object, g);
                try {
                  this.addQuadToStore(toAdd, g, addedQuads);
                } catch (_) {
                  // best-effort fallback: direct add
                  try { this.store.addQuad(toAdd); if (Array.isArray(addedQuads)) addedQuads.push(toAdd); } catch (_) { /* ignore */ }
                }
              } catch (_) {
                console.warn("[VG_RDF_ADD_SKIPPED] invalid quadItem from parser for graph", quadItem);
              }
            } else {
              // ignore invalid quadItem shapes
            }
          } catch (e) {
            try {
              // best-effort direct add if helper failed
              this.store.addQuad(quad(quadItem.subject, quadItem.predicate, quadItem.object, g));
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
        } else {
          // when parser finishes, merge prefixes & finalize via shared finalizeLoad helper
          try { this.parsingInProgress = false; } catch (_) { /* ignore */ }
          (async () => {
            try {
              await (this as any).finalizeLoad(addedQuads, prefixes, _vg_loadId);
            } catch (e) {
              try { rejectFn(e); } catch (_) { /* ignore */ }
              return;
            }
            try { resolveFn(); } catch (_) { /* ignore */ }
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
   * This helper centralizes network fetching so callers (e.g. ontologyStore)
   * can rely on a single implementation that respects timeouts and common
   * Accept headers used by RDF endpoints.
   */
  public async loadRDFFromUrl(
    url: string,
    graphName?: string,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    if (!url) throw new Error("loadRDFFromUrl requires a url");
    const timeoutMs = options?.timeoutMs ?? 15000;

    const { doFetch } = await import("./fetcher").catch(() => ({ doFetch: undefined as any }));
    const doFetchImpl = typeof doFetch === "function"
      ? doFetch
      : (async (t: string, to: number) => {
          const c = new AbortController();
          const id = setTimeout(() => c.abort(), to);
          try {
            // return await fetch(t, { signal: c.signal, headers: { Accept: "text/turtle, application/rdf+xml, application/ld+json, */*" } });
            return await fetch(t, { signal: c.signal, headers: { Accept: "text/turtle" } });
          } finally { clearTimeout(id); }
        });

    console.debug("[VG_RDF] loadRDFFromUrl start", { url, graphName, timeoutMs });

    // Fetch the resource once and trust Content-Type for rdf-parse
    const res = await doFetchImpl(url, timeoutMs, { minimal: false });
    if (!res) throw new Error(`No response for ${url}`);
    if (!res.ok) {
      console.warn(`[VG_RDF] HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    const contentTypeHeader = (res.headers && res.headers.get ? res.headers.get("content-type") : null) || null;
    console.debug("[VG_RDF] fetched", { url, status: res.status, contentType: contentTypeHeader });

    // Normalise to text first to avoid streaming differences between Node and browsers.
    const txt = await res.text();

    // If the fetched content clearly looks like Turtle (or the content-type explicitly indicates Turtle),
    // prefer the in-memory N3 parser path which accepts a string and does not require Node Readable streams.
    const mimeType = contentTypeHeader ? (contentTypeHeader.split(";")[0].trim() || null) : null;


    // const prefersTurtle = mimeType === "text/turtle" || mimeType === "text/n3" || looksLikeRdfLocal(txt);
    const prefersTurtle = mimeType === "text/turtle" || mimeType === "text/n3";

    if (prefersTurtle) {
      try {
        console.info("[VG_RDF] parsing text directly with N3 Parser (browser-friendly)", { url, mimeType });
        // Delegate directly to the existing loader which parses a string using N3.Parser.
        return await this.loadRDFIntoGraph(txt, graphName || "urn:vg:data", "text/turtle");
      } catch (err) {
        // If direct parsing fails for unexpected reasons, fall through to the rdf-parse path as a fallback.
        console.info("[VG_RDF] direct N3 parse failed, will try rdf-parse fallback", { url, error: String(err).slice(0, 200) });
      }
    }

        // Prefer a Node-style Readable created by the shared helper; fall back to WHATWG stream when unavailable.
        const inputStream = (await createNodeReadableFromText(txt)) || (new Response(txt).body as any);


    // Attempt 1: prefer parsing by HTTP content-type (mimetype). If this fails
    // (parser/serializer rejects) we will retry using the filename/path as baseIRI.
    console.info("[VG_RDF] parse-by-mimetype:start", { contentType: contentTypeHeader, url });
    try {
      const quadStream = rdfParser.parse(inputStream, { contentType: contentTypeHeader || undefined, baseIRI: url });
      return await this.loadQuadsToDiagram(quadStream, graphName || "urn:vg:data");
    } catch (err) {
      // parse/serialize via mimetype failed — retry using filename/baseIRI heuristics
      console.info("[VG_RDF] parse-by-mimetype:failed, retrying by filename", { url, error: String(err).slice(0, 500) });

      // Re-create a fresh Node-style Readable for retry (streams are single-use)
      const inputStream2 = (await createNodeReadableFromText(txt)) || (new Response(txt).body as any);
      console.info("[VG_RDF] parse-by-filename:start", { path: url, baseIRI: url });
      const quadStream2 = rdfParser.parse(inputStream2, { path: url, baseIRI: url });
      // Delegate to existing loader which handles store insertion, namespaces, notifications
      return await this.loadQuadsToDiagram(quadStream2, graphName || "urn:vg:data");
    }

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
          return quad((q as any).subject, (q as any).predicate, (q as any).object, defaultGraph());
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
        try { return quad((q as any).subject, (q as any).predicate, (q as any).object, defaultGraph()); } catch (_) { return q; }
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
        try { return quad((q as any).subject, (q as any).predicate, (q as any).object, defaultGraph()); } catch (_) { return q; }
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
    else if (uri && typeof (uri as any).value === "string") uriStr = String((uri as any).value);
    if (!uriStr) return;

    const prev = Object.prototype.hasOwnProperty.call(this.namespaces, prefix) ? this.namespaces[prefix] : undefined;
    const changed = prev === undefined || String(prev) !== uriStr;

    // Update internal map
    this.namespaces[prefix] = uriStr;

    // Persisting the registry is handled by the reconcile/fat-map path only.
    if (changed) {
      { this.notifyChange({ kind: "namespaces", prefixes: [prefix] }); }
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
        this.notifyChange({ kind: "namespaces", prefixes: prefixToRemove ? [prefixToRemove] : [] });
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
                { args: [ (err && (err as any).message) ? (err as any).message : String(err) ] },
                { level: "warn" },
              );
            } catch (_) { void 0; }
          }
        } catch (_) { void 0; }
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
          try { this.bufferSubjectFromQuad(q); } catch (_) { /* ignore */ }
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
                  { args: [ (err && (err as any).message) ? (err as any).message : String(err) ] },
                  { level: "warn" },
                );
              } catch (_) { void 0; }
            }
          } catch (_) { void 0; }
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
  public removeQuadsInGraphByNamespaces(graphName: string, namespaceUris?: string[] | null): void {
    try {
      if (!graphName || !Array.isArray(namespaceUris) || namespaceUris.length === 0) return;
      const g = namedNode(graphName);
      const quads = this.store.getQuads(null, null, null, g) || [];
      quads.forEach((q: Quad) => {
        try {
          const subj = (q.subject && (q.subject as any).value) || "";
          const pred = (q.predicate && (q.predicate as any).value) || "";
          const obj = (q.object && (q.object as any).value) || "";
          const matches = (namespaceUris || []).some((ns) =>
            ns && (subj.startsWith(ns) || pred.startsWith(ns) || obj.startsWith(ns)),
          );
          if (matches) {
            try {
              // Buffer removed quad so subject-level subscribers are notified.
              try { this.bufferSubjectFromQuad(q); } catch (_) { /* ignore */ }
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
          fallback("rdf.removeQuadsInGraphByNamespaces.failed", { graphName, error: String(err) });
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
  public async removeAllQuadsForIri(iri: string, graphName: string = "urn:vg:data"): Promise<void> {
    try {
      if (!iri) return;
      const g = namedNode(String(graphName));
      // Subject term may be a blank node or named node
      const subjTerm = /^_:/i.test(String(iri)) ? blankNode(String(iri).replace(/^_:/, "")) : namedNode(String(iri));
      // Remove quads where subject === iri
      try {
        const subjQuads = this.store.getQuads(subjTerm, null, null, g) || [];
        for (const q of subjQuads) {
          try { this.bufferSubjectFromQuad(q); } catch (_) { void 0; }
          try { this.store.removeQuad(q); } catch (_) { void 0; }
        }
      } catch (_) { /* ignore per-subject remove failures */ }

      // Remove quads where object === iri (object must be a named node to match IRIs)
      try {
        const objTerm = namedNode(String(iri));
        const objQuads = this.store.getQuads(null, null, objTerm, g) || [];
        for (const q of objQuads) {
          try { this.bufferSubjectFromQuad(q); } catch (_) { void 0; }
          try { this.store.removeQuad(q); } catch (_) { void 0; }
        }
      } catch (_) { /* ignore per-object remove failures */ }

      // Notify subscribers once
      try { this.notifyChange({ kind: "removeAllQuadsForIri", iri, graph: graphName }); } catch (_) { void 0; }
    } catch (err) {
      try { fallback("rdf.removeAllQuadsForIri.failed", { iri, graphName, error: String(err) }); } catch (_) { void 0; }
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
          if (!wellKnownFallbacks[k] && typeof v === "string") wellKnownFallbacks[k] = v;
        } catch (_) { void 0; }
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
   * Get the store instance for direct access
   */
  getStore(): Store {
    return this.store;
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
      const incomingAnn = Array.isArray(updates.annotationProperties) ? updates.annotationProperties : [];
      const incomingPreds = new Set<string>();
      for (const ap of incomingAnn) {
        try {
          const predRaw = (ap && (ap.propertyUri || ap.property || ap.key)) || "";
          const pred =
            predRaw && typeof this.expandPrefix === "function"
              ? this.expandPrefix(String(predRaw))
              : String(predRaw);
          if (pred) incomingPreds.add(String(pred));
        } catch (_) { /* ignore */ }
      }
      const incomingTypes = Array.isArray(updates.rdfTypes) ? updates.rdfTypes.map((t: any) => (typeof this.expandPrefix === "function" ? this.expandPrefix(String(t)) : String(t))) : [];

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
          } catch (_) { /* ignore per-quad */ }
        }
        for (const p of Array.from(predsToRemove)) {
          removes.push({ subject: subjIri, predicate: String(p), object: "" });
        }

        // If incomingTypes provided, remove all existing rdf:type triples for the subject
        if (Array.isArray(updates.rdfTypes)) {
          removes.push({ subject: subjIri, predicate: String(rdfTypePred), object: "" });
        }
      } catch (_) {
        /* ignore building removes */
      }

      // Build adds array from incoming properties/types
      const adds: any[] = [];
      for (const ap of incomingAnn) {
        try {
          const predRaw = (ap && (ap.propertyUri || ap.property || ap.key)) || "";
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
        } catch (_) { /* ignore per-item */ }
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
        } catch (_) { /* ignore per-type */ }
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
              try { this.bufferSubjectFromQuad(q); } catch (_) { void 0; }
              this.store.removeQuad(q);
            }
          } catch (_) { /* ignore per-remove */ }
        }

        // Perform adds
        for (const a of adds) {
          try {
            const subj = namedNode(String(a.subject));
            const pred = namedNode(String(a.predicate));
            const obj = /^https?:\/\//i.test(String(a.object)) ? namedNode(String(a.object)) : literal(String(a.object));
            const exists = this.store.countQuads(subj, pred, obj as any, g) > 0;
            if (!exists) {
              this.store.addQuad(quad(subj as any, pred as any, obj as any, g));
              try { this.bufferSubjectFromQuad(quad(subj as any, pred as any, obj as any, g)); } catch (_) { void 0; }
            }
          } catch (_) { void 0; }
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
                  try { this.bufferSubjectFromQuad(qts[i]); } catch (_) { void 0; }
                  try { this.store.removeQuad(qts[i]); } catch (_) { void 0; }
                }
              }
            } catch (_) { /* ignore per-predicate dedupe failures */ }
          }
        } catch (_) { /* ignore notify/dedupe failures */ }
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
  public addTriple(subject: string, predicate: string, object: string, graphName: string = "urn:vg:data"): void {
    try {
      const g = namedNode(String(graphName));
      const s = namedNode(String(subject));
      const p = namedNode(String(predicate));
      const o = (object && /^_:/i.test(String(object))) ? blankNode(String(object).replace(/^_:/, "")) : (object && /^https?:\/\//i.test(String(object)) ? namedNode(String(object)) : literal(String(object)));
      const exists = this.store.countQuads(s, p, o as any, g) > 0;
      if (!exists) {
        this.store.addQuad(quad(s as any, p as any, o as any, g));
        try { this.bufferSubjectFromQuad(quad(s as any, p as any, o as any, g)); } catch (_) { void 0; }
      }
    } catch (e) {
      try { fallback("rdf.addTriple.failed", { subject, predicate, object, error: String(e) }); } catch (_) { void 0; }
    }
  }

  /**
   * removeTriple - idempotently remove matching triple(s) from the specified graph
   * Matches exact subject/predicate/object shapes (object must match value & literal form).
   */
  public removeTriple(subject: string, predicate: string, object: string, graphName: string = "urn:vg:data"): void {
    try {
      // Strict policy: require an explicit graph name for removals. This enforces
      // callers to choose between 'urn:vg:data' (ABox/user edits) and
      // 'urn:vg:ontologies' (TBox/ontology provenance). Passing no graph will
      // throw so callers cannot accidentally remove triples from the wrong graph.
      if (!graphName || typeof graphName !== "string" || String(graphName).trim() === "") {
        throw new Error("rdfManager.removeTriple requires an explicit graphName (e.g. 'urn:vg:data' or 'urn:vg:ontologies')");
      }

      const g = namedNode(String(graphName));
      const s = namedNode(String(subject));
      const p = namedNode(String(predicate));
      // match literal or named node based on object shape
      const objs: any[] = [];
      try {
        if (object === null || typeof object === "undefined" || String(object) === "") {
          // remove any object for the predicate from the specified graph
          const found = this.store.getQuads(s, p, null, g) || [];
          for (const q of found) {
            try { this.bufferSubjectFromQuad(q); } catch (_) { void 0; }
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
      } catch (_) { objs.push(literal(String(object))); }

      for (const o of objs) {
        {
          const found = this.store.getQuads(s, p, o as any, g) || [];
          for (const q of found) {
            try { this.bufferSubjectFromQuad(q); } catch (_) { void 0; }
            this.store.removeQuad(q);
          }
        }
      }
    } catch (e) {
      { fallback("rdf.removeTriple.failed", { subject, predicate, object, error: String(e) }); }
    }
  }

  /**
   * applyBatch - apply a batch of removes then adds atomically (single notify)
   * changes: { removes: Array<{subject,predicate,object}>, adds: Array<{subject,predicate,object}> }
   */
  public async applyBatch(changes: { removes?: any[]; adds?: any[] }, graphName: string = "urn:vg:data"): Promise<void> {
    try {
      const removes = Array.isArray(changes && changes.removes) ? changes.removes.slice() : [];
      const adds = Array.isArray(changes && changes.adds) ? changes.adds.slice() : [];
      const g = namedNode(String(graphName));

      // Perform removals first
      for (const r of removes) {
        try {
          const subj = namedNode(String(r.subject));
          const pred = namedNode(String(r.predicate));
          let objs: any[] = [];
          try {
            if (r.object === null || typeof r.object === "undefined" || String(r.object) === "") {
              const found = this.store.getQuads(subj, pred, null, g) || [];
              for (const q of found) {
                try { this.bufferSubjectFromQuad(q); } catch (_) { void 0; }
                this.store.removeQuad(q);
              }
              continue;
            }
            if (/^_:/i.test(String(r.object))) objs = [blankNode(String(r.object).replace(/^_:/, ""))];
            else if (/^https?:\/\//i.test(String(r.object))) objs = [namedNode(String(r.object))];
            else objs = [literal(String(r.object))];
          } catch (_) { objs = [literal(String(r.object))]; }

          for (const o of objs) {
            try {
              const found = this.store.getQuads(subj, pred, o as any, g) || [];
              for (const q of found) {
                try { this.bufferSubjectFromQuad(q); } catch (_) { void 0; }
                this.store.removeQuad(q);
              }
            } catch (_) { /* ignore per-object */ }
          }
        } catch (_) { /* ignore per-remove */ }
      }

      // Then perform adds (idempotent)
      for (const a of adds) {
        try {
          const subj = namedNode(String(a.subject));
          const pred = namedNode(String(a.predicate));
          let obj: any;
          try {
            if (/^_:/i.test(String(a.object))) obj = blankNode(String(a.object).replace(/^_:/, ""));
            else if (/^https?:\/\//i.test(String(a.object))) obj = namedNode(String(a.object));
            else obj = literal(String(a.object));
          } catch (_) { obj = literal(String(a.object)); }

          const exists = this.store.countQuads(subj, pred, obj as any, g) > 0;
          if (!exists) {
            this.store.addQuad(quad(subj as any, pred as any, obj as any, g));
            try { this.bufferSubjectFromQuad(quad(subj as any, pred as any, obj as any, g)); } catch (_) { void 0; }
          }
        } catch (_) { void 0; }
      }

      // Notify once after batch applied
      try { this.notifyChange(); } catch (_) { void 0; }
    } catch (e) {
      try { fallback("rdf.applyBatch.failed", { error: String(e) }, { level: "warn" }); } catch (_) { void 0; }
      try { this.notifyChange(); } catch (_) { void 0; }
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
  private sanitizeParserPrefixes(namespaces: Record<string, any> | undefined | null): Record<string, RDF.NamedNode> {
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
                (window as any).__VG_NAMESPACE_WRITER_LOG = (window as any).__VG_NAMESPACE_WRITER_LOG || [];
                (window as any).__VG_NAMESPACE_WRITER_LOG.push({ kind: "sanitizer.empty_namednode", prefix: p, raw: v, time: Date.now() });
              } catch (_) { /* ignore */ }
              try { console.warn("[VG_PREFIX_SKIPPED_EMPTY_NAMEDNODE]", { prefix: p, raw: v }); } catch (_) { /* ignore */ }
            }
            continue;
          }

          // If value is a plain string, record diagnostic and skip (do NOT coerce)
          if (typeof v === "string") {
            try {
              (window as any).__VG_NAMESPACE_WRITER_LOG = (window as any).__VG_NAMESPACE_WRITER_LOG || [];
              (window as any).__VG_NAMESPACE_WRITER_LOG.push({ kind: "sanitizer.skipped_string_value", prefix: p, raw: v, time: Date.now() });
            } catch (_) { /* ignore */ }
            try { console.warn("[VG_PREFIX_SKIPPED_STRING]", { prefix: p, raw: v }); } catch (_) { /* ignore */ }
            continue;
          }

          // Skip other shapes and log
          try {
            (window as any).__VG_NAMESPACE_WRITER_LOG = (window as any).__VG_NAMESPACE_WRITER_LOG || [];
            (window as any).__VG_NAMESPACE_WRITER_LOG.push({ kind: "sanitizer.skipped_other_shape", prefix: p, raw: v, time: Date.now() });
          } catch (_) { /* ignore */ }
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
  applyParsedNamespaces(namespaces: Record<string, RDF.NamedNode> | undefined | null): void {
    try {
      // Reject non-object inputs early
      if (!namespaces || typeof namespaces !== "object") return;

      const mergedPrefixes: string[] = [];
      for (const [p, node] of Object.entries(namespaces || {})) {
        try {
          if (!p) continue;
          // Accept only NamedNode-like objects with a non-empty .value
          if (node && typeof (node as any).value === "string" && String((node as any).value).trim() !== "") {
            const uriStr = String((node as any).value);
            const prev = this.namespaces[p];
            if (String(prev) !== uriStr) {
              this.namespaces[p] = uriStr;
              mergedPrefixes.push(String(p));
            }
          } else {
            // Record diagnostic for skipped non-NamedNode entries
            try {
              (window as any).__VG_NAMESPACE_WRITER_LOG = (window as any).__VG_NAMESPACE_WRITER_LOG || [];
              (window as any).__VG_NAMESPACE_WRITER_LOG.push({
                kind: "applyParsedNamespaces.invalid_value",
                prefix: p,
                raw: node,
                time: Date.now(),
              });
            } catch (_) { /* ignore */ }
            try { console.warn("[VG_PREFIX_SKIPPED_NON_NAMEDNODE]", { prefix: p, raw: node }); } catch (_) { /* ignore */ }
          }
        } catch (_) {
          /* ignore per-entry failures */
        }
      }

      if (mergedPrefixes.length > 0) {
        // Debug: print the new namespaces map for inspection
        try {
          console.info("[VG_NAMESPACES_MERGED]", { mergedPrefixes, namespaces: { ...(this.namespaces || {}) } });
        } catch (_) { /* ignore console failures */ }

        try { debugLog("rdf.namespaces.merged", { mergedPrefixes, namespaces: { ...(this.namespaces || {}) } }); } catch (_) { /* ignore */ }

        // Emit a single notify with namespace-change kind so consumers update once.
        try { this.notifyChange({ kind: "namespaces", prefixes: mergedPrefixes }); } catch (_) { /* ignore */ }
      }
    } catch (err) {
      try { if (typeof fallback === "function") fallback("rdf.applyParsedNamespaces.failed", { error: String(err) }); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Remove all quads stored in the named graph identified by graphName.
   * Best-effort and idempotent.
   */
  public async loadQuadsToDiagram(quadStream: any, graphName: string = "urn:vg:data"): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!quadStream || typeof quadStream.on !== "function") {
        return reject(new Error("Invalid quad stream provided to loadQuadsToDiagram"));
      }

      const g = namedNode(String(graphName));
      const prefixes: Record<string, any> = {};
      const addedQuads: any[] = [];

      const onData = (q: any) => {
        try {
          // Some quad streams provide full quad objects; ensure we add under the target graph.
          const subj = (q && q.subject) ? q.subject : null;
          const pred = (q && q.predicate) ? q.predicate : null;
          const obj = (q && q.object) ? q.object : null;
          if (!subj || !pred || !obj) return;
          const toAdd = quad(subj, pred, obj, g);
          try {
            // Delegate to helper to keep add/buffer behavior consistent with string parser path
            this.addQuadToStore(toAdd, g, addedQuads);
          } catch (_) {
            // Best-effort add when helper fails
            try { this.store.addQuad(toAdd); addedQuads.push(toAdd); } catch (_) { /* ignore */ }
          }
        } catch (err) {
          // swallow per-quad errors but surface if needed via debug
          try { console.debug("[VG_RDF] loadQuadsToDiagram.data.error", String(err).slice(0,200)); } catch (_) { /* ignore */ }
        }
      };

      const onPrefix = (prefix: string, iri: any) => {
        {
          if (prefix && typeof iri !== "undefined") prefixes[String(prefix)] = iri;
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
            (window as any).__VG_PARSED_PREFIXES_ERRORS = (window as any).__VG_PARSED_PREFIXES_ERRORS || [];
            (window as any).__VG_PARSED_PREFIXES_ERRORS.push({
              id: null,
              kind: "quad-stream",
              time: Date.now(),
              message: err && err.message ? String(err.message) : String(err),
              stack: err && err.stack ? String(err.stack) : undefined,
            });
          } catch (_) { /* ignore capture failures */ }

          try { console.error("[VG_PARSED_PREFIXES_ERROR] (quad-stream)", err); } catch (_) { /* ignore */ }
        }

        { cleanup(); }
        reject(err);
      };

      const onEnd = async () => {
        try {
          cleanup();
          // Finalize via shared helper (applies prefixes, runs reconcile, notifies, schedules flush)
          try {
            await (this as any).finalizeLoad(addedQuads, prefixes);
          } catch (e) {
            try { fallback("rdf.loadQuadsToDiagram.reconcile_failed", { error: String(e) }); } catch (_) { /* ignore */ }
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
          try { quadStream.on("prefix", onPrefix); } catch (_) { /* ignore */ }
          try {
            quadStream.on("context", (ctx: any) => {
              try {
                (window as any).__VG_PARSED_PREFIXES_DETAILED = (window as any).__VG_PARSED_PREFIXES_DETAILED || [];
                (window as any).__VG_PARSED_PREFIXES_DETAILED.push({
                  id: null,
                  kind: "quad-stream-context",
                  time: Date.now(),
                  context: ctx,
                });
              } catch (_) { /* ignore */ }
              try { console.info("[VG_PARSED_CONTEXT] (quad-stream)", { context: ctx }); } catch (_) { /* ignore */ }
            });
          } catch (_) { /* ignore */ }
        }
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

}

export const rdfManager = new RDFManager();
