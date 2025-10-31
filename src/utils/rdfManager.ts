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
  {
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
      try {
        const chunk =
          typeof content === "string"
            ? BufferImpl.from(content)
            : (content as any);
        return (Readable as any).from([chunk]);
      } catch (_) {
        // fall through to manual construction
      }
    }

    // Manual construction: create a Readable, push the content, then push EOF.
    if (
      Readable &&
      typeof Readable === "function" &&
      typeof BufferImpl !== "undefined"
    ) {
      try {
        const rs = new Readable();
        rs.push(
          typeof content === "string"
            ? BufferImpl.from(content)
            : (content as any),
        );
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
import { debugLog, debug, fallback, incr } from "../utils/startupDebug";

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
              } catch (_) {
                void 0;
              }
            }
          } catch (_) {
            void 0;
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
              console.debug(
                "[VG_RDF_WRITE_STACK]",
                st.replace(/^Error:\\s*/, ""),
              );
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
              console.debug(
                "[VG_RDF_REMOVE_STACK]",
                st.replace(/^Error:\\s*/, ""),
              );
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
              } catch (_) {
                /* ignore buffering failures */
              }
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
      // Pass the normalized object-shape map to applyParsedNamespaces (new shape)
      this.applyParsedNamespaces(normalizedPrefixMap);

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
        try {
          debugLog("rdf.load.batchCounts", {
            id: loadId || "unknown",
            graphCounts,
          });
        } catch (_) {
          void 0;
        }
        try {
          console.debug("[VG_DEBUG] rdf.load.batchCounts", {
            id: loadId || "unknown",
            graphCounts,
          });
        } catch (_) {
          void 0;
        }
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
        try {
          debugLog("rdf.load.batchCounts", { id: _vg_loadId, graphCounts });
        } catch (_) {
          void 0;
        }
        try {
          console.debug("[VG_DEBUG] rdf.load.batchCounts", {
            id: _vg_loadId,
            graphCounts,
          });
        } catch (_) {
          void 0;
        }
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
        const inputStream =
          (await createNodeReadableFromText(rdfContent)) ||
          (new Response(rdfContent).body as any);
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
          const inputStream =
            (await createNodeReadableFromText(rdfContent)) ||
            (new Response(rdfContent).body as any);
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
              await (this as any).finalizeLoad(addedQuads, prefixes, _vg_loadId);
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

    const { doFetch } = await import("./fetcher").catch(() => ({
      doFetch: undefined as any,
    }));
    const doFetchImpl =
      typeof doFetch === "function"
        ? doFetch
        : async (t: string, to: number) => {
            const c = new AbortController();
            const id = setTimeout(() => c.abort(), to);
            try {
              return await fetch(t, {
                signal: c.signal,
                headers: { Accept: "text/turtle, application/rdf+xml, application/ld+json, */*" },
              });
            } finally {
              clearTimeout(id);
            }
          };

    console.debug("[VG_RDF] loadRDFFromUrl start", {
      url,
      graphName,
      timeoutMs,
    });

    // Attempt to perform the network reading in a background worker (fetch-only).
    // If worker creation fails or streaming not available, fall back to doFetchImpl.
    let res: any = null;
    let workerInst: Worker | null = null;
    try {
      let workerSupported = false;
      try {
        // Worker support check (try constructing URL; may throw in some environments)
        // Use Vite/ESM worker URL pattern
        const workerUrl = new URL("../workers/fetchOnly.worker.ts", import.meta.url);
        try {
          workerInst = new Worker(workerUrl as any, { type: "module" });
          workerSupported = true;
        } catch (_) {
          workerInst = null;
          workerSupported = false;
        }
      } catch (_) {
        workerInst = null;
        workerSupported = false;
      }

      if (workerSupported && workerInst) {
        // Build a ReadableStream that is fed by worker messages
        const id = `w-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
        let startResolved = false;
        let startInfo: { contentType?: string | null; status?: number; statusText?: string } = {};
        const pendingChunks: ArrayBuffer[] = [];
        let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controllerRef = controller;
            workerInst!.onmessage = (ev: MessageEvent) => {
              const m = ev.data || {};
              if (!m || m.id !== id) return;
              try {
                if (m.type === "start") {
                  // Mutate the existing startInfo object so the Response headers shim can read updated values.
                  try {
                    (startInfo as any).contentType = m.contentType || null;
                    (startInfo as any).status = m.status;
                    (startInfo as any).statusText = m.statusText;
                  } catch (_) {
                    // ensure we don't throw from the handler
                    (startInfo as any).contentType = (startInfo as any).contentType || null;
                  }
                  startResolved = true;
                  // Flush any pending chunks that arrived before start was processed
                  while (pendingChunks.length > 0) {
                    try {
                      const b = pendingChunks.shift()!;
                      controller.enqueue(new Uint8Array(b));
                    } catch (_) { /* ignore per-chunk */ }
                  }
                } else if (m.type === "chunk") {
                  try {
                    const buf = m.buffer as ArrayBuffer;
                    if (!startResolved) {
                      pendingChunks.push(buf);
                    } else {
                      controller.enqueue(new Uint8Array(buf));
                    }
                  } catch (e) {
                    try { controller.error(e); } catch (_) {}
                  }
                } else if (m.type === "end") {
                  try { controller.close(); } catch (_) {}
                } else if (m.type === "error") {
                  try { controller.error(new Error(String(m.message || "worker fetch error"))); } catch (_) {}
                }
              } catch (_) {
                try { controller.error(new Error("worker message handling failed")); } catch (_) {}
              }
            };
            // Kick off fetch in worker (fire-and-forget; messages will arrive)
            try {
              // Provide a conservative Accept header preferring Turtle so servers
              // that rely on content negotiation return an RDF serialization.
              workerInst!.postMessage({
                type: "fetchUrl",
                id,
                url,
                timeoutMs,
                headers: { Accept: "text/turtle, application/rdf+xml, application/ld+json, */*" },
              });
            } catch (e) {
              try { controller.error(e); } catch (_) {}
            }
          },
          cancel() {
            try {
              if (workerInst) {
                try { workerInst.terminate(); } catch (_) {}
                workerInst = null;
              }
            } catch (_) {}
          },
        });

        // Construct a Response-like object from the stream so the existing parser paths can consume it.
        // Note: headers may be absent — parser will attempt detection heuristics.
        res = new Response(stream);
        // Attach a small shim so headers.get('content-type') reads startInfo when available.
        try {
          const origHeadersGet = (res as Response).headers.get.bind((res as Response).headers);
          Object.defineProperty((res as any), "__vg_start_info", { value: startInfo, writable: true });
          const shimHeaders = {
            get(k: string) {
              try {
                if (k && k.toLowerCase() === "content-type") {
                  const s = (res as any).__vg_start_info && (res as any).__vg_start_info.contentType;
                  if (s) return s;
                }
              } catch (_) {}
              try { return origHeadersGet(k); } catch (_) { return null; }
            },
          };
          // @ts-ignore - replace headers accessor for downstream consumers
          (res as any).headers = shimHeaders;
        } catch (_) {
          // non-critical if shim fails
        }
      }
    } catch (err) {
      try {
        if (workerInst) {
          try { workerInst.terminate(); } catch (_) {}
          workerInst = null;
        }
      } catch (_) {}
      res = null;
    }

    // Fallback: worker not available or stream creation failed — use normal fetch wrapper
    if (!res) {
      const fallbackRes = await doFetchImpl(url, timeoutMs, { minimal: false });
      res = fallbackRes;
    }

    if (!res) throw new Error(`No response for ${url}`);
    try {
      if (!res.ok) {
        console.warn(`[VG_RDF] HTTP ${res.status} ${res.statusText} for ${url}`);
      }
    } catch (_) {
      // ignore
    }
    const contentTypeHeader =
      (res.headers && res.headers.get
        ? res.headers.get("content-type")
        : null) || null;
    console.debug("[VG_RDF] fetched", {
      url,
      status: res.status,
      contentType: contentTypeHeader,
    });

    // Normalise to text first to avoid streaming differences between Node and browsers.
    // Use streaming helper so callers can get progress and the streaming logic is centralized.
    // Errors from fetch/stream are intentionally surfaced (not swallowed).
    const { responseToText } = await import("./fetchStream").catch(() => ({ responseToText: undefined as any }));
    let txt: string;
    if (typeof responseToText === "function") {
      try {
        txt = await responseToText(res);
      } catch (err) {
        // Surface parse/fetch errors clearly so devs can inspect them in console
        console.error("[VG_RDF] responseToText failed for", url, err);
        throw err;
      }
    } else {
      // Fallback: environment where helper couldn't be imported — use built-in text()
      txt = await res.text();
    }

    // If the fetched content clearly looks like Turtle (or the content-type explicitly indicates Turtle),
    // prefer the in-memory N3 parser path which accepts a string and does not require Node Readable streams.
    // Default to text/turtle when server did not provide a content-type header, but first attempt simple
    // content sniffing for common formats (e.g. JSON-LD) to avoid mis-classifying payloads.
    const mimeType = contentTypeHeader
      ? contentTypeHeader.split(";")[0].trim() || "text/turtle"
      : "text/turtle";

    // Basic content sniffing: detect JSON-LD objects/arrays containing @id/@context markers.
    let detectedMime = mimeType;
    try {
      if (!contentTypeHeader && typeof txt === "string") {
        const leading = txt.slice(0, 512);
        const looksLikeJson = /^\s*[\[\{]/.test(leading) && /"@id"|"@context"/.test(leading);
        if (looksLikeJson) {
          detectedMime = "application/ld+json";
        }
      }
    } catch (_) {
      // ignore sniffing failures and keep mimeType
      void 0;
    }

    const prefersTurtle = detectedMime === "text/turtle" || detectedMime === "text/n3";

    // If payload is large (heuristic) or caller explicitly requested worker use, use parser-in-worker.
    // This offloads parsing CPU to a worker and streams parsed quad batches back to the main thread.
    // Worker path uses src/workers/parseRdf.worker.ts and a simple ACK-based backpressure protocol.
    const workerThreshold = 200000; // characters
    const useWorker =
      (options && (options as any).useWorker) ||
      (typeof txt === "string" && txt.length > workerThreshold);

    if (!prefersTurtle && useWorker) {
      try {
        console.info("[VG_RDF] using parser worker for large/complex payload", { url, len: txt.length });
        const workerUrl = new URL("../workers/parseRdf.worker.ts", import.meta.url);
        let w: Worker | null = null;
        try {
          // Instrument: log worker URL attempt so we can diagnose worker resolution issues.
          try { console.debug("[VG_RDF] spawnWorker.attempt", { workerUrl: String(workerUrl) }); } catch (_) {}
          w = new Worker(workerUrl as any, { type: "module" });
          try { console.debug("[VG_RDF] spawnWorker.success", { workerUrl: String(workerUrl) }); } catch (_) {}
          // Attach an error handler so uncaught worker errors surface in the main thread console immediately.
          try {
            (w as any).onerror = (ev: any) => {
              try { console.debug("[VG_RDF] worker.onerror", ev && (ev.message || ev)); } catch (_) {}
            };
            (w as any).onmessageerror = (ev: any) => {
              try { console.debug("[VG_RDF] worker.onmessageerror", ev && ev); } catch (_) {}
            };
          } catch (_) {}
        } catch (errWorker) {
          try { console.debug("[VG_RDF] spawnWorker.failed", { error: String(errWorker), workerUrl: String(workerUrl) }); } catch (_) {}
          w = null;
        }
        if (!w) {
          console.info("[VG_RDF] worker not available, falling back to main-thread parse");
        } else {
          const loadId = `wl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
          const addedQuads: Quad[] = [];
          const collectedPrefixes: Record<string, any> = {};
          // Target graph term used for batch insert fallback when incoming plain quad has no explicit graph
          const targetGraph = namedNode(String(graphName || "urn:vg:data"));
          let resolved = false;

          const cleanupWorker = () => {
            try {
              if (w) {
                try { w.terminate(); } catch (_) {}
                w = null;
              }
            } catch (_) {
              /* ignore */
            }
          };

          // Promise that resolves when worker reports end (or error)
          const workerPromise = new Promise<void>((resolve, reject) => {
            try {
              if (!w) return reject(new Error("worker spawn failed"));
              // instrumentation: watchdog + verbose worker message logging
              let __vg_worker_seen = false;
              const __vg_watchdog = setTimeout(() => {
                if (!__vg_worker_seen) {
                  try { console.warn("[VG_RDF] parser worker unresponsive - terminating and falling back"); } catch (_) {}
                  try {
                    if (w) {
                      try { w.terminate(); } catch (_) { /* ignore */ }
                      w = null;
                    }
                  } catch (_) {}
                  try { reject(new Error("parser worker unresponsive")); } catch (_) {}
                }
              }, 7000);

              w.onmessage = async (ev: MessageEvent) => {
                // Mark worker as alive and clear watchdog as soon as any message arrives
                try { __vg_worker_seen = true; clearTimeout(__vg_watchdog); } catch (_) {}
              const m = ev.data || {};
              try {
                // Avoid logging the full worker payload (quads arrays can be very large).
                // Log only small, useful metadata so console output doesn't slow parsing.
                const lightweight = {
                  type: (m && m.type) || null,
                  id: (m && m.id) || null,
                  seq: (m && (m as any).seq) || null,
                  count: (m && typeof (m as any).count === "number") ? (m as any).count : (Array.isArray((m as any).quads) ? (m as any).quads.length : undefined),
                  final: (m && (m as any).final) || false,
                };
                console.debug("[VG_RDF] worker.onmessage", lightweight);
              } catch (_) {}
              if (!m || !m.type) return;
              try {
                  if (m.type === "start") {
                    // worker reports contentType/status
                    try {
                      if (m.contentType) detectedMime = String(m.contentType);
                    } catch (_) {}
                  } else if (m.type === "prefix" && m.prefixes) {
                    try {
                      Object.assign(collectedPrefixes, m.prefixes || {});
                    } catch (_) {}
                  } else if (m.type === "quads" && Array.isArray(m.quads)) {
                      try {
                        // Ingest plain quads into store on main thread
                        const plain = m.quads as any[];
                        for (const pq of plain) {
                          try {
                            const sTerm = /^_:/.test(String(pq.s || "")) ? blankNode(String(pq.s).replace(/^_:/, "")) : namedNode(String(pq.s));
                            const pTerm = namedNode(String(pq.p));
                            let oTerm: any = null;
                            try {
                              if (pq.o && pq.o.t === "iri") oTerm = namedNode(String(pq.o.v));
                              else if (pq.o && pq.o.t === "bnode") oTerm = blankNode(String(pq.o.v));
                              else if (pq.o && pq.o.t === "lit") {
                                if (pq.o.dt) oTerm = literal(String(pq.o.v), namedNode(String(pq.o.dt)));
                                else if (pq.o.ln) oTerm = literal(String(pq.o.v), String(pq.o.ln));
                                else oTerm = literal(String(pq.o.v));
                              } else oTerm = literal(String((pq.o && pq.o.v) || ""));
                            } catch (e_inner) {
                              try { console.debug("[VG_RDF] worker.quadTermParse.failed", String(e_inner)); } catch (_) {}
                              oTerm = literal(String((pq.o && pq.o.v) || ""));
                            }
                            const gTerm = pq.g ? namedNode(String(pq.g)) : targetGraph;
                            const toAdd = quad(sTerm, pTerm, oTerm, gTerm);
                            try {
                              this.addQuadToStore(toAdd, gTerm, addedQuads);
                            } catch (_) {
                              try { this.store.addQuad(toAdd); addedQuads.push(toAdd); } catch (_) {}
                            }
                          } catch (errQuad) {
                            try { console.debug("[VG_RDF] worker.quad.ingest.failed", String(errQuad)); } catch (_) {}
                          }
                        }

                        // ACK back to worker so it can continue
                        try {
                          w.postMessage({ type: "ack", id: String(m.id || loadId) });
                        } catch (ackErr) {
                          try { console.debug("[VG_RDF] worker.ack.failed", String(ackErr)); } catch (_) {}
                        }
                      } catch (batchErr) {
                        try { console.debug("[VG_RDF] worker.batchProcessing.failed", String(batchErr)); } catch (_) {}
                      }
                  } else if (m.type === "end") {
                    try {
                      // finalize load: apply prefixes + reconcile + notify
                      (async () => {
                        try {
                          await (this as any).finalizeLoad(addedQuads, collectedPrefixes || {}, loadId);
                        } catch (e) {
                          try { console.error("[VG_RDF] worker finalize failed", e); } catch (_) {}
                        } finally {
                          resolved = true;
                          try { resolve(); } catch (_) {}
                          cleanupWorker();
                        }
                      })();
                    } catch (e) {
                      try { reject(e); } catch (_) {}
                      cleanupWorker();
                    }
                  } else if (m.type === "error") {
                    try { reject(new Error(String(m.message || "worker error"))); } catch (_) {}
                    cleanupWorker();
                  }
                } catch (innerErr) {
                  try { reject(innerErr); } catch (_) {}
                  cleanupWorker();
                }
              };

              // Start worker parsing (send text to parse)
              try {
                // Mark parsing as in-progress so subject-level notifications are deferred
                try { (this as any).parsingInProgress = true; } catch (_) { /* ignore */ }
                w.postMessage({ type: "parseText", id: loadId, text: txt, mime: detectedMime });
              } catch (errPost) {
                try { reject(errPost); } catch (_) {}
                cleanupWorker();
              }
            } catch (outerErr) {
              try { reject(outerErr); } catch (_) {}
              cleanupWorker();
            }
          });

          try {
            await workerPromise;
            return;
          } catch (errWorker) {
            // worker failed — fall back to main-thread parse
            console.warn("[VG_RDF] parser worker failed, falling back", errWorker);
            cleanupWorker();
          }
        }
      } catch (err) {
        // Fall through to main-thread parsing on any worker orchestration errors
        console.info("[VG_RDF] parser-worker orchestration failed, fallback to main-thread", { error: String(err).slice(0,200) });
      }
    }

    if (prefersTurtle) {
      try {
        console.info(
          "[VG_RDF] parsing text directly with N3 Parser (browser-friendly)",
          { url, mimeType },
        );
        // Delegate directly to the existing loader which parses a string using N3.Parser.
        return await this.loadRDFIntoGraph(
          txt,
          graphName || "urn:vg:data",
          "text/turtle",
        );
      } catch (err) {
        // If direct parsing fails for unexpected reasons, fall through to the rdf-parse path as a fallback.
        console.info(
          "[VG_RDF] direct N3 parse failed, will try rdf-parse fallback",
          { url, error: String(err).slice(0, 200) },
        );
      }
    }

    // Prefer a Node-style Readable created by the shared helper; fall back to WHATWG stream when unavailable.
    const inputStream =
      (await createNodeReadableFromText(txt)) ||
      (new Response(txt).body as any);

    // Attempt 1: prefer parsing by HTTP content-type (mimetype). If this fails
    // (parser/serializer rejects) we will retry using the filename/path as baseIRI.
    console.info("[VG_RDF] parse-by-mimetype:start", {
      contentType: contentTypeHeader,
      url,
    });
      try {
        // Use the resolved detectedMime (sniffed or provided) so rdf-parse receives the most
        // accurate contentType available. Fall back to mimeType if detection failed.
        try {
          const quadStream = rdfParser.parse(inputStream, {
            contentType: (typeof (detectedMime) !== "undefined" && detectedMime) ? detectedMime : (mimeType || undefined),
            baseIRI: url,
          });
          return await this.loadQuadsToDiagram(
            quadStream,
            graphName || "urn:vg:data",
          );
        } catch (err) {
          // If rdf-parse fails specifically due to missing contentType/path, fall back to the
          // N3 string-based parser path which is safer in ambiguous cases. Otherwise rethrow.
          const message = String(err && (err as any).message ? (err as any).message : err);
          if (message.includes("Missing 'contentType' or 'path' option") || message.includes("Missing \"contentType\" or \"path\" option")) {
            console.info("[VG_RDF] rdf-parse missing contentType/path — falling back to string parser", { url, error: message });
            // Fall back: parse the fetched text via the existing fast N3 path
            return await this.loadRDFIntoGraph(txt, graphName || "urn:vg:data", "text/turtle");
          }
          // Not the specific missing option error — rethrow to be handled by outer fallback logic.
          throw err;
        }
      } catch (err) {
        // parse/serialize via mimetype failed — retry using filename/baseIRI heuristics
        console.info("[VG_RDF] parse-by-mimetype:failed, retrying by filename", {
          url,
          error: String(err).slice(0, 500),
        });

      // Re-create a fresh Node-style Readable for retry (streams are single-use)
      const inputStream2 =
        (await createNodeReadableFromText(txt)) ||
        (new Response(txt).body as any);
      console.info("[VG_RDF] parse-by-filename:start", {
        path: url,
        baseIRI: url,
      });

      // Defensive: only pass a `path` option to rdfParser when the URL contains a file extension.
      // Some URLs end with a trailing slash (no extension) and rdf-parse will error when asked
      // to detect a format from an extension that doesn't exist. Prefer passing `baseIRI` only
      // and allow rdf-parse to sniff content when no extension is available.
      const hasExt = /\.[a-z0-9]{1,8}(?:[?#]|$)/i.test(String(url || ""));
      const parseOpts: any = { baseIRI: url };
      if (hasExt) parseOpts.path = url;

      const quadStream2 = rdfParser.parse(inputStream2, parseOpts);
      // Delegate to existing loader which handles store insertion, namespaces, notifications
      return await this.loadQuadsToDiagram(
        quadStream2,
        graphName || "urn:vg:data",
      );
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
   * Get the store instance for direct access
   */
  getStore(): Store {
    return this.store;
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
            return /^[a-z][a-z0-9+.\-]*:/i.test(s) ? namedNode(s) : literal(s);
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
            } else if (/^[a-z][a-z0-9+.\-]*:/i.test(sObj)) {
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
              else if (/^[a-z][a-z0-9+.\-]*:/i.test(sObj)) obj = namedNode(sObj);
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
            await (this as any).finalizeLoad(addedQuads, prefixes);
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
