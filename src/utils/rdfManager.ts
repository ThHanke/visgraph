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

/* eslint-disable no-empty */

import {
  Store,
  Parser,
  Writer,
  Quad,
  DataFactory,
} from "n3";
const { namedNode, literal, quad, blankNode } = DataFactory;
import { useAppConfigStore } from "../stores/appConfigStore";
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
        try {
          uriCandidates.add(String(u));
        } catch (_) {}
      });

      (Array.from(this.blacklistedPrefixes) || []).forEach((p) => {
        try {
          // Prefer runtime-registered namespace
          const nsFromMgr = this.namespaces && this.namespaces[p];
          if (nsFromMgr) uriCandidates.add(nsFromMgr);
          // Fall back to known well-known prefix mapping
          try {
            const wk = (WELL_KNOWN && (WELL_KNOWN as any).prefixes) || {};
            if (wk && wk[p]) uriCandidates.add(String(wk[p]));
          } catch (_) {}
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
              } catch (_) {}
            }
          } catch (_) {}
        } catch (_) {}
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
        try {
          if (!u) continue;
          if (s.startsWith(u)) return true;
        } catch (_) {
          /* ignore per-candidate failures */
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
    return false;
  }

  constructor() {
    this.store = new Store();
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
            (this as any).bufferSubjectFromQuad && (this as any).bufferSubjectFromQuad(q);
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
          try { (window as any).__VG_ENABLE_RDF_WRITE_LOGGING = (window as any).__VG_ENABLE_RDF_WRITE_LOGGING || (() => { try { (window as any).__VG_LOG_RDF_WRITES = true; enableWriteTracing(); return true; } catch (err) { return false; } }); } catch (_) {}
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

  private scheduleSubjectFlush(delay = 50) {
    try {
      if (this.subjectFlushTimer) {
        window.clearTimeout(this.subjectFlushTimer);
      }
      this.subjectFlushTimer = window.setTimeout(() => {
        try {
          if (this.subjectChangeBuffer.size === 0) {
            this.subjectFlushTimer = null;
            return;
          }
          const subjects = Array.from(this.subjectChangeBuffer);
          // Collect quads for the subjects we're about to emit, preserving the exact triples
          // that triggered the change. This allows consumers to process triple-level increments
          // without querying the store.
          const quads: Quad[] = [];
          try {
            for (const s of subjects) {
              try {
                const arr = this.subjectQuadBuffer.get(s) || [];
                if (arr && arr.length > 0) quads.push(...arr);
                // Clear the buffered quads for this subject
                this.subjectQuadBuffer.delete(s);
              } catch (_) { /* ignore per-subject quad collection failures */ }
            }
          } catch (_) { /* ignore overall quad collection failures */ }

          this.subjectChangeBuffer.clear();
          this.subjectFlushTimer = null;

          for (const cb of Array.from(this.subjectChangeSubscribers)) {
            try {
              // Call subscribers with both subjects and the associated quads.
              // Existing subscribers that only accept subjects will simply ignore the second arg.
              try {
                (cb as any)(subjects, quads);
              } catch (_) {
                // Fallback: call with just subjects if subscriber throws when receiving two args.
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
      if (this.isBlacklistedIri(subj)) return;

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

  // ---------- Loading / parsing / applying RDF ----------
  async loadRDF(rdfContent: string, mimeType?: string): Promise<void> {
    // Deprecated: prefer `loadRDFIntoGraph` which requires an explicit named graph.
    // For backward compatibility, forward to `loadRDFIntoGraph` using the data graph.
    return this.loadRDFIntoGraph(rdfContent, "urn:vg:data", mimeType);
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
    if (!graphName) return this.loadRDF(rdfContent, mimeType);

    const rawKey =
      typeof rdfContent === "string" ? rdfContent : String(rdfContent);
    const normalized = rawKey.replace(/\s+/g, " ").trim();
    const key =
      normalized.length > 1000 ? `len:${normalized.length}` : normalized;

    if (this._inFlightLoads.has(key)) {
      return this._inFlightLoads.get(key)!;
    }

    const initialCount = this.store.getQuads(null, null, null, null).length;
    const _vg_loadId = `load-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const _vg_loadStartMs = Date.now();
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

    const finalize = (prefixes?: Record<string, string>) => {
      if (prefixes) {
        this.namespaces = { ...this.namespaces, ...prefixes };
      }

      const newCount = this.store.getQuads(null, null, null, null).length;
      const added = Math.max(0, newCount - initialCount);

      let shouldLog = true;
      try {
        const state = (useAppConfigStore as any)?.getState
          ? (useAppConfigStore as any).getState()
          : null;
        if (
          state &&
          state.config &&
          typeof state.config.debugRdfLogging === "boolean"
        ) {
          shouldLog = Boolean(state.config.debugRdfLogging);
        }
      } catch (_) {
        shouldLog = true;
      }

      if (shouldLog) {
        try {
          const durationMs = Date.now() - (_vg_loadStartMs || Date.now());
          try {
            debug("rdf.load.summary", {
              id: _vg_loadId,
              key,
              graphName: graphName || null,
              added,
              newCount,
              durationMs,
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
          try {
            incr("totalTriplesAdded", added);
            debugLog("rdf.load.end", {
              id: _vg_loadId,
              key,
              graphName: graphName || null,
              added,
              newCount,
              durationMs,
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

      // Notify subscribers that RDF changed
      try {
        this.notifyChange();
      } catch (_) {
        /* ignore */
      }

      resolveFn();
    };

    try {
      const lowerMime = (mimeType || "").toLowerCase();

      // Handle JSON-LD input: many tests or remote endpoints may return JSON-LD strings.
      // Detect JSON-LD by mimeType or by content starting with "{" and containing "@context".
      // If detected, convert JSON-LD to N-Quads using the jsonld library so the N3 parser can consume it.
      try {
        const looksJsonLd =
          (mimeType && mimeType.includes("json")) ||
          (/^\s*\{/.test(rdfContent) && rdfContent.includes("@context"));
        if (looksJsonLd) {
          try {
            const jsonld = await import("jsonld");
            try {
              // Attempt to parse as JSON first; if parsing fails, pass the original string to jsonld.
              let parsed: any = rdfContent;
              if (typeof rdfContent === "string") {
                try {
                  parsed = JSON.parse(rdfContent);
                } catch (_) {
                  // keep original string if not valid JSON (some fixtures may be already processed)
                  parsed = rdfContent;
                }
              }
              // Convert to N-Quads (text) which the N3 parser can consume.
              // jsonld.toRDF may return a string when format is requested.
              const nquads = await (jsonld as any).toRDF(parsed, {
                format: "application/n-quads",
              });
              if (nquads && typeof nquads === "string" && nquads.trim()) {
                rdfContent = nquads;
                // treat converted content as n-quads going forward (parser will handle it)
              }
            } catch (convErr) {
              try {
                if (typeof fallback === "function") {
                  fallback("rdf.jsonld.convert_failed", { error: String(convErr) });
                }
              } catch (_) { /* ignore */ }
            }
          } catch (impErr) {
            try {
              if (typeof fallback === "function") {
                fallback("rdf.jsonld.import_failed", { error: String(impErr) });
              }
            } catch (_) { /* ignore */ }
          }
        }
      } catch (_) { /* non-fatal detection errors should not prevent other parsers */ }

      if (lowerMime.includes("xml") || /^\s*<\?xml/i.test(rdfContent)) {
        try {
          const mod = await import("rdfxml-streaming-parser");
          const RdfXmlParser = (mod &&
            (mod.RdfXmlParser ||
              mod.default?.RdfXmlParser ||
              mod.default)) as any;
          if (RdfXmlParser) {
            const parser = new RdfXmlParser();
            const prefixesCollected: Record<string, string> = {};
            const g = namedNode(graphName);
            parser.on("data", (quadItem: any) => {
              try {
                const exists =
                  this.store.countQuads(
                    quadItem.subject,
                    quadItem.predicate,
                    quadItem.object,
                    g,
                  ) > 0;
                if (!exists) {
                  try {
                    if (
                      quadItem &&
                      quadItem.subject &&
                      quadItem.predicate &&
                      quadItem.object
                    ) {
                      console.debug(
                        "[VG_RDF_ADD] xml.graph",
                        (quadItem as any)?.subject?.value,
                        (quadItem as any)?.predicate?.value,
                        (quadItem as any)?.object?.value,
                        "graph:",
                        g.value,
                      );
                      this.store.addQuad(
                        quad(
                          quadItem.subject,
                          quadItem.predicate,
                          quadItem.object,
                          g,
                        ),
                      );
                      try {
                        this.bufferSubjectFromQuad(
                          quad(
                            quadItem.subject,
                            quadItem.predicate,
                            quadItem.object,
                            g,
                          ),
                        );
                      } catch (_) {
                        /* ignore */
                      }
                    } else {
                      console.warn(
                        "[VG_RDF_ADD_SKIPPED] invalid quadItem in xml parser for graph",
                        quadItem,
                      );
                    }
                  } catch (innerErr) {
                    try {
                      this.store.addQuad(
                        quad(
                          quadItem.subject,
                          quadItem.predicate,
                          quadItem.object,
                          g,
                        ),
                      );
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
              } catch (e) {
                try {
                  this.store.addQuad(
                    quad(
                      quadItem.subject,
                      quadItem.predicate,
                      quadItem.object,
                      g,
                    ),
                  );
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
            });
            parser.on("prefix", (prefix: string, iri: string) => {
              try {
                prefixesCollected[prefix] = iri;
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
            parser.on("end", () => finalize(prefixesCollected));
            parser.on("error", (err: any) => {
              try {
                // Expose structured parse error for UI consumption (XML parser path into graph)
                try {
                  if (typeof window !== "undefined") {
                    try {
                      (window as any).__VG_LAST_RDF = rdfContent;
                    } catch (_) {
                      /* ignore */
                    }
                    const lines = String(rdfContent || "").split(/\r?\n/);
                    const snippet = lines
                      .slice(0, Math.min(lines.length, 40))
                      .join("\n");
                    const errMsg = String(err);
                    try {
                      (window as any).__VG_LAST_RDF_ERROR = {
                        message: errMsg,
                        snippet,
                      };
                    } catch (_) {
                      /* ignore */
                    }
                    try {
                      window.dispatchEvent(
                        new CustomEvent("vg:rdf-parse-error", {
                          detail: { message: errMsg, snippet },
                        }),
                      );
                    } catch (_) {
                      /* ignore */
                    }

                    console.error(
                      "[VG_RDF_PARSE_ERROR]",
                      errMsg.slice(0, 200),
                      "snippet:",
                      snippet.slice(0, 1000),
                    );
                  }
                } catch (_) {
                  /* ignore structured logging failures */
                }
              } catch (_) {
                /* ignore outer */
              }
              try {
                rejectFn(err);
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

            parser.write(rdfContent);
            parser.end();
            return promise;
          }
        } catch (e) {
          try {
            if (typeof fallback === "function") {
              fallback("emptyCatch", { error: String(e) });
            }
          } catch (_) {
            /* ignore */
          }
        }
      }

      const g = namedNode(graphName);
      // If the content uses common prefixed names but does not declare them,
      // prepend any known namespace declarations from this.namespaces so the
      // parser won't error on "Undefined prefix".
      try {
        const used = Array.from(
          new Set(
            (rdfContent.match(/\b([A-Za-z][\w-]*)\s*:/g) || []).map((m) =>
              m.replace(/:.*/, ""),
            ),
          ),
        );
        const declared = Array.from(
          new Set(
            (rdfContent.match(/@prefix\s+([A-Za-z][\w-]*):/g) || []).map((m) =>
              m.replace(/@prefix\s+([A-Za-z][\w-]*):.*/, "$1"),
            ),
          ),
        );
        const missing = used.filter(
          (p) => !declared.includes(p) && this.namespaces[p],
        );
        if (missing.length > 0) {
          const adds =
            missing
              .map((p) => `@prefix ${p}: <${this.namespaces[p]}> .`)
              .join("\n") + "\n";
          rdfContent = adds + rdfContent;
        }
      } catch (_) {
        /* ignore */
      }

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
            const exists =
              this.store.countQuads(
                quadItem.subject,
                quadItem.predicate,
                quadItem.object,
                g,
              ) > 0;
            if (!exists) {
              try {
                if (
                  quadItem &&
                  quadItem.subject &&
                  quadItem.predicate &&
                  quadItem.object
                ) {
                  // console.debug(
                  //   "[VG_RDF_ADD] parse.graph",
                  //   (quadItem as any)?.subject?.value,
                  //   (quadItem as any)?.predicate?.value,
                  //   (quadItem as any)?.object?.value,
                  //   "graph:",
                  //   g.value,
                  // );
                  this.store.addQuad(
                    quad(
                      quadItem.subject,
                      quadItem.predicate,
                      quadItem.object,
                      g,
                    ),
                  );
                  try {
                    this.bufferSubjectFromQuad(
                      quad(
                        quadItem.subject,
                        quadItem.predicate,
                        quadItem.object,
                        g,
                      ),
                    );
                  } catch (_) {
                    /* ignore */
                  }
                } else {
                  console.warn(
                    "[VG_RDF_ADD_SKIPPED] invalid quadItem from parser for graph",
                    quadItem,
                  );
                }
              } catch (inner) {
                try {
                  this.store.addQuad(
                    quad(
                      quadItem.subject,
                      quadItem.predicate,
                      quadItem.object,
                      g,
                    ),
                  );
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
          } catch (e) {
            try {
              this.store.addQuad(
                quad(quadItem.subject, quadItem.predicate, quadItem.object, g),
              );
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
          finalize(prefixes);
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
  async loadFromUrl(
    url: string,
    options?: {
      timeoutMs?: number;
      onProgress?: (progress: number, message: string) => void;
    },
  ): Promise<{ content: string; mimeType: string | null }> {
    const timeoutMs = options?.timeoutMs ?? 15000;

    // Helper to perform a fetch with timeout and Accept headers
    const doFetch = async (target: string, timeout: number) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const res = await fetch(target, {
          signal: controller.signal,
          headers: {
            Accept:
              "text/turtle, application/rdf+xml, application/ld+json, */*",
          },
        });
        return res;
      } finally {
        clearTimeout(timeoutId);
      }
    };

    const looksLikeRdf = (text: string) => {
      const t = text.trim();
      // quick heuristics for Turtle/TTL/JSON-LD/RDF/XML
      if (!t) return false;
      if (
        t.startsWith("@prefix") ||
        t.startsWith("PREFIX") ||
        t.includes("http://www.w3.org/1999/02/22-rdf-syntax-ns#") ||
        t.includes("@id") ||
        t.includes("@context")
      )
        return true;
      if (t.startsWith("<") && t.includes("rdf:")) return true;
      if (t.startsWith("{") && t.includes("@context")) return true;
      if (
        t.includes("owl:") ||
        t.includes("rdf:type") ||
        t.includes("rdfs:label")
      )
        return true;
      return false;
    };

    // Try candidates (prefer https)
    const candidateUrls = url.startsWith("http://")
      ? [url.replace(/^http:\/\//, "https://"), url]
      : [url];

    // Primary attempt: direct browser fetch
    let lastDirectSnippet = "";
    for (const candidate of candidateUrls) {
      try {
        const response = await doFetch(candidate, timeoutMs);
        if (!response) continue;

        const contentTypeHeader = response.headers.get("content-type") || "";
        const mimeType = contentTypeHeader.split(";")[0].trim() || null;
        const content = await response.text();

        // Debug: record small or suspicious fetches to help diagnose why content is tiny
        if (content.length < 200) {
          try {
            debugLog("rdf.fetch.small", {
              url: candidate,
              len: content.length,
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
        }

        // If content looks like RDF, accept it. If it's HTML or clearly not RDF, skip to proxy fallback.
        const mimeIndicatesHtml = mimeType && mimeType.includes("html");
        if (!mimeIndicatesHtml && looksLikeRdf(content)) {
          return { content, mimeType };
        }

        // Capture non-RDF content so we can provide a helpful snippet to the UI if proxy fallback fails.
        try {
          lastDirectSnippet = String(content || "").slice(0, 1000);
        } catch (_) {
          lastDirectSnippet = "";
        }

        // otherwise continue to next candidate or fall through to proxy
      } catch (err) {
        // typical CORS / network errors will be caught here; we'll try the proxy fallback next
        try {
          const errMsg =
            err && (err as any).message ? (err as any).message : String(err);
          fallback(
            "rdf.fetch.directFailed",
            { url: candidate, error: errMsg },
            { level: "warn", captureStack: false },
          );
          // Expose a structured, developer-friendly error immediately so the UI can show a snippet
          if (typeof window !== "undefined") {
            try {
              (window as any).__VG_LAST_RDF_ERROR = {
                message: `Direct fetch failed for ${candidate}: ${errMsg}`,
                url: String(candidate),
                snippet: String(errMsg).slice(0, 1000),
              };
              try {
                window.dispatchEvent(
                  new CustomEvent("vg:rdf-parse-error", {
                    detail: (window as any).__VG_LAST_RDF_ERROR,
                  }),
                );
              } catch (_) {
                /* ignore dispatch failures */
              }
            } catch (_) {
              /* ignore structured error attach failures */
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
    }

    // If direct fetch returned non-RDF content (but not an error), pre-populate a helpful snippet
    // so the UI can show why the direct fetch path didn't yield RDF before we attempt the proxy.
    try {
      if (lastDirectSnippet && typeof window !== "undefined") {
        try {
          (window as any).__VG_LAST_RDF_ERROR = {
            message: `Direct fetch returned non-RDF content for ${url}`,
            url: String(url),
            snippet: lastDirectSnippet,
          };
          try {
            window.dispatchEvent(
              new CustomEvent("vg:rdf-parse-error", {
                detail: (window as any).__VG_LAST_RDF_ERROR,
              }),
            );
          } catch (_) {
            /* ignore */
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
    } catch (_) {
      try {
        if (typeof fallback === "function") {
          fallback("emptyCatch", { error: String(_) });
        }
      } catch (__) {
        /* ignore fallback errors */
      }
    }

    // Fallback: use dev server proxy at /__external (configured in vite.config.ts) to bypass CORS/redirect issues.
    try {
      if (typeof window !== "undefined") {
        const proxyUrl = `/__external?url=${encodeURIComponent(url)}`;
        try {
          const proxyResponse = await doFetch(proxyUrl, timeoutMs * 2);
          if (proxyResponse && proxyResponse.ok) {
            const contentTypeHeader =
              proxyResponse.headers.get("content-type") || "";
            const mimeType = contentTypeHeader.split(";")[0].trim() || null;
            const content = await proxyResponse.text();

            // Debug log
            try {
              debugLog("rdf.fetch.proxyFetched", {
                url,
                len: content.length,
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

            if (
              looksLikeRdf(content) ||
              (mimeType &&
                (mimeType.includes("turtle") ||
                  mimeType.includes("rdf") ||
                  mimeType.includes("json")))
            ) {
              return { content, mimeType };
            }

            // proxy returned content that's not clearly RDF -> still return content so parser can attempt, but record a fallback
            try {
              fallback(
                "rdf.fetch.proxyNonRdf",
                { url, len: content.length, mimeType },
                { level: "warn" },
              );
            } catch (_) {
              try {
                if (typeof fallback === "function") {
                  fallback("emptyCatch", { error: String(_) });
                }
              } catch (_) {
                /* ignore */
              }
            }
            return { content, mimeType };
          } else {
            const status = proxyResponse ? proxyResponse.status : "no-response";
            // Attempt to read response body to provide a helpful snippet for debugging (dev proxy may include HTML error pages)
            let bodySnippet = "";
            try {
              if (proxyResponse) {
                const text = await proxyResponse.text();
                bodySnippet = String(text || "").slice(0, 1000);
              }
            } catch (_) {
              /* ignore body read failures */
            }

            try {
              if (typeof window !== "undefined") {
                const fallbackSnippet =
                  bodySnippet ||
                  `Proxy fetch failed (status: ${status}) for ${url}`;
                (window as any).__VG_LAST_RDF_ERROR = {
                  message: `Proxy fetch failed (status: ${status}) for ${url}`,
                  url: String(url),
                  snippet: fallbackSnippet,
                };
                try {
                  window.dispatchEvent(
                    new CustomEvent("vg:rdf-parse-error", {
                      detail: (window as any).__VG_LAST_RDF_ERROR,
                    }),
                  );
                } catch (_) {
                  /* ignore dispatch failures */
                }
              }
            } catch (_) {
              /* ignore structured error attach failures */
            }

            throw new Error(
              `Proxy fetch failed (status: ${status}) for ${url}`,
            );
          }
        } catch (proxyErr) {
          try {
            fallback(
              "rdf.fetch.proxyFailed",
              { url, error: String(proxyErr) },
              { level: "warn", captureStack: true },
            );
          } catch (_) {
            try {
              if (typeof fallback === "function") {
                fallback("emptyCatch", { error: String(_) });
              }
            } catch (_) {
              /* ignore */
            }
          }
          // If we have an exception (network error), attach a concise message for UI consumption
          try {
            if (typeof window !== "undefined") {
              const prev = (window as any).__VG_LAST_RDF_ERROR || {};
              (window as any).__VG_LAST_RDF_ERROR = {
                message:
                  String(proxyErr) ||
                  prev.message ||
                  `Proxy fetch failed for ${url}`,
                url: String(url),
                snippet:
                  prev && prev.snippet
                    ? prev.snippet
                    : String(
                        (proxyErr && (proxyErr as any).message) ||
                          String(proxyErr),
                      ).slice(0, 1000),
              };
              try {
                window.dispatchEvent(
                  new CustomEvent("vg:rdf-parse-error", {
                    detail: (window as any).__VG_LAST_RDF_ERROR,
                  }),
                );
              } catch (_) {
                /* ignore */
              }
            }
          } catch (_) {
            /* ignore */
          }
          throw proxyErr;
        }
      }
    } catch (e) {
      try {
        if (typeof fallback === "function") {
          fallback("emptyCatch", { error: String(e) });
        }
      } catch (_) {
        /* ignore */
      }
    }

    try {
      // Ensure a structured error is available to the UI/runtime when both direct and proxy fetch attempts fail.
      // This helps distinguish network/load errors from parser errors in the UI and developer tooling.
      if (typeof window !== "undefined") {
        try {
          (window as any).__VG_LAST_RDF_ERROR = {
            message: `Failed to fetch ${url} (direct fetch and proxy fallback both unsuccessful)`,
            url: String(url),
            snippet: "",
          };
        } catch (_) {
          try {
            if (typeof fallback === "function") {
              fallback("emptyCatch", { error: String(_) });
            }
          } catch (__) {
            /* ignore fallback errors */
          }
        }
        try {
          window.dispatchEvent(
            new CustomEvent("vg:rdf-parse-error", {
              detail: (window as any).__VG_LAST_RDF_ERROR,
            }),
          );
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
    } catch (_) {
      try {
        if (typeof fallback === "function") {
          fallback("emptyCatch", { error: String(_) });
        }
      } catch (__) {
        /* ignore fallback errors */
      }
    }
    throw new Error(
      `Failed to fetch ${url} (direct fetch and proxy fallback both unsuccessful)`,
    );
  }

  /**
   * Export the current store to Turtle format
   */
  exportToTurtle(): Promise<string> {
    return new Promise((resolve, reject) => {
      const writer = new Writer({
        prefixes: this.namespaces,
        format: "text/turtle",
      });

      const quads = this.store.getQuads(null, null, null, null);
      writer.addQuads(quads);

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

      const quads = this.store.getQuads(null, null, null, null);
      writer.addQuads(quads);

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
   * Export the current store to RDF/XML format
   */
  exportToRdfXml(): Promise<string> {
    return new Promise((resolve, reject) => {
      const writer = new Writer({
        prefixes: this.namespaces,
        format: "application/rdf+xml",
      });

      const quads = this.store.getQuads(null, null, null, null);
      writer.addQuads(quads);

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
   * Get all namespaces/prefixes
   */
  getNamespaces(): Record<string, string> {
    return this.namespaces;
  }

  /**
   * Add a new namespace
   *
   * When a new prefix is registered at runtime we asynchronously show a UI toast
   * so users get immediate feedback that a namespace/prefix was added. Use a
   * dynamic import so this utility code does not create a hard dependency cycle
   * with UI modules at load time.
   */
  addNamespace(prefix: string, uri: string): void {
    try {
      // Determine whether the mapping is newly added or actually changed.
      const prev = Object.prototype.hasOwnProperty.call(this.namespaces, prefix)
        ? this.namespaces[prefix]
        : undefined;
      const changed = prev === undefined || String(prev) !== String(uri);

      // Always set/overwrite the mapping so callers can update URIs for a prefix.
      this.namespaces[prefix] = uri;

      if (changed) {
        // Dynamic import so we don't create a hard runtime dependency on the UI layer.
        // Fire-and-forget the toast; failures to import or show the toast should not
        // break RDF processing.
        try {
          import("../components/ui/use-toast")
            .then((mod) => {
              try {
                if (mod && typeof mod.toast === "function") {
                  mod.toast({
                    title: `Prefix added: ${prefix}`,
                    description: String(uri),
                    // keep the toast short-lived but visible
                    duration: 4000,
                  } as any);
                }
              } catch (_) {
                /* ignore toast failures */
              }
            })
            .catch(() => {
              /* ignore dynamic import errors */
            });
        } catch (_) {
          try {
            if (typeof fallback === "function") {
              fallback("emptyCatch", { error: String(_) });
            }
          } catch (__) {
            /* ignore fallback errors */
          }
        }

        // Notify subscribers that namespaces changed so UI can rebuild palette / displays
        try {
          this.notifyChange({ kind: "namespaces", prefixes: [prefix] });
        } catch (_) {
          /* ignore notification failures */
        }
      }
    } catch (e) {
      try {
        if (typeof fallback === "function") {
          fallback("rdf.addNamespace.failed", {
            prefix,
            namespace: uri,
            error: String(e),
          });
        }
      } catch (_) {
        /* ignore */
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
        this.notifyChange({ kind: "namespaces", prefixes: prefixToRemove ? [prefixToRemove] : [] });
      } catch (_) {
        /* ignore */
      }
    } catch (err) {
      // best-effort: log and continue
      try {
        ((...__vg_args) => {
          try {
            fallback(
              "console.warn",
              {
                args: __vg_args.map((a) =>
                  a && a.message ? a.message : String(a),
                ),
              },
              { level: "warn" },
            );
          } catch (_) {
            try {
              if (typeof fallback === "function") {
                fallback("emptyCatch", { error: String(_) });
              }
            } catch (_) {
              /* ignore */
            }
          }
          console.warn(...__vg_args);
        })("removeNamespaceAndQuads failed:", err);
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
        ((...__vg_args) => {
          try {
            fallback(
              "console.warn",
              {
                args: __vg_args.map((a) =>
                  a && a.message ? a.message : String(a),
                ),
              },
              { level: "warn" },
            );
          } catch (_) {
            try {
              if (typeof fallback === "function") {
                fallback("emptyCatch", { error: String(_) });
              }
            } catch (_) {
              /* ignore */
            }
          }
          console.warn(...__vg_args);
        })("removeGraph failed:", err);
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
    try {
      const wk = (WELL_KNOWN && (WELL_KNOWN as any).prefixes) || {};
      Object.entries(wk).forEach(([k, v]) => {
        try {
          if (!wellKnownFallbacks[k] && typeof v === "string") wellKnownFallbacks[k] = v;
        } catch (_) {}
      });
    } catch (_) {}

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
        try { this.bufferSubjectFromQuad(quad(s as any, p as any, o as any, g)); } catch (_) {}
      }
    } catch (e) {
      try { fallback("rdf.addTriple.failed", { subject, predicate, object, error: String(e) }); } catch (_) {}
    }
  }

  /**
   * removeTriple - idempotently remove matching triple(s) from the specified graph
   * Matches exact subject/predicate/object shapes (object must match value & literal form).
   */
  public removeTriple(subject: string, predicate: string, object: string, graphName: string = "urn:vg:data"): void {
    try {
      const g = namedNode(String(graphName));
      const s = namedNode(String(subject));
      const p = namedNode(String(predicate));
      // match literal or named node based on object shape
      const objs: any[] = [];
      try {
        if (object === null || typeof object === "undefined" || String(object) === "") {
          // remove any object for the predicate
          const found = this.store.getQuads(s, p, null, g) || [];
          for (const q of found) {
            try { this.bufferSubjectFromQuad(q); } catch (_) {}
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
        try {
          const found = this.store.getQuads(s, p, o as any, g) || [];
          for (const q of found) {
            try { this.bufferSubjectFromQuad(q); } catch (_) {}
            this.store.removeQuad(q);
          }
        } catch (_) { /* ignore per-object */ }
      }
    } catch (e) {
      try { fallback("rdf.removeTriple.failed", { subject, predicate, object, error: String(e) }); } catch (_) {}
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
                try { this.bufferSubjectFromQuad(q); } catch (_) {}
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
                try { this.bufferSubjectFromQuad(q); } catch (_) {}
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
            try { this.bufferSubjectFromQuad(quad(subj as any, pred as any, obj as any, g)); } catch (_) {}
          }
        } catch (_) { /* ignore per-add */ }
      }

      // Notify once after batch applied
      try { this.notifyChange(); } catch (_) {}
    } catch (e) {
      try { fallback("rdf.applyBatch.failed", { error: String(e) }, { level: "warn" }); } catch (_) {}
      try { this.notifyChange(); } catch (_) {}
    }
  }

  /**
   * Clear the store
   */
  clear(): void {
    this.store = new Store();
    // Restore core RDF prefixes only.
    this.namespaces = {
      rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      rdfs: "http://www.w3.org/2000/01/rdf-schema#",
      owl: "http://www.w3.org/2002/07/owl#",
      xsd: "http://www.w3.org/2001/XMLSchema#",
    };
    // Notify subscribers that RDF cleared
    try {
      this.notifyChange();
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

  /**
   * Merge parsed namespaces into the manager's namespace map.
   */
  applyParsedNamespaces(
    namespaces: Record<string, string> | undefined | null,
  ): void {
    if (!namespaces || typeof namespaces !== "object") return;
    try {
      // Use addNamespace for each entry so we get consistent behavior and UI notification
      // for newly added prefixes (addNamespace will handle idempotency and toast notification).
      Object.entries(namespaces).forEach(([p, ns]) => {
        try {
          if (p && ns) {
            this.addNamespace(String(p), String(ns));
          }
        } catch (_) {
          /* ignore per-entry failures */
        }
      });
    } catch (e) {
      ((...__vg_args) => {
        try {
          fallback(
            "console.warn",
            {
              args: __vg_args.map((a) =>
                a && a.message ? a.message : String(a),
              ),
            },
            { level: "warn" },
          );
        } catch (_) {
          try {
            if (typeof fallback === "function") {
              fallback("emptyCatch", { error: String(_) });
            }
          } catch (_) {
            /* ignore */
          }
        }
        console.warn(...__vg_args);
      })("applyParsedNamespaces failed:", e);
    }
  }
}

export const rdfManager = new RDFManager();
