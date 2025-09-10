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

import { Store, Parser, Writer, Quad, NamedNode, Literal, BlankNode, DataFactory } from 'n3';
const { namedNode, literal, quad, blankNode } = DataFactory;
import { useAppConfigStore } from '../stores/appConfigStore';
import { debugLog, debug, fallback, milestone, incr, getSummary } from '../utils/startupDebug';

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
        if (typeof window === 'undefined') return;
        // Avoid double-wrapping
        if ((this.store as any).__vg_tracing_installed) return;
        (this.store as any).__vg_tracing_installed = true;

        const origAdd = this.store.addQuad.bind(this.store);
        const origRemove = this.store.removeQuad.bind(this.store);

        this.store.addQuad = ((q: Quad) => {
          try {
            // Log minimal quad info and stack to help identify caller
            // eslint-disable-next-line no-console
            console.debug('[VG_RDF_WRITE] addQuad', (q as any)?.subject?.value, (q as any)?.predicate?.value, (q as any)?.object?.value);
            // eslint-disable-next-line no-console
            console.debug(new Error('VG_RDF_WRITE_STACK').stack);
          } catch (_) { /* ignore logging failures */ }
          return origAdd(q);
        }) as any;

        this.store.removeQuad = ((q: Quad) => {
          try {
            // eslint-disable-next-line no-console
            console.debug('[VG_RDF_WRITE] removeQuad', (q as any)?.subject?.value, (q as any)?.predicate?.value, (q as any)?.object?.value);
            // eslint-disable-next-line no-console
            console.debug(new Error('VG_RDF_REMOVE_STACK').stack);
          } catch (_) { /* ignore logging failures */ }
          return origRemove(q);
        }) as any;
      } catch (err) {
        try { if (typeof fallback === "function") { fallback("vg.writeTrace.install_failed", { error: String(err) }); } } catch (_) { /* ignore */ }
      }
    };

    // Seed core RDF prefixes.
    this.namespaces = {
      rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
      rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
      owl: 'http://www.w3.org/2002/07/owl#',
      xsd: 'http://www.w3.org/2001/XMLSchema#'
    };

    // Enable tracing automatically in dev mode, or when the runtime flag is set.
    try {
      if (typeof window !== 'undefined') {
        // If running under Vite, import.meta.env.DEV will be truthy in development builds.
        // Fall back to checking a window flag if import.meta isn't available at runtime.
        const metaEnv = (typeof (import.meta as any) !== 'undefined' && (import.meta as any).env) ? (import.meta as any).env : {};
        // support explicit Vite-driven flag VITE_VG_LOG_RDF_WRITES=true
        const devMode = Boolean(metaEnv.DEV) || String(metaEnv.VITE_VG_LOG_RDF_WRITES) === 'true' || (window as any).__VG_LOG_RDF_WRITES === true;
        if (devMode) {
          (window as any).__VG_LOG_RDF_WRITES = true;
        }
        // install tracing if requested
        if ((window as any).__VG_LOG_RDF_WRITES === true) {
          enableWriteTracing();
        }
        // Expose a runtime helper so you can enable tracing from the console:
        // window.__VG_ENABLE_RDF_WRITE_LOGGING && window.__VG_ENABLE_RDF_WRITE_LOGGING()
        (window as any).__VG_ENABLE_RDF_WRITE_LOGGING = () => {
          try {
            (window as any).__VG_LOG_RDF_WRITES = true;
            enableWriteTracing();
            return true;
          } catch (err) {
            return false;
          }
        };
      }
    } catch (_) { /* ignore */ }
  }

  // ---------- Change notification API ----------
  public onChange(cb: (count: number) => void): void {
    if (typeof cb !== 'function') return;
    this.changeSubscribers.add(cb);
  }

  public offChange(cb: (count: number) => void): void {
    this.changeSubscribers.delete(cb);
  }

  private notifyChange() {
    try {
      this.changeCounter += 1;
      for (const cb of Array.from(this.changeSubscribers)) {
        try { cb(this.changeCounter); } catch (_) { /* ignore individual subscriber errors */ }
      }
    } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
  }

  // ---------- Loading / parsing / applying RDF ----------
  async loadRDF(rdfContent: string, mimeType?: string): Promise<void> {
    const rawKey = typeof rdfContent === 'string' ? rdfContent : String(rdfContent);
    const normalized = rawKey.replace(/\s+/g, ' ').trim();
    const key = normalized.length > 1000 ? `len:${normalized.length}` : normalized;

    if (this._inFlightLoads.has(key)) {
      return this._inFlightLoads.get(key)!;
    }

    const initialCount = this.store.getQuads(null, null, null, null).length;
    const _vg_loadId = `load-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const _vg_loadStartMs = Date.now();
    try {
      incr('rdfLoads', 1);
      debugLog('rdf.load.start', { id: _vg_loadId, key, contentLen: (rdfContent && rdfContent.length) || 0, mimeType });
    } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }

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
        const state = (useAppConfigStore as any)?.getState ? (useAppConfigStore as any).getState() : null;
        if (state && state.config && typeof state.config.debugRdfLogging === 'boolean') {
          shouldLog = Boolean(state.config.debugRdfLogging);
        }
      } catch (_) {
        shouldLog = true;
      }

      if (shouldLog) {
        try {
          const durationMs = Date.now() - (_vg_loadStartMs || Date.now());
          try { debug('rdf.load.summary', { id: _vg_loadId, key, added, newCount, durationMs }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
          try { incr('totalTriplesAdded', added); debugLog('rdf.load.end', { id: _vg_loadId, key, added, newCount, durationMs }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
        } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
      }

      // Notify subscribers that RDF changed
      try { this.notifyChange(); } catch (_) { /* ignore */ }

      resolveFn();
    };

    try {
      const lowerMime = (mimeType || '').toLowerCase();

      if (lowerMime.includes('xml') || /^\s*<\?xml/i.test(rdfContent)) {
        try {
          const mod = await import('rdfxml-streaming-parser');
          const RdfXmlParser = (mod && (mod.RdfXmlParser || mod.default?.RdfXmlParser || mod.default)) as any;
          if (RdfXmlParser) {
            const parser = new RdfXmlParser();
            const prefixesCollected: Record<string, string> = {};
            parser.on('data', (quadItem: any) => {
              try {
                const exists = this.store.countQuads(quadItem.subject, quadItem.predicate, quadItem.object, quadItem.graph) > 0;
                if (!exists) this.store.addQuad(quadItem);
              } catch (e) {
                try { this.store.addQuad(quadItem); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
              }
            });
            parser.on('prefix', (prefix: string, iri: string) => {
              try { prefixesCollected[prefix] = iri; } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
            });
            parser.on('end', () => finalize(prefixesCollected));
            parser.on('error', (err: any) => { try { rejectFn(err); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } } });

            parser.write(rdfContent);
            parser.end();
            return promise;
          }
        } catch (e) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(e) }); } } catch (_) { /* ignore */ } }
      }

      this.parser.parse(rdfContent, (error, quadItem, prefixes) => {
        if (error) {
          try { rejectFn(error); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
          return;
        }

        if (quadItem) {
          try {
            const exists = this.store.countQuads(quadItem.subject, quadItem.predicate, quadItem.object, quadItem.graph) > 0;
            if (!exists) {
              this.store.addQuad(quadItem);
            }
          } catch (e) {
            try { this.store.addQuad(quadItem); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
          }
        } else {
          finalize(prefixes);
        }
      });
    } catch (err) {
      try { rejectFn(err); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
    } finally {
      promise.finally(() => {
        try { this._inFlightLoads.delete(key); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
      });
    }

    return promise;
  }

  async loadRDFIntoGraph(rdfContent: string, graphName?: string, mimeType?: string): Promise<void> {
    if (!graphName) return this.loadRDF(rdfContent, mimeType);

    const rawKey = typeof rdfContent === 'string' ? rdfContent : String(rdfContent);
    const normalized = rawKey.replace(/\s+/g, ' ').trim();
    const key = normalized.length > 1000 ? `len:${normalized.length}` : normalized;

    if (this._inFlightLoads.has(key)) {
      return this._inFlightLoads.get(key)!;
    }

    const initialCount = this.store.getQuads(null, null, null, null).length;
    const _vg_loadId = `load-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const _vg_loadStartMs = Date.now();
    try {
      incr('rdfLoads', 1);
      debugLog('rdf.load.start', { id: _vg_loadId, key, graphName: graphName || null, contentLen: (rdfContent && rdfContent.length) || 0, mimeType });
    } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }

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
        const state = (useAppConfigStore as any)?.getState ? (useAppConfigStore as any).getState() : null;
        if (state && state.config && typeof state.config.debugRdfLogging === 'boolean') {
          shouldLog = Boolean(state.config.debugRdfLogging);
        }
      } catch (_) {
        shouldLog = true;
      }

      if (shouldLog) {
        try {
          const durationMs = Date.now() - (_vg_loadStartMs || Date.now());
          try { debug('rdf.load.summary', { id: _vg_loadId, key, graphName: graphName || null, added, newCount, durationMs }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
          try { incr('totalTriplesAdded', added); debugLog('rdf.load.end', { id: _vg_loadId, key, graphName: graphName || null, added, newCount, durationMs }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
        } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
      }

      // Notify subscribers that RDF changed
      try { this.notifyChange(); } catch (_) { /* ignore */ }

      resolveFn();
    };

    try {
      const lowerMime = (mimeType || '').toLowerCase();

      if (lowerMime.includes('xml') || /^\s*<\?xml/i.test(rdfContent)) {
        try {
          const mod = await import('rdfxml-streaming-parser');
          const RdfXmlParser = (mod && (mod.RdfXmlParser || mod.default?.RdfXmlParser || mod.default)) as any;
          if (RdfXmlParser) {
            const parser = new RdfXmlParser();
            const prefixesCollected: Record<string, string> = {};
            const g = namedNode(graphName);
            parser.on('data', (quadItem: any) => {
              try {
                const exists = this.store.countQuads(quadItem.subject, quadItem.predicate, quadItem.object, g) > 0;
                if (!exists) this.store.addQuad(quad(quadItem.subject, quadItem.predicate, quadItem.object, g));
              } catch (e) {
                try { this.store.addQuad(quad(quadItem.subject, quadItem.predicate, quadItem.object, g)); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
              }
            });
            parser.on('prefix', (prefix: string, iri: string) => {
              try { prefixesCollected[prefix] = iri; } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
            });
            parser.on('end', () => finalize(prefixesCollected));
            parser.on('error', (err: any) => { try { rejectFn(err); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } } });

            parser.write(rdfContent);
            parser.end();
            return promise;
          }
        } catch (e) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(e) }); } } catch (_) { /* ignore */ } }
      }

      const g = namedNode(graphName);
      this.parser.parse(rdfContent, (error, quadItem, prefixes) => {
        if (error) {
          try { rejectFn(error); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
          return;
        }

        if (quadItem) {
          try {
            const exists = this.store.countQuads(quadItem.subject, quadItem.predicate, quadItem.object, g) > 0;
            if (!exists) {
              this.store.addQuad(quad(quadItem.subject, quadItem.predicate, quadItem.object, g));
            }
          } catch (e) {
            try { this.store.addQuad(quad(quadItem.subject, quadItem.predicate, quadItem.object, g)); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
          }
        } else {
          finalize(prefixes);
        }
      });
    } catch (err) {
      try { rejectFn(err); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
    } finally {
      promise.finally(() => {
        try { this._inFlightLoads.delete(key); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
      });
    }

    return promise;
  }

  // ---------- Entity updates and persistence ----------
  updateNode(
    entityUri: string,
    updates: { type?: string; rdfTypes?: string[]; annotationProperties?: { propertyUri: string; value: string; type?: string }[] },
    options?: { preserveExistingLiterals?: boolean; notify?: boolean }
  ): void {
    // updateNode now supports two modes for literals:
    // - replacement mode (default): when options.preserveExistingLiterals !== true,
    //   remove existing literal annotation quads for this subject that are NOT present
    //   in the incoming update, then add the new literal quads.
    // - additive mode: when options.preserveExistingLiterals === true, only add missing
    //   literal quads and leave existing literals untouched.
    try {
      // Handle rdfTypes (array) - add missing types only (non-destructive)
      if (updates.rdfTypes && Array.isArray(updates.rdfTypes)) {
        const rdfTypePredicate = this.expandPrefix ? this.expandPrefix('rdf:type') : 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
        const existingTypeQuads = this.store.getQuads(namedNode(entityUri), namedNode(rdfTypePredicate), null, null) || [];
        const existingTypeSet = new Set(existingTypeQuads.map(q => (q.object as NamedNode).value));

        updates.rdfTypes.forEach((t: any) => {
          try {
            const typeStr = typeof t === 'string' ? String(t) : String(t);
            const expanded = this.expandPrefix ? this.expandPrefix(typeStr) : typeStr;
            if (!existingTypeSet.has(expanded)) {
              this.store.addQuad(quad(namedNode(entityUri), namedNode(rdfTypePredicate), namedNode(expanded)));
              existingTypeSet.add(expanded);
            }
          } catch (e) {
            try { fallback('console.warn', { args: [`Failed to add rdf:type quad for ${String(t)}`, String(e)] }, { level: 'warn' }); } catch (_) { /* ignore */ }
          }
        });
      } else if (updates.type) {
        // Single type - add if missing
        const typePredicate = this.expandPrefix ? this.expandPrefix('rdf:type') : 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
        const existingTypeQuads = this.store.getQuads(namedNode(entityUri), namedNode(typePredicate), null, null) || [];
        const existingTypeSet = new Set(existingTypeQuads.map(q => (q.object as NamedNode).value));
        try {
          const expandedType = this.expandPrefix ? this.expandPrefix(String(updates.type)) : String(updates.type);
          if (!existingTypeSet.has(expandedType)) {
            this.store.addQuad(quad(namedNode(entityUri), namedNode(typePredicate), namedNode(expandedType)));
          }
        } catch (e) {
          try { fallback('console.warn', { args: ['Failed to add rdf:type quad:', String(e)] }, { level: 'warn' }); } catch (_) { /* ignore */ }
        }
      }

      // Annotation properties handling: replacement or additive depending on options
      if (updates.annotationProperties && updates.annotationProperties.length > 0) {
        // Ensure well-known prefixes are present for any incoming properties (dc fallback)
        try {
          const ns = this.getNamespaces();
          updates.annotationProperties.forEach((p: any) => {
            if (p && typeof p.propertyUri === 'string') {
              const colon = p.propertyUri.indexOf(':');
              if (colon > 0) {
                const prefix = p.propertyUri.substring(0, colon);
                if (prefix === 'dc' && !ns['dc']) {
                  this.namespaces['dc'] = 'http://purl.org/dc/elements/1.1/';
                }
              }
            }
          });
        } catch (e) {
          /* ignore namespace prep failures */
        }

        // Build set of expanded predicates from update for comparison/removal
        const updatedPredicates = new Set<string>();
        updates.annotationProperties.forEach((p: any) => {
          try {
            const expanded = this.expandPrefix(p.propertyUri);
            updatedPredicates.add(expanded);
          } catch (_) { /* ignore */ }
        });

        // If caller did not request preserving existing literals, remove any existing
        // literal quads for this subject so updates behave in "replace" mode.
        // This ensures predicates included in the update replace prior values and
        // predicates not included are removed (matching previous expectations/tests).
        const preserve = options?.preserveExistingLiterals === true;
        if (!preserve) {
          try {
            const existingQuads = this.store.getQuads(namedNode(entityUri), null, null, null) || [];
            existingQuads.forEach((q: Quad) => {
              try {
                const obj = q.object as any;
                const isLiteral = obj && (obj.termType === 'Literal' || (typeof obj.value === 'string' && !obj.id));
                if (isLiteral) {
                  try { this.store.removeQuad(q); } catch (_) { /* ignore removal failures */ }
                }
              } catch (_) { /* ignore individual quad processing errors */ }
            });
          } catch (_) { /* ignore */ }
        }

        // Add/update incoming annotation properties idempotently
        updates.annotationProperties.forEach(prop => {
          try {
            const propertyFull = this.expandPrefix(prop.propertyUri);
            const literalValue = prop.type ? literal(prop.value, namedNode(this.expandPrefix(prop.type))) : literal(prop.value);

            // Only add if an identical triple does not already exist
            const exists = this.store.countQuads(namedNode(entityUri), namedNode(propertyFull), literalValue, null) > 0;
            if (!exists) {
              this.store.addQuad(quad(namedNode(entityUri), namedNode(propertyFull), literalValue));
            }
          } catch (e) {
            try { fallback('console.warn', { args: ['Failed to add annotation quad:', String(e)] }, { level: 'warn' }); } catch (_) { /* ignore */ }
          }
        });
      }
    } catch (err) {
      try { fallback('console.warn', { args: ['updateNode unexpected error', String(err)] }, { level: 'warn' }); } catch (_) { /* ignore */ }
    } finally {
      // Notify subscribers after an entity update (triples may have changed) unless caller requested suppression.
      try {
        const shouldNotify = options === undefined || options.notify !== false;
        if (shouldNotify) this.notifyChange();
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * Fetch a URL and return its RDF/text content and detected mime type.
   *
   * This helper centralizes network fetching so callers (e.g. ontologyStore)
   * can rely on a single implementation that respects timeouts and common
   * Accept headers used by RDF endpoints.
   */
  async loadFromUrl(url: string, options?: { timeoutMs?: number; onProgress?: (progress: number, message: string) => void }): Promise<{ content: string; mimeType: string | null }> {
    const timeoutMs = options?.timeoutMs ?? 15000;

    // Helper to perform a fetch with timeout and Accept headers
    const doFetch = async (target: string, timeout: number) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const res = await fetch(target, {
          signal: controller.signal,
          headers: {
            'Accept': 'text/turtle, application/rdf+xml, application/ld+json, */*'
          }
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
      if (t.startsWith('@prefix') || t.startsWith('PREFIX') || t.includes('http://www.w3.org/1999/02/22-rdf-syntax-ns#') || t.includes('@id') || t.includes('@context')) return true;
      if (t.startsWith('<') && t.includes('rdf:')) return true;
      if (t.startsWith('{') && t.includes('@context')) return true;
      if (t.includes('owl:') || t.includes('rdf:type') || t.includes('rdfs:label')) return true;
      return false;
    };

    // Try candidates (prefer https)
    const candidateUrls = url.startsWith('http://') ? [url.replace(/^http:\/\//, 'https://'), url] : [url];

    // Primary attempt: direct browser fetch
    for (const candidate of candidateUrls) {
      try {
        const response = await doFetch(candidate, timeoutMs);
        if (!response) continue;

        const contentTypeHeader = response.headers.get('content-type') || '';
        const mimeType = contentTypeHeader.split(';')[0].trim() || null;
        const content = await response.text();

        // Debug: record small or suspicious fetches to help diagnose why content is tiny
        if (content.length < 200) {
          try { debugLog('rdf.fetch.small', { url: candidate, len: content.length, mimeType }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
        }

        // If content looks like RDF, accept it. If it's HTML or clearly not RDF, skip to proxy fallback.
        const mimeIndicatesHtml = mimeType && mimeType.includes('html');
        if (!mimeIndicatesHtml && looksLikeRdf(content)) {
          return { content, mimeType };
        }

        // otherwise continue to next candidate or fall through to proxy
      } catch (err) {
        // typical CORS / network errors will be caught here; we'll try the proxy fallback next
        try {
          fallback('rdf.fetch.directFailed', { url: candidate, error: (err && (err as any).message) ? (err as any).message : String(err) }, { level: 'warn', captureStack: false });
        } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
      }
    }

    // Fallback: use dev server proxy at /__external (configured in vite.config.ts) to bypass CORS/redirect issues.
    try {
      if (typeof window !== 'undefined') {
        const proxyUrl = `/__external?url=${encodeURIComponent(url)}`;
        try {
          const proxyResponse = await doFetch(proxyUrl, timeoutMs * 2);
          if (proxyResponse && proxyResponse.ok) {
            const contentTypeHeader = proxyResponse.headers.get('content-type') || '';
            const mimeType = contentTypeHeader.split(';')[0].trim() || null;
            const content = await proxyResponse.text();

            // Debug log
            try { debugLog('rdf.fetch.proxyFetched', { url, len: content.length, mimeType }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }

            if (looksLikeRdf(content) || (mimeType && (mimeType.includes('turtle') || mimeType.includes('rdf') || mimeType.includes('json')))) {
              return { content, mimeType };
            }

            // proxy returned content that's not clearly RDF -> still return content so parser can attempt, but record a fallback
            try { fallback('rdf.fetch.proxyNonRdf', { url, len: content.length, mimeType }, { level: 'warn' }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
            return { content, mimeType };
          } else {
            const status = proxyResponse ? proxyResponse.status : 'no-response';
            throw new Error(`Proxy fetch failed (status: ${status}) for ${url}`);
          }
        } catch (proxyErr) {
          try { fallback('rdf.fetch.proxyFailed', { url, error: String(proxyErr) }, { level: 'warn', captureStack: true }); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
          throw proxyErr;
        }
      }
    } catch (e) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(e) }); } } catch (_) { /* ignore */ } }

    throw new Error(`Failed to fetch ${url} (direct fetch and proxy fallback both unsuccessful)`);
  }

  /**
   * Export the current store to Turtle format
   */
  exportToTurtle(): Promise<string> {
    return new Promise((resolve, reject) => {
      const writer = new Writer({
        prefixes: this.namespaces,
        format: 'text/turtle'
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
        format: 'application/ld+json'
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
        format: 'application/rdf+xml'
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
   */
  addNamespace(prefix: string, uri: string): void {
    this.namespaces[prefix] = uri;
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
        if (!nsUri && (prefixOrUri.startsWith('http://') || prefixOrUri.startsWith('https://'))) {
          nsUri = prefixOrUri;
        }
      }

      if (!nsUri) return;

      // Remove quads whose subject/predicate/object starts with nsUri
      try {
        const all = this.store.getQuads(null, null, null, null) || [];
        all.forEach((q: Quad) => {
          try {
            const subj = (q.subject && (q.subject as any).value) || '';
            const pred = (q.predicate && (q.predicate as any).value) || '';
            const obj = (q.object && (q.object as any).value) || '';
            if (subj.startsWith(nsUri) || pred.startsWith(nsUri) || obj.startsWith(nsUri)) {
              try { this.store.removeQuad(q); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
            }
          } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
        });
      } catch (e) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(e) }); } } catch (_) { /* ignore */ } }

      // Finally remove the prefix mapping if we found a prefix to remove
      if (prefixToRemove) {
        try { delete this.namespaces[prefixToRemove]; } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
      } else {
        // If no prefix matched but caller provided a URI, remove any prefixes that map to that URI
        try {
          for (const [p, u] of Object.entries({ ...this.namespaces })) {
            if (u === nsUri) {
              try { delete this.namespaces[p]; } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
            }
          }
        } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
      }
    } catch (err) {
      // best-effort: log and continue
      try { ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } } console.warn(...__vg_args);})('removeNamespaceAndQuads failed:', err); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
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
        try { this.store.removeQuad(q); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
      });
      // Notify subscribers that RDF changed (graph removal)
      try { this.notifyChange(); } catch (_) { /* ignore */ }
    } catch (err) {
      try { ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } } console.warn(...__vg_args);})('removeGraph failed:', err); } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } }
    }
  }

  /**
   * Expand a prefixed URI to full URI
   */
  expandPrefix(prefixedUri: string): string {
    const colonIndex = prefixedUri.indexOf(':');
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
      dc: 'http://purl.org/dc/elements/1.1/'
    };

    if (wellKnownFallbacks[prefix]) {
      // Add fallback to namespaces so exports include the prefix
      this.namespaces[prefix] = wellKnownFallbacks[prefix];
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
      rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
      rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
      owl: 'http://www.w3.org/2002/07/owl#',
      xsd: 'http://www.w3.org/2001/XMLSchema#'
    };
    // Notify subscribers that RDF cleared
    try { this.notifyChange(); } catch (_) { /* ignore */ }
  }

  /**
   * Merge parsed namespaces into the manager's namespace map.
   */
  applyParsedNamespaces(namespaces: Record<string, string> | undefined | null): void {
    if (!namespaces || typeof namespaces !== 'object') return;
    try {
      Object.entries(namespaces).forEach(([p, ns]) => {
        if (p && ns) {
          this.namespaces[p] = ns;
        }
      });
    } catch (e) {
      ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } } console.warn(...__vg_args);})('applyParsedNamespaces failed:', e);
    }
  }

  /**
   * Apply parsed nodes (annotations/literals and rdf:types) into the RDF store idempotently.
   */
  applyParsedNodes(parsedNodes: any[] | undefined | null, options?: { preserveExistingLiterals?: boolean }): void {
    if (!Array.isArray(parsedNodes) || parsedNodes.length === 0) return;
    const preserve = options?.preserveExistingLiterals !== undefined ? options!.preserveExistingLiterals : true;

    parsedNodes.forEach((node: any) => {
      try {
        const updates: any = {};

        // Collect rdf types in authoritative form
        const allTypes = (node && node.rdfTypes && node.rdfTypes.length > 0)
          ? (node.rdfTypes.slice())
          : ((node && node.rdfType) ? [node.rdfType] : []);
        const meaningful = Array.isArray(allTypes) ? allTypes.filter((t: any) => t && !String(t).includes('NamedIndividual')) : [];
        if (meaningful.length > 0) {
          updates.rdfTypes = meaningful;
        } else if (allTypes.length > 0) {
          updates.rdfTypes = allTypes;
        } else if (node && node.classType && node.namespace) {
          updates.rdfTypes = [`${node.namespace}:${node.classType}`];
        }

        // Collect annotation/literal properties
        if (node && node.literalProperties && node.literalProperties.length > 0) {
          updates.annotationProperties = node.literalProperties.map((prop: any) => ({
            propertyUri: prop.key,
            value: prop.value,
            type: prop.type || 'xsd:string'
          }));
        } else if (node && node.annotationProperties && node.annotationProperties.length > 0) {
          updates.annotationProperties = node.annotationProperties.map((ap: any) => ({
            propertyUri: ap.propertyUri || ap.property || ap.key,
            value: ap.value,
            type: ap.type || 'xsd:string'
          }));
        }

        // Ensure well-known prefixes (e.g., dc) are present if annotationProperties reference them
        if (updates.annotationProperties && updates.annotationProperties.length > 0) {
          updates.annotationProperties.forEach((p: any) => {
            const colon = (p.propertyUri || '').indexOf(':');
            if (colon > 0) {
              const prefix = p.propertyUri.substring(0, colon);
              if (prefix === 'dc' && !this.namespaces['dc']) {
                this.namespaces['dc'] = 'http://purl.org/dc/elements/1.1/';
              }
            }
          });
        }

        // Apply types first (non-destructive)
        if (updates.rdfTypes && Array.isArray(updates.rdfTypes) && updates.rdfTypes.length > 0) {
          try {
            this.updateNode(node.uri, { rdfTypes: updates.rdfTypes });
          } catch (e) {
            ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } } console.warn(...__vg_args);})('applyParsedNodes: failed to persist rdfTypes for', node && node.uri, e);
          }
        }

        // Apply annotation/literal properties idempotently
        if (updates.annotationProperties && updates.annotationProperties.length > 0) {
          try {
            this.updateNode(node.uri, { annotationProperties: updates.annotationProperties }, { preserveExistingLiterals: preserve });
          } catch (e) {
            ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } } console.warn(...__vg_args);})('applyParsedNodes: failed to persist annotationProperties for', node && node.uri, e);
          }
        }
      } catch (e) {
        ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* ignore */ } } console.warn(...__vg_args);})('applyParsedNodes: unexpected error for node', node && node.uri, e);
      }
    });

    // After bulk apply, notify subscribers once
    try { this.notifyChange(); } catch (_) { /* ignore */ }
  }

  /**
   * Extract ontology URIs referenced in RDF content that should be loaded
   * (kept here for convenience - also exists in ontologyStore but useful here).
   */
  extractReferencedOntologies(rdfContent: string): string[] {
    const ontologyUris = new Set<string>();

    const namespacePatterns = [
      /@prefix\s+\w+:\s*<([^>]+)>/g,
      /xmlns:\w+="([^"]+)"/g,
      /"@context"[^}]*"([^"]+)"/g
    ];

    const wellKnownOntologies = [
      'http://xmlns.com/foaf/0.1/',
      'http://www.w3.org/2002/07/owl#',
      'http://www.w3.org/2000/01/rdf-schema#',
      'https://spec.industrialontologies.org/ontology/core/Core/',
      'https://www.w3.org/TR/vocab-org/',
      'http://www.w3.org/2004/02/skos/core#'
    ];

    namespacePatterns.forEach(pattern => {
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
      /\bskos:/g
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
