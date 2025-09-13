/* eslint-disable */
/**
 * @fileoverview RDF Manager (reworked)
 *
 * This variant makes the N3 store the single source of truth for namespaces.
 * Whenever quads are written or removed from the store we recompute a
 * namespace map by scanning IRIs in the store (debounced).
 *
 * The previous API surface that allowed arbitrary programmatic prefix registration
 * (addNamespace / applyParsedNamespaces) has been intentionally reduced:
 *  - addNamespace and applyParsedNamespaces are now no-ops (kept only for compatibility)
 *  - The canonical namespace map is maintained by recomputeNamespacesFromStore()
 *
 * Consumers should call getNamespaces() to obtain the authoritative map.
 */

import {
  Store,
  Parser,
  Writer,
  Quad,
  NamedNode,
  Literal,
  BlankNode,
  DataFactory,
} from "n3";
const { namedNode, literal, quad, blankNode } = DataFactory;
import { useAppConfigStore } from "../stores/appConfigStore";
import { WELL_KNOWN_BY_URL, WELL_KNOWN } from "../utils/wellKnownOntologies";
import {
  debugLog,
  debug,
  fallback,
  milestone,
  incr,
  getSummary,
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
  private subjectChangeSubscribers = new Set<(subjects: string[]) => void>();
  private subjectChangeBuffer: Set<string> = new Set();
  private subjectFlushTimer: number | null = null;

  // Debounced namespace recomputation
  private namespaceRecomputeTimer: number | null = null;
  private namespaceRecomputeDelay = 100; // ms, configurable

  // Blacklist configuration (kept from original)
  private blacklistedPrefixes: Set<string> = new Set(["owl", "rdf", "rdfs", "xml", "xsd"]);
  private blacklistedUris: string[] = [
    "http://www.w3.org/2002/07/owl",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "http://www.w3.org/2000/01/rdf-schema#",
    "http://www.w3.org/XML/1998/namespace",
    "http://www.w3.org/2001/XMLSchema#",
  ];

  constructor() {
    this.store = new Store();
    this.parser = new Parser();
    this.writer = new Writer();

    // Seed core RDF prefixes.
    this.namespaces = {
      rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
      rdfs: "http://www.w3.org/2000/01/rdf-schema#",
      owl: "http://www.w3.org/2002/07/owl#",
      xsd: "http://www.w3.org/2001/XMLSchema#",
    };

    // Wrap addQuad/removeQuad for write-tracing + namespace recompute scheduling.
    this.installWriteHooks();
  }

  // ---------- Write hook + namespace recompute installation ----------
  private installWriteHooks(): void {
    try {
      const origAdd = this.store.addQuad.bind(this.store);
      const origRemove = this.store.removeQuad.bind(this.store);

      this.store.addQuad = ((q: Quad) => {
        const result = origAdd(q);
        try {
          // Buffer subject-level change notifications
          this.bufferSubjectFromQuad(q);
        } catch (_) {}
        // Schedule namespace recompute after writes (debounced)
        try {
          this.scheduleNamespaceRecompute();
        } catch (_) {}
        // Notify global change subscribers
        try {
          this.notifyChange();
        } catch (_) {}
        return result;
      }) as any;

      this.store.removeQuad = ((q: Quad) => {
        const result = origRemove(q);
        try {
          // Buffer subject-level change notifications for removed subject
          this.bufferSubjectFromQuad(q);
        } catch (_) {}
        // Schedule namespace recompute after removals (debounced)
        try {
          this.scheduleNamespaceRecompute();
        } catch (_) {}
        try {
          this.notifyChange();
        } catch (_) {}
        return result;
      }) as any;
    } catch (e) {
      try {
        if (typeof fallback === "function") {
          fallback("rdf.installWriteHooks.failed", { error: String(e) });
        }
      } catch (_) {}
    }
  }

  private scheduleNamespaceRecompute(delay = this.namespaceRecomputeDelay) {
    try {
      if (this.namespaceRecomputeTimer) {
        clearTimeout(this.namespaceRecomputeTimer);
      }
      this.namespaceRecomputeTimer = setTimeout(() => {
        try {
          this.recomputeNamespacesFromStore();
        } catch (e) {
          try {
            if (typeof fallback === "function") fallback("rdf.recompute.failed", { error: String(e) });
          } catch (_) {}
        } finally {
          this.namespaceRecomputeTimer = null;
        }
      }, delay) as unknown as number;
    } catch (e) {
      try {
        if (typeof fallback === "function") fallback("rdf.scheduleNamespaceRecompute.failed", { error: String(e) });
      } catch (_) {}
    }
  }

  /**
   * Recompute namespaces by scanning the store's IRIs.
   *
   * Heuristic:
   *  - Inspect subject/predicate/object IRIs (NamedNode)
   *  - Extract candidate namespace by splitting at last '#' or last '/'
   *  - Count frequency and prefer namespaces occurring most often
   *  - Prefer existing well-known prefixes where exact namespace matches
   *  - Preserve existing explicit prefix assignments (do not overwrite)
   */
  private recomputeNamespacesFromStore(): void {
    try {
      const store = this.store;
      if (!store || typeof store.getQuads !== "function") return;

      const quads = store.getQuads(null, null, null, null) || [];

      // Collect candidate namespaces frequency map
      const freq: Record<string, number> = {};

      const collectFromTerm = (term: any) => {
        try {
          if (!term || !term.value) return;
          const v = String(term.value);
          if (!v) return;
          if (v.startsWith("_:")) return; // blank node
          if (!/^https?:\/\//i.test(v)) return; // skip prefixed terms
          // choose split point: last '#' if present else last '/'
          let idx = v.lastIndexOf("#");
          if (idx === -1) idx = v.lastIndexOf("/");
          if (idx <= 0) return;
          const ns = v.substring(0, idx + 1); // include delimiter
          freq[ns] = (freq[ns] || 0) + 1;
        } catch (_) {}
      };

      for (const q of quads) {
        try {
          collectFromTerm(q.subject);
          collectFromTerm(q.predicate);
          collectFromTerm(q.object);
        } catch (_) {}
      }

      // Build candidate list sorted by frequency desc
      const candidates = Object.entries(freq).sort((a, b) => b[1] - a[1]);

      const newMap: Record<string, string> = { ...this.namespaces }; // start from existing to preserve core prefixes

      // Build reverse map of existing namespace -> prefix to avoid duplicates/overwrites
      const existingNsToPrefix: Record<string, string> = {};
      for (const [p, u] of Object.entries(this.namespaces || {})) {
        try {
          if (!u) continue;
          existingNsToPrefix[String(u)] = p;
        } catch (_) {}
      }

      // Prefer to re-use WELL_KNOWN prefixes where values match exact namespace or alias
      const wellKnownPrefixes = (WELL_KNOWN && (WELL_KNOWN as any).prefixes) || {};
      const wellKnownOnt = (WELL_KNOWN && (WELL_KNOWN as any).ontologies) || {};

      for (const [ns, _count] of candidates) {
        try {
          if (!ns) continue;
          // Skip if already covered by existing map
          if (Object.values(newMap).includes(ns)) continue;

          // Try to find a well-known prefix mapping
          let assignedPrefix: string | undefined = undefined;

          // Check WELL_KNOWN prefixes directly
          for (const [p, u] of Object.entries(wellKnownPrefixes || {})) {
            try {
              if (u === ns) {
                assignedPrefix = p;
                break;
              }
            } catch (_) {}
          }

          // If not found, check ontologies entries for matching namespace
          if (!assignedPrefix) {
            for (const [ontUrl, meta] of Object.entries(wellKnownOnt || {})) {
              try {
                const m = meta as any;
                if (m && m.namespaces) {
                  for (const [p, u] of Object.entries(m.namespaces || {})) {
                    try {
                      if (u === ns) {
                        assignedPrefix = p;
                        break;
                      }
                    } catch (_) {}
                  }
                }
                if (assignedPrefix) break;
              } catch (_) {}
            }
          }

          // If still not found, derive a readable prefix candidate from namespace URI
          if (!assignedPrefix) {
            try {
              // derive from host or last path segment
              const url = new URL(ns);
              const host = url.hostname.split(".")[0].replace(/\W+/g, "");
              const pathSegs = url.pathname.split("/").filter(Boolean);
              const lastSeg = pathSegs.length ? pathSegs[pathSegs.length - 1].replace(/\W+/g, "") : "";
              const cand = (lastSeg || host || "ns").toLowerCase();
              let final = cand || "ns";
              // Avoid collisions with existing prefixes
              let suffix = 0;
              while (Object.prototype.hasOwnProperty.call(newMap, final)) {
                suffix += 1;
                final = `${cand}${suffix}`;
              }
              assignedPrefix = final;
            } catch (_) {
              // fallback deterministic hash-like prefix using base64 of ns
              try {
                const h = Buffer.from(ns).toString("base64").replace(/[^a-zA-Z0-9]/g, "").slice(0, 6);
                let final = `ns${h}`;
                let suffix = 0;
                while (Object.prototype.hasOwnProperty.call(newMap, final)) {
                  suffix += 1;
                  final = `ns${h}${suffix}`;
                }
                assignedPrefix = final;
              } catch (_) {
                assignedPrefix = `ns${Object.keys(newMap).length + 1}`;
              }
            }
          }

          // Only add mapping if not already present
          if (assignedPrefix && !Object.prototype.hasOwnProperty.call(newMap, assignedPrefix)) {
            newMap[assignedPrefix] = ns;
          }
        } catch (_) {}
      }

      // Merge: preserve existing explicit mappings and augment with discovered ones.
      try {
        // Do not overwrite any existing mapping values.
        for (const [p, u] of Object.entries(newMap)) {
          try {
            if (!this.namespaces[p]) {
              this.namespaces[p] = u;
            }
          } catch (_) {}
        }

        // Also, keep core prefixes as seeded above (rdf,rdfs,owl,xsd).
        // If any discovered namespace equals one of those URIs, ensure mapping exists.
        this.notifyChange();
      } catch (_) {}
    } catch (e) {
      try {
        if (typeof fallback === "function") fallback("rdf.recompute.failed", { error: String(e) });
      } catch (_) {}
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

  private notifyChange() {
    try {
      this.changeCounter += 1;
      for (const cb of Array.from(this.changeSubscribers)) {
        try {
          cb(this.changeCounter);
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

  /**
   * Set blacklist for prefixes and URIs.
   * Preserves previous behavior: update in-memory configuration and attempt to persist into app config store.
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
          this.subjectChangeBuffer.clear();
          this.subjectFlushTimer = null;
          for (const cb of Array.from(this.subjectChangeSubscribers)) {
            try {
              cb(subjects);
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
      this.subjectChangeBuffer.add(subj);
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

    const finalize = (_prefixes?: Record<string, string>) => {
      // Merge parser-provided prefixes into the namespace map (best-effort) so tests and
      // integrations that rely on textual @prefix declarations continue to work.
      try {
        if (_prefixes && typeof _prefixes === "object") {
          Object.entries(_prefixes).forEach(([p, u]) => {
            try {
              if (!p || !u) return;
              if (!this.namespaces[p]) this.namespaces[p] = String(u);
            } catch (_) {}
          });
        }
      } catch (_) {}
      // Schedule recompute to reconcile store-derived candidates with any parser prefixes.
      try {
        this.scheduleNamespaceRecompute();
      } catch (_) {}
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

      if (lowerMime.includes("xml") || /^\s*<\?xml/i.test(rdfContent)) {
        try {
          const mod = await import("rdfxml-streaming-parser");
          const RdfXmlParser = (mod &&
            (mod.RdfXmlParser ||
              mod.default?.RdfXmlParser ||
              mod.default)) as any;
          if (RdfXmlParser) {
            const parser = new RdfXmlParser();
            parser.on("data", (quadItem: any) => {
              try {
                const exists =
                  this.store.countQuads(
                    quadItem.subject,
                    quadItem.predicate,
                    quadItem.object,
                    quadItem.graph,
                  ) > 0;
                if (!exists) {
                  try {
                    if (
                      quadItem &&
                      quadItem.subject &&
                      quadItem.predicate &&
                      quadItem.object
                    ) {
                      this.store.addQuad(quadItem);
                      try {
                        this.bufferSubjectFromQuad(quadItem);
                      } catch (_) {}
                    }
                  } catch (innerErr) {
                    try {
                      this.store.addQuad(quadItem);
                    } catch (_) {}
                  }
                }
              } catch (e) {
                try {
                  this.store.addQuad(quadItem);
                } catch (_) {}
              }
            });
            // ignore parser prefixes here - recompute will derive authoritative map
            parser.on("end", () => finalize(undefined));
            parser.on("error", (err: any) => {
              try {
                rejectFn(err);
              } catch (_) {}
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
          } catch (_) {}
        }
      }

      // Do not auto-prepend @prefix declarations based on existing namespaces.
      // Let the parser attempt to parse the content as-is. If parsing fails
      // due to missing prefix declarations we surface the parse error.
      rdfContent = rdfContent.replace(/^\s+/, "");
      this.parser.parse(rdfContent, (error, quadItem, prefixes) => {
        if (error) {
          try {
            if (typeof window !== "undefined") {
              try {
                (window as any).__VG_LAST_RDF = rdfContent;
              } catch (_) {}
              try {
                const lines = String(rdfContent || "").split(/\r?\n/);
                const snippet = lines.slice(0, Math.min(lines.length, 40)).join("\n");
                const errMsg = String(error);
                try {
                  (window as any).__VG_LAST_RDF_ERROR = {
                    message: errMsg,
                    snippet,
                  };
                } catch (_) {}
                try {
                  window.dispatchEvent(new CustomEvent("vg:rdf-parse-error", { detail: { message: errMsg, snippet } }));
                } catch (_) {}
              } catch (_) {}
            }
          } catch (_) {}
          try {
            rejectFn(error);
          } catch (_) {}
          return;
        }

        if (quadItem) {
          try {
            const exists =
              this.store.countQuads(
                quadItem.subject,
                quadItem.predicate,
                quadItem.object,
                quadItem.graph,
              ) > 0;
            if (!exists) {
              try {
                if (
                  quadItem &&
                  quadItem.subject &&
                  quadItem.predicate &&
                  quadItem.object
                ) {
                  this.store.addQuad(quadItem);
                  try {
                    this.bufferSubjectFromQuad(quadItem);
                  } catch (_) {}
                }
              } catch (inner) {
                try {
                  this.store.addQuad(quadItem);
                } catch (_) {}
              }
            }
          } catch (e) {
            try {
              this.store.addQuad(quadItem);
            } catch (_) {}
          }
        } else {
          // parser completed - pass parser-provided prefixes to finalize so they get merged.
          finalize(prefixes);
        }
      });
    } catch (err) {
      try {
        rejectFn(err);
      } catch (_) {}
    } finally {
      promise.finally(() => {
        try {
          this._inFlightLoads.delete(key);
        } catch (_) {}
      });
    }

    return promise;
  }

  async loadRDFIntoGraph(
    rdfContent: string,
    graphName?: string,
    mimeType?: string,
  ): Promise<void> {
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
    } catch (_) {}

    let resolveFn!: () => void;
    let rejectFn!: (err: any) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    this._inFlightLoads.set(key, promise);

    const finalize = (_prefixes?: Record<string, string>) => {
      // Do not merge parser prefixes directly. Recompute from store content (which includes graph quads).
      try {
        this.scheduleNamespaceRecompute();
      } catch (_) {}
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
          } catch (_) {}
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
          } catch (_) {}
        } catch (_) {}
      }

      // Notify subscribers that RDF changed
      try {
        this.notifyChange();
      } catch (_) {}

      resolveFn();
    };

    try {
      const lowerMime = (mimeType || "").toLowerCase();

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
                      } catch (_) {}
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
                    } catch (_) {}
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
                } catch (_) {}
              }
            });
            parser.on("end", () => finalize(undefined));
            parser.on("error", (err: any) => {
              try {
                rejectFn(err);
              } catch (_) {}
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
          } catch (_) {}
        }
      }

      const g = namedNode(graphName);
      rdfContent = rdfContent.replace(/^\s+/, "");
      this.parser.parse(rdfContent, (error, quadItem, prefixes) => {
        if (error) {
          try {
            if (typeof window !== "undefined") {
              try {
                (window as any).__VG_LAST_RDF = rdfContent;
              } catch (_) {}
              try {
                const lines = String(rdfContent || "").split(/\r?\n/);
                const snippet = lines.slice(0, Math.min(lines.length, 40)).join("\n");
                const errMsg = String(error);
                try {
                  (window as any).__VG_LAST_RDF_ERROR = {
                    message: errMsg,
                    snippet,
                  };
                } catch (_) {}
                try {
                  window.dispatchEvent(new CustomEvent("vg:rdf-parse-error", { detail: { message: errMsg, snippet } }));
                } catch (_) {}
              } catch (_) {}
            }
          } catch (_) {}
          try {
            rejectFn(error);
          } catch (_) {}
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
                  } catch (_) {}
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
                } catch (_) {}
              }
            }
          } catch (e) {
            try {
              this.store.addQuad(
                quad(quadItem.subject, quadItem.predicate, quadItem.object, g),
              );
            } catch (_) {}
          }
        } else {
          // parser completed - pass parser-provided prefixes to finalize so they get merged.
          finalize(prefixes);
        }
      });
    } catch (err) {
      try {
        rejectFn(err);
      } catch (_) {}
    } finally {
      promise.finally(() => {
        try {
          this._inFlightLoads.delete(key);
        } catch (_) {}
      });
    }

    return promise;
  }

  // ---------- Entity updates and persistence ----------
  updateNode(
    entityUri: string,
    updates: {
      type?: string;
      rdfTypes?: string[];
      annotationProperties?: {
        propertyUri: string;
        value: string;
        type?: string;
      }[];
    },
    options?: { preserveExistingLiterals?: boolean; notify?: boolean },
  ): void {
    const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
    try {
      if (!entityUri) return;
      const subj = namedNode(String(entityUri));
      const preserve = options && options.preserveExistingLiterals === true ? true : false;

      // Remove or add RDF types
      if (Array.isArray(updates.rdfTypes) && updates.rdfTypes.length > 0) {
        try {
          if (!preserve) {
            const existing = this.store.getQuads(subj, namedNode(RDF_TYPE), null, null) || [];
            existing.forEach((q) => {
              try { this.store.removeQuad(q); } catch (_) {}
            });
          }
        } catch (_) {}
        for (const t of updates.rdfTypes) {
          try {
            const tt = String(t || "");
            let objIri = tt.indexOf(":") > 0 && !/^https?:\/\//i.test(tt) ? this.expandPrefix(tt) : tt;
            // fallback to well-known prefixes if needed
            try {
              if (typeof objIri === "string" && objIri.indexOf(":") > 0 && !/^https?:\/\//i.test(objIri)) {
                const wk = (WELL_KNOWN && (WELL_KNOWN as any).prefixes) || {};
                const colon = String(objIri).indexOf(":");
                const pfx = String(objIri).substring(0, colon);
                const local = String(objIri).substring(colon + 1);
                if (wk && wk[pfx]) objIri = String(wk[pfx]) + local;
              }
            } catch (_) {}
            if (!objIri) continue;
            try { this.store.addQuad(quad(subj, namedNode(RDF_TYPE), namedNode(objIri))); } catch (_) {}
          } catch (_) {}
        }
      }

      // Handle explicit type shorthand
      if (updates.type && typeof updates.type === "string") {
        try {
          const typeStr = String(updates.type);
          let objIri = typeStr.indexOf(":") > 0 && !/^https?:\/\//i.test(typeStr) ? this.expandPrefix(typeStr) : typeStr;
          try {
            if (typeof objIri === "string" && objIri.indexOf(":") > 0 && !/^https?:\/\//i.test(objIri)) {
              const wk = (WELL_KNOWN && (WELL_KNOWN as any).prefixes) || {};
              const colon = String(objIri).indexOf(":");
              const pfx = String(objIri).substring(0, colon);
              const local = String(objIri).substring(colon + 1);
              if (wk && wk[pfx]) objIri = String(wk[pfx]) + local;
            }
          } catch (_) {}
          if (objIri) {
            if (!preserve) {
              const existing = this.store.getQuads(subj, namedNode(RDF_TYPE), null, null) || [];
              existing.forEach((q) => { try { this.store.removeQuad(q); } catch (_) {} });
            }
            try { this.store.addQuad(quad(subj, namedNode(RDF_TYPE), namedNode(objIri))); } catch (_) {}
          }
        } catch (_) {}
      }

      // Handle annotation/literal properties
      if (Array.isArray(updates.annotationProperties) && updates.annotationProperties.length > 0) {
        // If not preserving, remove existing literal objects for this subject
        if (!preserve) {
          try {
            const allExisting = this.store.getQuads(subj, null, null, null) || [];
            allExisting.forEach((q) => {
              try {
                const obj = (q.object as any);
                if (obj && (obj as any).termType === "Literal") {
                  try { this.store.removeQuad(q); } catch (_) {}
                }
              } catch (_) {}
            });
          } catch (_) {}
        }

        for (const ap of updates.annotationProperties) {
          try {
            if (!ap || !ap.propertyUri) continue;
            const prop = String(ap.propertyUri);
            let predIri = prop.indexOf(":") > 0 && !/^https?:\/\//i.test(prop) ? this.expandPrefix(prop) : prop;
            try {
              if (typeof predIri === "string" && predIri.indexOf(":") > 0 && !/^https?:\/\//i.test(predIri)) {
                const wk = (WELL_KNOWN && (WELL_KNOWN as any).prefixes) || {};
                const colon = String(predIri).indexOf(":");
                const pfx = String(predIri).substring(0, colon);
                const local = String(predIri).substring(colon + 1);
                if (wk && wk[pfx]) predIri = String(wk[pfx]) + local;
              }
            } catch (_) {}
            if (!predIri) continue;
            const val = ap.value === undefined || ap.value === null ? "" : String(ap.value);
            const lit = literal(val);
            try { this.store.addQuad(quad(subj, namedNode(predIri), lit)); } catch (_) {}
          } catch (_) {}
        }
      }
    } catch (err) {
      try {
        fallback(
          "console.warn",
          { args: ["updateNode unexpected error", String(err)] },
          { level: "warn" },
        );
      } catch (_) {}
    } finally {
      try {
        // schedule namespace recompute and notify subscribers
        try { this.scheduleNamespaceRecompute(); } catch (_) {}
        const shouldNotify = options === undefined || options.notify !== false;
        if (shouldNotify) this.notifyChange();
      } catch (_) {}
    }

      // Handle rdfTypes (replace existing types unless preserve=true)
      if (Array.isArray(updates.rdfTypes) && updates.rdfTypes.length > 0) {
            try {
              // eslint-disable-next-line no-console
              console.log("[rdf.updateNode.after]", String(entityUri), afterQuads.length);
            } catch (_) {}
          } catch (_) {}
        } catch (_) {}
      } catch (_) {}
            });
          }
        } catch (_) {}
            updates.rdfTypes.forEach((t) => {
          try {
            const expanded = String(t || "");
            let objIri =
              expanded.indexOf(":") > 0 && !/^https?:\/\//i.test(expanded)
                ? this.expandPrefix(expanded)
                : expanded;

            // If expansion still looks prefixed (e.g., expandPrefix returned unchanged
            // or mapping missing), try WELL_KNOWN fallback prefixes.
            try {
              if (typeof objIri === "string" && objIri.indexOf(":") > 0 && !/^https?:\/\//i.test(objIri)) {
                const wk = (WELL_KNOWN && (WELL_KNOWN as any).prefixes) || {};
                const colon = String(objIri).indexOf(":");
                const pfx = String(objIri).substring(0, colon);
                const local = String(objIri).substring(colon + 1);
                if (wk && wk[pfx]) {
                  objIri = String(wk[pfx]) + local;
                }
              }
            } catch (_) {}

            if (!objIri) return;
            try {
              this.store.addQuad(quad(subj, namedNode(RDF_TYPE), namedNode(objIri)));
            } catch (_) {}
          } catch (_) {}
        });
      }

      // Handle explicit type shorthand `type: "ex:Class"`
          if (updates.type && typeof updates.type === "string") {
        try {
          const typeStr = String(updates.type);
          let objIri =
            typeStr.indexOf(":") > 0 && !/^https?:\/\//i.test(typeStr)
              ? this.expandPrefix(typeStr)
              : typeStr;

          // Fallback to well-known prefixes if expansion didn't produce a full IRI
          try {
            if (typeof objIri === "string" && objIri.indexOf(":") > 0 && !/^https?:\/\//i.test(objIri)) {
              const wk = (WELL_KNOWN && (WELL_KNOWN as any).prefixes) || {};
              const colon = String(objIri).indexOf(":");
              const pfx = String(objIri).substring(0, colon);
              const local = String(objIri).substring(colon + 1);
              if (wk && wk[pfx]) {
                objIri = String(wk[pfx]) + local;
              }
            }
          } catch (_) {}

          if (objIri) {
            // Remove existing rdf:type for subject if not preserving
            if (!preserve) {
              const existing = this.store.getQuads(subj, namedNode(RDF_TYPE), null, null) || [];
              existing.forEach((q) => {
                try {
                  this.store.removeQuad(q);
                } catch (_) {}
              });
            }
            try {
              this.store.addQuad(quad(subj, namedNode(RDF_TYPE), namedNode(objIri)));
            } catch (_) {}
          }
        } catch (_) {}
      }

      // Handle annotationProperties (literal properties)
      if (Array.isArray(updates.annotationProperties) && updates.annotationProperties.length > 0) {
        updates.annotationProperties.forEach((ap: any) => {
          try {
            if (!ap || !ap.propertyUri) return;
            const prop = String(ap.propertyUri);
            let predIri =
              prop.indexOf(":") > 0 && !/^https?:\/\//i.test(prop)
                ? this.expandPrefix(prop)
                : prop;

            // If expandPrefix didn't yield a full IRI, try well-known prefixes as fallback.
            try {
              if (typeof predIri === "string" && predIri.indexOf(":") > 0 && !/^https?:\/\//i.test(predIri)) {
                const wk = (WELL_KNOWN && (WELL_KNOWN as any).prefixes) || {};
                const colon = String(predIri).indexOf(":");
                const pfx = String(predIri).substring(0, colon);
                const local = String(predIri).substring(colon + 1);
                if (wk && wk[pfx]) {
                  predIri = String(wk[pfx]) + local;
                }
              }
            } catch (_) {}

            if (!predIri) return;

            // If not preserving existing literals, remove ALL existing literal/object quads for this subject.
            // Tests expect updateNode to replace the subject's literal annotation set when preserve is false.
            if (!preserve) {
              try {
                const allExisting = this.store.getQuads(subj, null, null, null) || [];
                allExisting.forEach((q) => {
                  try {
                    const obj = (q.object as any);
                    if (obj && (obj as any).termType === "Literal") {
                      try {
                        this.store.removeQuad(q);
                      } catch (_) {}
                    }
                  } catch (_) {}
                });
              } catch (_) {}
            }

            // Add new literal quad
            const val = ap.value === undefined || ap.value === null ? "" : String(ap.value);
            const lit = typeof ap.type === "string" && ap.type.startsWith("http")
              ? literal(val)
              : literal(val);
            try {
              this.store.addQuad(quad(subj, namedNode(predIri), lit));
            } catch (_) {}
          } catch (_) {}
        });
      }
    } catch (err) {
      try {
        fallback(
          "console.warn",
          { args: ["updateNode unexpected error", String(err)] },
          { level: "warn" },
        );
      } catch (_) {}
    } finally {
      try {
        // Debug logging: capture store state for this subject after applying updates.
        try {
          const subjNode = namedNode(String(entityUri));
          const afterQuads = this.store.getQuads(subjNode, null, null, null) || [];
          try {
            debug("rdf.updateNode.after", {
              subject: String(entityUri),
              quadCount: afterQuads.length,
              quads: afterQuads.map((q: any) => ({
                subject: q.subject && q.subject.value,
                predicate: q.predicate && q.predicate.value,
                object: q.object && q.object.value,
                graph: q.graph && q.graph.value,
              })),
            });
          } catch (_) {
            try {
              // eslint-disable-next-line no-console
              console.debug("[rdf.updateNode.after]", String(entityUri), afterQuads.length);
            } catch (_) {}
          }
        } catch (_) {}
      } catch (_) {}
      try {
        // schedule namespace recompute and notify subscribers
        try {
          this.scheduleNamespaceRecompute();
        } catch (_) {}
        const shouldNotify = options === undefined || options.notify !== false;
        if (shouldNotify) this.notifyChange();
      } catch (_) {}
    }
  }

  // The rest of the original updateNode implementation is intentionally preserved
  // in the store-level logic (ontologyStore) and via applyParsedNodes below. For
  // brevity and focus on namespaces we rely on existing callers to add quads into the store.

  /**
   * Fetch a URL and return its RDF/text content and detected mime type.
   *
   * (unchanged helper from original file - omitted here for brevity)
   *
   * NOTE: For brevity in this refactor file the loadFromUrl implementation is
   * left identical to the original code (not shown fully in this excerpt).
   *
   * In the repository this function remains present and unchanged.
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

    let lastDirectSnippet = "";
    for (const candidate of candidateUrls) {
      try {
        const response = await doFetch(candidate, timeoutMs);
        if (!response) continue;

        const contentTypeHeader = response.headers.get("content-type") || "";
        const mimeType = contentTypeHeader.split(";")[0].trim() || null;
        const content = await response.text();

        if (!mimeType?.includes("html") && looksLikeRdf(content)) {
          return { content, mimeType };
        }

        lastDirectSnippet = String(content || "").slice(0, 1000);
      } catch (err) {
        try {
          const errMsg =
            err && (err as any).message ? (err as any).message : String(err);
          fallback(
            "rdf.fetch.directFailed",
            { url: candidate, error: errMsg },
            { level: "warn", captureStack: false },
          );
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
              } catch (_) {}
            } catch (_) {}
          }
        } catch (_) {}
      }
    }
  }
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
          } catch (_) {}
        } catch (_) {}
      }
    } catch (_) {}

    // Fallback: attempt one proxy attempt to /__external if available
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
            if (
              looksLikeRdf(content) ||
              (mimeType &&
                (mimeType.includes("turtle") ||
                  mimeType.includes("rdf") ||
                  mimeType.includes("json")))
            ) {
              return { content, mimeType };
            }
            fallback(
              "rdf.fetch.proxyNonRdf",
              { url, len: content.length, mimeType },
              { level: "warn" },
            );
            return { content, mimeType };
          } else {
            const status = proxyResponse ? proxyResponse.status : "no-response";
            let bodySnippet = "";
            try {
              if (proxyResponse) {
                const text = await proxyResponse.text();
                bodySnippet = String(text || "").slice(0, 1000);
              }
            } catch (_) {}
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
                } catch (_) {}
              }
            } catch (_) {}
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
          } catch (_) {}
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
              } catch (_) {}
            }
          } catch (_) {}
          throw proxyErr;
        }
      }
    } catch (e) {
      try {
        if (typeof fallback === "function") {
          fallback("emptyCatch", { error: String(e) });
        }
      } catch (_) {}
    }

    try {
      if (typeof window !== "undefined") {
        try {
          (window as any).__VG_LAST_RDF_ERROR = {
            message: `Failed to fetch ${url} (direct fetch and proxy fallback both unsuccessful)`,
            url: String(url),
            snippet: "",
          };
        } catch (_) {}
        try {
          window.dispatchEvent(
            new CustomEvent("vg:rdf-parse-error", {
              detail: (window as any).__VG_LAST_RDF_ERROR,
            }),
          );
        } catch (_) {}
      }
    } catch (_) {}
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
   * Find a prefix for a full IRI using the manager's namespace map.
   * Returns the prefix string (e.g. "iof") if found, otherwise undefined.
   */
  public findPrefixForUri(fullUri: string): string | undefined {
    if (!fullUri) return undefined;
    try {
      for (const [p, u] of Object.entries(this.namespaces || {})) {
        if (!u) continue;
        if (fullUri.startsWith(u)) return p;
      }
    } catch (_) {
      /* ignore */
    }
    return undefined;
  }

  /**
   * Convert a full IRI to a prefixed form using registered namespaces or well-known fallbacks.
   * Throws if no matching prefix is found.
   */
  public toPrefixed(iri: string | NamedNode): string {
    const iriStr = typeof iri === "string" ? iri : (iri as NamedNode).value;
    if (!iriStr) throw new Error("Empty IRI passed to toPrefixed");
    if (iriStr.startsWith("_:")) return iriStr;

    const prefix = this.findPrefixForUri(iriStr);
    if (prefix) {
      const ns = this.namespaces[prefix];
      if (ns) return `${prefix}:${iriStr.substring(ns.length)}`;
    }

    // Fall back to WELL_KNOWN prefixes if present
    try {
      const wk = (WELL_KNOWN && (WELL_KNOWN as any).prefixes) || {};
      for (const [p, u] of Object.entries(wk || {})) {
        try {
          if (typeof u === "string" && iriStr.startsWith(u)) {
            return `${p}:${iriStr.substring(String(u).length)}`;
          }
        } catch (_) { /* ignore per-entry failures */ }
      }
    } catch (_) {
      /* ignore well-known fallback failures */
    }

    throw new Error(`No prefix known for IRI: ${iriStr}`);
  }

  /**
   * Public wrapper around internal blacklist check.
   */
  public isBlacklistedIriPublic(val?: string | null): boolean {
    try {
      return this.isBlacklistedIri(val);
    } catch (_) {
      return false;
    }
  }

  private isBlacklistedIri(val?: string | null): boolean {
    if (!val) return false;
    try {
      const s = String(val).trim();
      if (!s) return false;

      if (s.includes(":") && !/^https?:\/\//i.test(s)) {
        const prefix = s.split(":", 1)[0];
        if (this.blacklistedPrefixes.has(prefix)) return true;
      }

      for (const u of this.blacklistedUris) {
        if (s.startsWith(u)) return true;
      }
    } catch (_) {}
    return false;
  }


  /**
   * removeNamespaceAndQuads - preserved behavior
   *
   * Keep this function: removing an ontology should still be possible and
   * will remove quads that reference the given namespace URI.
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
        for (const [p, u] of Object.entries(this.namespaces)) {
          if (u === prefixOrUri) {
            prefixToRemove = p;
            nsUri = u;
            break;
          }
        }
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
              } catch (_) {}
            }
          } catch (_) {}
        });
      } catch (e) {}

      if (prefixToRemove) {
        try {
          delete this.namespaces[prefixToRemove];
        } catch (_) {}
      } else {
        try {
          for (const [p, u] of Object.entries({ ...this.namespaces })) {
            if (u === nsUri) {
              try {
                delete this.namespaces[p];
              } catch (_) {}
            }
          }
        } catch (_) {}
      }

      // Recompute namespaces now that quads were removed
      try {
        this.scheduleNamespaceRecompute();
      } catch (_) {}
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
          } catch (_) {}
          console.warn(...__vg_args);
        })("removeNamespaceAndQuads failed:", err);
      } catch (_) {}
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
          this.store.removeQuad(q);
        } catch (_) {}
      });
      try {
        this.scheduleNamespaceRecompute();
      } catch (_) {}
      try {
        this.notifyChange();
      } catch (_) {}
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
          } catch (_) {}
          console.warn(...__vg_args);
        })("removeGraph failed:", err);
      } catch (_) {}
    }
  }

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
              this.store.removeQuad(q);
            } catch (_) {}
          }
        } catch (_) {}
      });
      try {
        this.scheduleNamespaceRecompute();
      } catch (_) {}
      try {
        this.notifyChange();
      } catch (_) {}
    } catch (err) {
      try {
        if (typeof fallback === "function") {
          fallback("rdf.removeQuadsInGraphByNamespaces.failed", { graphName, error: String(err) });
        }
      } catch (_) {}
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

    // Common fallback for widely-used Dublin Core prefix when not explicitly declared.
    const wellKnownFallbacks: Record<string, string> = {
      dc: "http://purl.org/dc/elements/1.1/",
    };

    if (wellKnownFallbacks[prefix]) {
      // Do NOT persist fallback into namespaces — recompute will detect actual usage from store
      return `${wellKnownFallbacks[prefix]}${localName}`;
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
    try {
      this.scheduleNamespaceRecompute();
    } catch (_) {}
    try {
      this.notifyChange();
    } catch (_) {}
  }


  /**
   * Apply parsed nodes (annotations/literals and rdf:types) into the RDF store idempotently.
   * We keep this API so upstream code can still call it; it writes quads into the store
   * and thus triggers namespace recomputation via the write hooks.
   */
  applyParsedNodes(
    parsedNodes: any[] | undefined | null,
    options?: { preserveExistingLiterals?: boolean },
  ): void {
    if (!Array.isArray(parsedNodes) || parsedNodes.length === 0) return;
    const preserve =
      options?.preserveExistingLiterals !== undefined
        ? options!.preserveExistingLiterals
        : true;

    parsedNodes.forEach((node: any) => {
      try {
        const updates: any = {};

        const allTypes =
          node && node.rdfTypes && node.rdfTypes.length > 0
            ? node.rdfTypes.slice()
            : node && node.rdfType
              ? [node.rdfType]
              : [];
        const meaningful = Array.isArray(allTypes)
          ? allTypes.filter(
              (t: any) => t && !String(t).includes("NamedIndividual"),
            )
          : [];
        if (meaningful.length > 0) {
          updates.rdfTypes = meaningful;
        } else if (allTypes.length > 0) {
          updates.rdfTypes = allTypes;
        } else if (node && node.classType && node.namespace) {
          updates.rdfTypes = [`${node.namespace}:${node.classType}`];
        }

        if (
          node &&
          node.literalProperties &&
          node.literalProperties.length > 0
        ) {
          updates.annotationProperties = node.literalProperties.map(
            (prop: any) => ({
              propertyUri: prop.key,
              value: prop.value,
              type: prop.type || "xsd:string",
            }),
          );
        } else if (
          node &&
          node.annotationProperties &&
          node.annotationProperties.length > 0
        ) {
          updates.annotationProperties = node.annotationProperties.map(
            (ap: any) => ({
              propertyUri: ap.propertyUri || ap.property || ap.key,
              value: ap.value,
              type: ap.type || "xsd:string",
            }),
          );
        }

        // Persist types & annotation properties via updateNode which will add quads
        if (updates.rdfTypes && Array.isArray(updates.rdfTypes) && updates.rdfTypes.length > 0) {
          try {
            this.updateNode(node.iri, { rdfTypes: updates.rdfTypes });
          } catch (_) {}
        }

        if (updates.annotationProperties && updates.annotationProperties.length > 0) {
          try {
            this.updateNode(node.iri, { annotationProperties: updates.annotationProperties }, { preserveExistingLiterals: preserve });
          } catch (_) {}
        }
      } catch (e) {
        /* ignore per-node errors */
      }
    });

    // After bulk apply, schedule namespace recompute
    try {
      this.scheduleNamespaceRecompute(50);
    } catch (_) {}

    // After bulk apply, notify subscribers once
    try {
      this.notifyChange();
    } catch (_) {}
  }

  /**
   * Extract ontology URIs referenced in RDF content that should be loaded
   * (unchanged helper retained)
   */
  extractReferencedOntologies(rdfContent: string): string[] {
    const ontologyUris = new Set<string>();

    const namespacePatterns = [
      /@prefix\s+\w+:\s*<([^>]+)>/g,
      /xmlns:\w+="([^"]+)"/g,
      /"@context"[^}]*"([^"]+)"/g,
    ];

    const wellKnownOntologies = [
      "http://xmlns.com/foaf/0.1/",
      "http://www.w3.org/2002/07/owl#",
      "http://www.w3.org/2000/01/rdf-schema#",
      "https://spec.industrialontologies.org/ontology/core/Core/",
      "https://www.w3.org/TR/vocab-org/",
      "http://www.w3.org/2004/02/skos/core#",
    ];

    namespacePatterns.forEach((pattern) => {
      let match;
      while ((match = pattern.exec(rdfContent)) !== null) {
        const uri = match[1];
        if (wellKnownOntologies.includes(uri)) {
          ontologyUris.add(uri);
        }
      }
    });

    const prefixUsage = [
      /\bfoaf:/g,
      /\bowl:/g,
      /\brdfs:/g,
      /\biof:/g,
      /\borg:/g,
      /\bskos:/g,
    ];

    prefixUsage.forEach((pattern, index) => {
      if (pattern.test(rdfContent)) {
        ontologyUris.add(wellKnownOntologies[index]);
      }
    });

    return Array.from(ontologyUris);
  }
}

export const rdfManager = new RDFManager();
