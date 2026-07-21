import type {
  ReasoningError,
  ReasoningInference,
  ReasoningResult,
  ReasoningWarning,
  ShaclViolation,
} from "./reasoningTypes";
import { createRdfManagerWorkerClient, RdfManagerWorkerClient } from "./rdfManager.workerClient";
import type {
  ExportGraphPayload,
  ImportSerializedPayload,
  PurgeNamespacePayload,
  RemoveQuadsByNamespacePayload,
  RDFWorkerCommandPayloads,
  WorkerReconcileSubjectSnapshotPayload,
} from "./rdfManager.workerProtocol";
import type { WorkerQuad, WorkerQuadUpdate, WorkerTerm } from "./rdfSerialization";
import {
  isWorkerQuad,
  serializeTerm,
} from "./rdfSerialization";
import { useAppConfigStore } from "../stores/appConfigStore";
import { ensureDefaultNamespaceMap, type NamespaceEntry, entriesToRecord, recordToEntries } from "../constants/namespaces";
import { Parser as N3Parser } from "n3";
import { canonicalizeQuads, canonicalHash, type CanonicalHashAlgorithm } from "./rdfCanonicalize";

type ChangeSubscriber = (count: number, meta?: unknown) => void;
type SubjectsSubscriber = (
  subjects: string[],
  quads?: WorkerQuad[],
  snapshot?: WorkerReconcileSubjectSnapshotPayload[],
  meta?: Record<string, unknown> | null,
) => void;

const DEFAULT_GRAPH = "urn:vg:data";
const IRI_REGEX = /^[a-z][a-z0-9+.-]*:/i;

/**
 * BUG B: a verifyRepair removal. The optional object-term metadata + source
 * graph let VERIFY exclude the IDENTICAL triple APPLY removes (precise
 * typed/lang literal in the correct graph). Sourced from the worker protocol so
 * the two stay in lockstep.
 */
export type VerifyRepairRemoval = RDFWorkerCommandPayloads["verifyRepair"]["removals"][number];

const DEFAULT_BLACKLIST_PREFIXES = ["owl", "rdf", "rdfs", "xml", "xsd"];
const DEFAULT_BLACKLIST_URIS = [
  "http://www.w3.org/2002/07/owl",
  "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  "http://www.w3.org/2000/01/rdf-schema#",
  "http://www.w3.org/XML/1998/namespace",
  "http://www.w3.org/2001/XMLSchema#",
];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isStringRecord = (value: unknown): value is Record<string, string> => {
  if (!isPlainObject(value)) return false;
  for (const [key, val] of Object.entries(value)) {
    if (typeof key !== "string") return false;
    if (typeof val !== "string") return false;
  }
  return true;
};

const RDF_MEDIA_TYPE_ALIASES = new Map<string, string>([
  ["application/turtle", "text/turtle"],
  ["application/x-turtle", "text/turtle"],
  ["text/turtle", "text/turtle"],
  ["text/n3", "text/n3"],
  ["application/n-triples", "application/n-triples"],
  ["text/n-triples", "application/n-triples"],
  ["application/n-quads", "application/n-quads"],
  ["text/n-quads", "application/n-quads"],
  ["application/trig", "application/trig"],
  ["application/trix", "application/trix"],
  ["application/ld+json", "application/ld+json"],
  ["application/json", "application/ld+json"],
  ["application/rdf+xml", "application/rdf+xml"],
  ["application/xml", "application/rdf+xml"],
  ["text/xml", "application/rdf+xml"],
]);

const RDF_KNOWN_MEDIA_TYPES = new Set<string>(RDF_MEDIA_TYPE_ALIASES.values());

const canonicalizeMediaType = (raw?: string | null): string | undefined => {
  if (!raw) return undefined;
  const base = raw.split(";")[0].trim().toLowerCase();
  if (!base) return undefined;
  const mapped = RDF_MEDIA_TYPE_ALIASES.get(base);
  if (mapped) return mapped;
  return RDF_KNOWN_MEDIA_TYPES.has(base) ? base : undefined;
};

const inferMediaTypeFromName = (name: string): string | undefined => {
  if (!name) return undefined;
  const lower = name.toLowerCase();
  if (lower.endsWith(".ttl") || lower.endsWith(".turtle")) return "text/turtle";
  if (lower.endsWith(".n3")) return "text/n3";
  if (lower.endsWith(".nt")) return "application/n-triples";
  if (lower.endsWith(".nq")) return "application/n-quads";
  if (lower.endsWith(".jsonld")) return "application/ld+json";
  if (lower.endsWith(".json")) return "application/ld+json";
  if (lower.endsWith(".rdf") || lower.endsWith(".owl") || lower.endsWith(".xml")) return "application/rdf+xml";
  if (lower.endsWith(".trig")) return "application/trig";
  if (lower.endsWith(".trix")) return "application/trix";
  return undefined;
};

const inferMediaTypeFromContent = (content?: string): string | undefined => {
  if (typeof content !== "string") return undefined;
  const snippet = content.trimStart().slice(0, 1024);
  if (!snippet) return undefined;

  if (snippet.startsWith("{") || snippet.startsWith("[")) {
    const jsonProbe = snippet.slice(0, 256).toLowerCase();
    if (jsonProbe.includes("\"@context\"") || jsonProbe.includes("'@context'")) {
      return "application/ld+json";
    }
  }

  if (/^@prefix\s+/i.test(snippet) || /^prefix\s+/i.test(snippet)) {
    return "text/turtle";
  }

  if (/^<\?xml/i.test(snippet) || /^<rdf:/i.test(snippet)) {
    return "application/rdf+xml";
  }

  // Heuristic: Turtle/N-Triples often contain " a " or terminating "." patterns very early.
  const firstLine = snippet.split(/\r?\n/, 1)[0] || "";
  if (/^[\w:-]+\s+a\s+[\w:<]/i.test(firstLine)) {
    return "text/turtle";
  }

  return undefined;
};

/**
 * Resolve remote `@context` URLs in a JSON-LD document so the worker parser
 * never needs to make network requests (avoids Firefox CORS/redirect failures).
 *
 * Returns the modified JSON string and the list of remote context URLs that
 * were found (callers can feed these into ontology discovery).
 */
const resolveJsonLdContexts = async (
  json: string,
  fetchFn: (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<Response>,
  signal: AbortSignal,
): Promise<{ json: string; contextUrls: string[] }> => {
  let doc: any;
  try { doc = JSON.parse(json); } catch { return { json, contextUrls: [] }; }
  const ctx = doc?.["@context"];
  if (!ctx) return { json, contextUrls: [] };

  const contextUrls: string[] = [];

  const resolveEntry = async (entry: unknown): Promise<unknown> => {
    if (typeof entry !== "string") return entry;
    if (!entry.startsWith("http://") && !entry.startsWith("https://")) return entry;
    contextUrls.push(entry);
    // Upgrade http→https to avoid Firefox CORS failures on 301 redirects
    const fetchUrl = entry.startsWith("http://") ? entry.replace("http://", "https://") : entry;
    try {
      const resp = await fetchFn(fetchUrl, { Accept: "application/ld+json, application/json" }, signal);
      if (!resp.ok) return entry;
      const body = await resp.json();
      return body?.["@context"] ?? body;
    } catch {
      return entry;
    }
  };

  if (Array.isArray(ctx)) {
    doc["@context"] = await Promise.all(ctx.map(resolveEntry));
  } else {
    doc["@context"] = await resolveEntry(ctx);
  }
  return { json: JSON.stringify(doc), contextUrls };
};

const gatherCandidateNames = (source?: string): string[] => {
  const candidates: string[] = [];
  if (!source) return candidates;
  candidates.push(source);
  try {
    const url = new URL(source);
    const pathSeg = url.pathname.split("/").filter(Boolean).pop();
    if (pathSeg) candidates.unshift(pathSeg);
    for (const value of url.searchParams.values()) {
      if (value) candidates.push(value);
    }
  } catch (_) {
    // ignore URL parse errors
  }
  return candidates;
};

const inferRdfMediaType = (
  declaredType: string | null | undefined,
  sourceUrl?: string,
  contentSnippet?: string,
): string | undefined => {
  const canonical = canonicalizeMediaType(declaredType);
  if (canonical && canonical !== "text/plain") {
    return canonical;
  }

  const candidates = gatherCandidateNames(sourceUrl);
  for (const candidate of candidates) {
    const inferred = inferMediaTypeFromName(candidate);
    if (inferred) return inferred;
  }

  const sniffed = inferMediaTypeFromContent(contentSnippet);
  if (sniffed) return sniffed;

  // Fall back to canonical when server declared a known RDF type (including json alias)
  if (canonical && RDF_KNOWN_MEDIA_TYPES.has(canonical)) {
    return canonical;
  }

  return undefined;
};

/** Returns true if the URL looks like a SPARQL endpoint (by path pattern). */
const isSparqlEndpointUrl = (url: string): boolean => {
  try {
    const path = new URL(url).pathname.replace(/\/$/, "").toLowerCase();
    return path.endsWith("/sparql") || path.endsWith("/query") || path.endsWith("/sparql/query");
  } catch {
    return false;
  }
};

/** Returns true if the content-type indicates a SPARQL endpoint (not raw RDF). */
const isSparqlEndpointResponse = (contentType: string | null): boolean => {
  if (!contentType) return false;
  const ct = contentType.toLowerCase();
  return (
    ct.includes("text/html") ||
    ct.includes("application/sparql-results") ||
    ct.includes("application/sparql+json")
  );
};

/** Builds a SPARQL CONSTRUCT ALL query URL from a SPARQL endpoint URL.
 *  Queries both the default graph and all named graphs via UNION. */
const buildSparqlConstructUrl = (endpoint: string): string => {
  const query = "CONSTRUCT { ?s ?p ?o } WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }";
  const sep = endpoint.includes("?") ? "&" : "?";
  return `${endpoint}${sep}query=${encodeURIComponent(query)}`;
};

const sanitizeBlankNodeValue = (value: string): string => value.replace(/^_:/, "");

type TermContext = "subject" | "predicate" | "object" | "graph";

const isRdfTerm = (value: any): value is { termType: string; value: string } => {
  return value && typeof value === "object" && typeof value.termType === "string";
};

const cloneLiteral = (source: WorkerTerm): WorkerTerm => {
  const literal: WorkerTerm = { termType: "Literal", value: typeof source.value === "string" ? source.value : "" };
  if ((source as any).language) literal.language = (source as any).language;
  if ((source as any).datatype) literal.datatype = (source as any).datatype;
  return literal;
};

const normalizeWorkerTerm = (term: WorkerTerm, context: TermContext): WorkerTerm => {
  const value = typeof term.value === "string" ? term.value : "";
  switch (term.termType) {
    case "NamedNode":
      return { termType: "NamedNode", value };
    case "BlankNode": {
      const sanitized = sanitizeBlankNodeValue(value);
      if (context === "predicate" || context === "graph") {
        return { termType: "NamedNode", value: sanitized || value };
      }
      return { termType: "BlankNode", value: sanitized };
    }
    case "Literal":
      if (context === "subject" || context === "predicate" || context === "graph") {
        return { termType: "NamedNode", value };
      }
      return cloneLiteral(term);
    case "DefaultGraph":
    default:
      if (context === "graph") return { termType: "DefaultGraph" };
      if (context === "object") return { termType: "Literal", value };
      return { termType: "NamedNode", value };
  }
};

const extractDatatype = (input: unknown): string | undefined => {
  if (!input) return undefined;
  if (typeof input === "string") return input;
  if (typeof input === "object" && typeof (input as any).value === "string") {
    return String((input as any).value);
  }
  return undefined;
};

const coerceWorkerTerm = (value: any, context: TermContext): WorkerTerm | null => {
  if (value === null || typeof value === "undefined") {
    if (context === "graph") return { termType: "DefaultGraph" };
    if (context === "object") return null;
    return null;
  }

  if (isWorkerQuad(value as any)) {
    return null;
  }

  // CRITICAL: If already a proper N3 Term, serialize it to WorkerTerm format
  // This preserves the exact datatype/language while converting to worker protocol
  if (isRdfTerm(value)) {
    try {
      // Serialize N3 Term to WorkerTerm format (required by worker protocol)
      const serialized = serializeTerm(value as any);
      // For context-sensitive normalization (e.g., literals can't be subjects)
      return normalizeWorkerTerm(serialized, context);
    } catch (err) {
      console.error("[rdfManager] serializeTerm failed", err);
      return null;
    }
  }

  if (typeof value === "object" && value) {
    const termType =
      typeof (value as any).termType === "string"
        ? String((value as any).termType)
        : undefined;
    if (termType) {
      return normalizeWorkerTerm(value as WorkerTerm, context);
    }

    if ("value" in (value as any)) {
      const raw = String((value as any).value ?? "");
      const typeHint =
        typeof (value as any).type === "string"
          ? String((value as any).type).toLowerCase()
          : "";
      const datatype = extractDatatype((value as any).datatype);
      const language =
        typeof (value as any).language === "string"
          ? String((value as any).language)
          : typeof (value as any).lang === "string"
            ? String((value as any).lang)
            : undefined;

      if (context === "object") {
        if (typeHint === "iri" || typeHint === "namednode") {
          return normalizeWorkerTerm({ termType: "NamedNode", value: raw }, context);
        }
        if (typeHint === "bnode" || typeHint === "blank" || typeHint === "blanknode") {
          return normalizeWorkerTerm({ termType: "BlankNode", value: raw }, context);
        }
        if (typeHint === "literal" || typeHint === "lit" || datatype || language) {
          const literal: WorkerTerm = { termType: "Literal", value: raw };
          if (datatype) literal.datatype = datatype;
          if (language) literal.language = language;
          return normalizeWorkerTerm(literal, context);
        }
        if (/^_:/i.test(raw)) {
          return normalizeWorkerTerm({ termType: "BlankNode", value: raw }, context);
        }
        if (IRI_REGEX.test(raw)) {
          return normalizeWorkerTerm({ termType: "NamedNode", value: raw }, context);
        }
        const literal: WorkerTerm = { termType: "Literal", value: raw };
        if (datatype) literal.datatype = datatype;
        if (language) literal.language = language;
        return normalizeWorkerTerm(literal, context);
      }

      if (context === "graph") {
        if (typeHint === "defaultgraph" || raw === "default") {
          return { termType: "DefaultGraph" };
        }
        if (typeHint === "bnode" || typeHint === "blank" || typeHint === "blanknode") {
          return normalizeWorkerTerm({ termType: "BlankNode", value: raw }, context);
        }
        return normalizeWorkerTerm({ termType: "NamedNode", value: raw }, context);
      }

      if (context === "subject") {
        if (typeHint === "bnode" || /^_:/i.test(raw)) {
          return normalizeWorkerTerm({ termType: "BlankNode", value: raw }, context);
        }
        return normalizeWorkerTerm({ termType: "NamedNode", value: raw }, context);
      }

      if (context === "predicate") {
        return normalizeWorkerTerm({ termType: "NamedNode", value: raw }, context);
      }
    }
  }

  const str = String(value ?? "").trim();
  if (!str) {
    if (context === "graph") return { termType: "DefaultGraph" };
    if (context === "object") return null;
    return null;
  }

  if (context === "object") {
    if (/^_:/i.test(str)) {
      return normalizeWorkerTerm({ termType: "BlankNode", value: str }, context);
    }
    if (IRI_REGEX.test(str)) {
      return normalizeWorkerTerm({ termType: "NamedNode", value: str }, context);
    }
    return normalizeWorkerTerm({ termType: "Literal", value: str }, context);
  }

  if (context === "graph") {
    if (str === "default") return { termType: "DefaultGraph" };
    return normalizeWorkerTerm({ termType: "NamedNode", value: str }, context);
  }

  if (context === "subject") {
    if (/^_:/i.test(str)) {
      return normalizeWorkerTerm({ termType: "BlankNode", value: str }, context);
    }
    return normalizeWorkerTerm({ termType: "NamedNode", value: str }, context);
  }

  return normalizeWorkerTerm({ termType: "NamedNode", value: str }, context);
};

const toWorkerSubjectTerm = (value: any): WorkerTerm | null => coerceWorkerTerm(value, "subject");
const toWorkerPredicateTerm = (value: any): WorkerTerm | null => coerceWorkerTerm(value, "predicate");
const toWorkerObjectTerm = (value: any): WorkerTerm | null => coerceWorkerTerm(value, "object");
const toWorkerGraphTerm = (value: any, fallbackGraph: string): WorkerTerm => {
  const raw = typeof value === "undefined" || value === null ? fallbackGraph : value;
  const term = coerceWorkerTerm(raw, "graph");
  if (!term) {
    if (fallbackGraph === "default") return { termType: "DefaultGraph" };
    return {
      termType: "NamedNode",
      value: String(fallbackGraph || DEFAULT_GRAPH),
    };
  }
  if (term.termType === "NamedNode") {
    return {
      termType: "NamedNode",
      value: term.value || String(fallbackGraph || DEFAULT_GRAPH),
    };
  }
  if (term.termType === "DefaultGraph") {
    if (typeof raw === "string" && raw !== "default" && raw.length > 0) {
      return { termType: "NamedNode", value: raw };
    }
    if (fallbackGraph && fallbackGraph !== "default") {
      return { termType: "NamedNode", value: fallbackGraph };
    }
    return { termType: "DefaultGraph" };
  }
  return {
    termType: "NamedNode",
    value: term.value || String(fallbackGraph || DEFAULT_GRAPH),
  };
};

const workerTermToString = (term: WorkerTerm | null | undefined): string => {
  if (!term) return "";
  if (term.termType === "NamedNode" || term.termType === "BlankNode") {
    return String(term.value || "");
  }
  if (term.termType === "Literal") {
    return String(term.value || "");
  }
  return "";
};

const flattenSubjectQuadMap = (map: Record<string, WorkerQuad[]> | undefined): WorkerQuad[] => {
  if (!map) return [];
  const all: WorkerQuad[] = [];
  for (const value of Object.values(map)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (isWorkerQuad(entry)) {
        all.push(entry);
      }
    }
  }
  return all;
};


export class RDFManagerImpl {
  private worker: RdfManagerWorkerClient;
  private changeSubscribers = new Set<ChangeSubscriber>();
  private subjectsSubscribers = new Set<SubjectsSubscriber>();
  private changeCount = 0;
  private namespaces: NamespaceEntry[] = [];
  private namespaceChangeSubscribers = new Set<(entries: NamespaceEntry[]) => void>();
  private blacklistPrefixes: Set<string> = new Set(DEFAULT_BLACKLIST_PREFIXES);
  private blacklistUris: string[] = [...DEFAULT_BLACKLIST_URIS];
  private workerChangeUnsub: (() => void) | null = null;
  private workerSubjectsUnsub: (() => void) | null = null;

  private notifyNamespacesChanged(): void {
    const snapshot = this.getNamespaces();
    for (const cb of Array.from(this.namespaceChangeSubscribers)) {
      try { cb(snapshot); } catch (err) {
        console.error("[rdfManager] namespace subscriber failed", err);
      }
    }
  }

  private pushNamespacesToWorker(): void {
    const record = entriesToRecord(this.namespaces);
    void this.worker.call("setNamespaces", { namespaces: record, replace: true }).catch((err) => {
      console.error("[rdfManager] worker setNamespaces failed", err);
    });
  }

  constructor(options?: { workerClient?: RdfManagerWorkerClient }) {
    this.worker = options?.workerClient ?? createRdfManagerWorkerClient();
    this.workerChangeUnsub = this.worker.on("change", this.handleWorkerChange);
    this.workerSubjectsUnsub = this.worker.on("subjects", this.handleWorkerSubjects);
    void this.bootstrapState();
  }

  private async bootstrapState() {
    // Skip if worker not initialized yet (e.g., in test environment before beforeEach runs)
    if (!this.worker) {
      return;
    }
    
    try {
      const namespaces = await this.worker.call("getNamespaces");
      if (isStringRecord(namespaces)) {
        this.namespaces = recordToEntries(ensureDefaultNamespaceMap(namespaces as Record<string, string>));
        this.notifyNamespacesChanged();
      }
    } catch (err) {
      // Silently fail if worker not ready - this is expected during test initialization
      if (err instanceof Error && err.message === "rdfManager worker not initialised") {
        return;
      }
      console.debug("[rdfManager] bootstrapState.getNamespaces failed", err);
    }
    try {
      const blacklist = await this.worker.call("getBlacklist");
      if (isPlainObject(blacklist)) {
        const prefixes = Array.isArray((blacklist as any).prefixes)
          ? (blacklist as any).prefixes.map((p: any) => String(p)).filter(Boolean)
          : [];
        const uris = Array.isArray((blacklist as any).uris)
          ? (blacklist as any).uris.map((u: any) => String(u)).filter(Boolean)
          : [];
        if (prefixes.length > 0) this.blacklistPrefixes = new Set(prefixes);
        if (uris.length > 0) this.blacklistUris = uris;
      }
    } catch (err) {
      // Silently fail if worker not ready
      if (err instanceof Error && err.message === "rdfManager worker not initialised") {
        return;
      }
      console.debug("[rdfManager] bootstrapState.getBlacklist failed", err);
    }
  }

  private handleWorkerChange = (payload: any) => {
    this.changeCount =
      payload && typeof payload.changeCount === "number"
        ? payload.changeCount
        : this.changeCount + 1;
    const meta = payload ? payload.meta : undefined;
    for (const cb of Array.from(this.changeSubscribers)) {
      try {
        cb(this.changeCount, meta);
      } catch (err) {
        console.error("[rdfManager] change subscriber failed", err);
      }
    }
  };

  private notifySubjectSubscribers(
    subjects: string[],
    quads: WorkerQuad[] | undefined,
    snapshot: WorkerReconcileSubjectSnapshotPayload[] | undefined,
    meta: Record<string, unknown> | null | undefined,
  ): void {
    for (const cb of Array.from(this.subjectsSubscribers)) {
      try {
        cb(
          subjects,
          quads && quads.length > 0 ? quads : undefined,
          snapshot && snapshot.length > 0 ? snapshot : undefined,
          meta ?? null,
        );
      } catch (err) {
        console.error("[rdfManager] subjects subscriber failed", err);
      }
    }
  }

  private handleWorkerSubjects = (payload: any) => {
    const subjects = Array.isArray(payload?.subjects)
      ? payload.subjects.map((s: any) => String(s)).filter(Boolean)
      : [];
    const quads = flattenSubjectQuadMap(
      payload && payload.quads && typeof payload.quads === "object"
        ? (payload.quads as Record<string, WorkerQuad[]>)
        : undefined,
    );
    const rawMeta = payload && typeof payload.meta === "object" && payload.meta !== null
      ? (payload.meta as Record<string, unknown>)
      : null;
    const meta =
      rawMeta && typeof rawMeta === "object" ? { ...rawMeta } : null;

    const snapshotRaw = Array.isArray(payload?.snapshot)
      ? (payload.snapshot as unknown[])
      : [];
    const snapshot = snapshotRaw
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const record = entry as Record<string, unknown>;
        const iri =
          typeof record.iri === "string" && record.iri.trim().length > 0
            ? record.iri.trim()
            : "";
        if (!iri) return null;
        const types =
          Array.isArray(record.types)
            ? (record.types as unknown[])
                .map((value) =>
                  typeof value === "string" ? value.trim() : String(value ?? "").trim(),
                )
                .filter((value) => value.length > 0)
            : [];
        const label =
          typeof record.label === "string" && record.label.trim().length > 0
            ? record.label.trim()
            : undefined;
        return {
          iri,
          types,
          ...(label ? { label } : {}),
        } as WorkerReconcileSubjectSnapshotPayload;
      })
      .filter(Boolean) as WorkerReconcileSubjectSnapshotPayload[];

    this.notifySubjectSubscribers(subjects, quads, snapshot, meta);
  };

  getBlacklist(): { prefixes: string[]; uris: string[] } {
    return {
      prefixes: Array.from(this.blacklistPrefixes),
      uris: [...this.blacklistUris],
    };
  }

  setBlacklist(prefixes?: string[] | null, uris?: string[] | null): void {
    this.blacklistPrefixes = new Set((prefixes || []).map(String));
    if (Array.isArray(uris)) this.blacklistUris = uris.map(String);
    void this.worker
      .call("setBlacklist", {
        prefixes: Array.from(this.blacklistPrefixes),
        uris: [...this.blacklistUris],
      })
      .catch((err) => {
        console.error("[rdfManager] worker setBlacklist failed", err);
      });
    const appConfig = (useAppConfigStore as any)?.getState?.();
    if (appConfig && typeof appConfig.setConfig === "function") {
      try {
        appConfig.setConfig({
          rdfBlacklist: {
            prefixes: Array.from(this.blacklistPrefixes),
            uris: [...this.blacklistUris],
          },
        });
      } catch (err) {
        console.debug("[rdfManager] persist blacklist failed", err);
      }
    }
  }

  setDebug(enabled: boolean): void {
    void this.worker.call("setDebug", { enabled }).catch(() => {});
  }

  onChange(cb: ChangeSubscriber): void {
    this.changeSubscribers.add(cb);
  }

  offChange(cb: ChangeSubscriber): void {
    this.changeSubscribers.delete(cb);
  }

  onSubjectsChange(cb: SubjectsSubscriber): void {
    this.subjectsSubscribers.add(cb);
  }

  offSubjectsChange(cb: SubjectsSubscriber): void {
    this.subjectsSubscribers.delete(cb);
  }

  onNamespacesChange(cb: (entries: NamespaceEntry[]) => void): () => void {
    this.namespaceChangeSubscribers.add(cb);
    return () => this.namespaceChangeSubscribers.delete(cb);
  }

  async triggerSubjectUpdate(subjectIris: string[]): Promise<void> {
    if (!Array.isArray(subjectIris) || subjectIris.length === 0) return;
    const subjects = subjectIris.map((s) => String(s)).filter(Boolean);
    if (subjects.length === 0) return;
    await this.worker.call("triggerSubjects", { subjects });
  }

  async runReasoning(options?: { rulesets?: string[]; reasonerBackend?: 'konclude' | 'n3' }): Promise<ReasoningResult> {
    const reasoningId = `reasoning-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const rulesets = Array.isArray(options?.rulesets)
      ? options!.rulesets.map((r) => String(r)).filter(Boolean)
      : [];
    const appConfigState = (useAppConfigStore as any)?.getState?.();
    const reasonerBackend: 'konclude' | 'n3' =
      options?.reasonerBackend === 'n3' ? 'n3'
      : options?.reasonerBackend === 'konclude' ? 'konclude'
      : appConfigState?.config?.reasonerBackend === 'n3' ? 'n3'
      : 'konclude';
    const resolveBaseUrl = (): string => {
      try {
        const envBase =
          typeof import.meta !== "undefined" &&
          typeof import.meta.env?.BASE_URL === "string"
            ? import.meta.env.BASE_URL
            : undefined;
        if (envBase && envBase.trim().length > 0) {
          return envBase;
        }
      } catch (_) {
        /* ignore env lookup failures */
      }
      try {
        if (typeof window !== "undefined" && window.location && typeof window.location.pathname === "string") {
          const pathName = window.location.pathname || "/";
          return pathName.endsWith("/") ? pathName : `${pathName}/`;
        }
      } catch (_) {
        /* ignore window lookup failures */
      }
      return "/";
    };

    const shaclEnabled = appConfigState?.config?.shaclEnabled !== false;
    const payload = {
      reasoningId,
      rulesets,
      emitSubjects: true,
      baseUrl: resolveBaseUrl(),
      reasonerBackend,
      shaclEnabled,
    };
    const response = await this.worker.call("runReasoning", payload);
    const safe = isPlainObject(response) ? response : {};
    return {
      id: reasoningId,
      timestamp: Date.now(),
      status: "completed",
      duration: typeof safe.durationMs === "number" ? safe.durationMs : 0,
      errors: Array.isArray(safe.errors) ? (safe.errors as ReasoningError[]) : [],
      warnings: Array.isArray(safe.warnings) ? (safe.warnings as ReasoningWarning[]) : [],
      inferences: Array.isArray(safe.inferences) ? (safe.inferences as ReasoningInference[]) : [],
      isConsistent: typeof safe.isConsistent === "boolean" ? safe.isConsistent : null,
      meta: {
        usedReasoner: !!safe.usedReasoner,
        workerDurationMs: typeof safe.workerDurationMs === "number" ? safe.workerDurationMs : undefined,
        totalDurationMs: typeof safe.durationMs === "number" ? safe.durationMs : undefined,
        addedCount: typeof safe.addedCount === "number" ? safe.addedCount : undefined,
        ruleQuadCount: typeof safe.ruleQuadCount === "number" ? safe.ruleQuadCount : undefined,
      },
    };
  }

  async runShaclValidation(): Promise<{ conforms: boolean; violations: ShaclViolation[]; shapeCount: number }> {
    const response = await this.worker.call("runShaclValidation", undefined);
    const safe = isPlainObject(response) ? response : {};
    return {
      conforms: typeof safe.conforms === "boolean" ? safe.conforms : true,
      violations: Array.isArray(safe.violations) ? safe.violations : [],
      shapeCount: typeof safe.shapeCount === "number" ? safe.shapeCount : 0,
    };
  }

  /**
   * Return minimal inconsistency justifications (MIPS) for the current store.
   * Each justification is the minimal set of axioms whose conjunction is
   * contradictory. Returns an empty array when the ontology is consistent.
   */
  async explainInconsistency(
    maxJustifications = 1,
  ): Promise<
    {
      subject: string;
      predicate: string;
      object: string;
      objectTermType?: string;
      objectDatatype?: string;
      objectLanguage?: string;
      graph?: string;
    }[][]
  > {
    const response = await this.worker.call("explainInconsistency", { maxJustifications });
    const safe = isPlainObject(response) ? response : {};
    // C1 + H2: the worker now annotates each justification axiom with its source
    // `graph` and full object term (objectTermType/Datatype/Language). These are
    // OPTIONAL — older worker builds omit them and callers must tolerate absence.
    return Array.isArray(safe.mips)
      ? (safe.mips as {
          subject: string;
          predicate: string;
          object: string;
          objectTermType?: string;
          objectDatatype?: string;
          objectLanguage?: string;
          graph?: string;
        }[][])
      : [];
  }

  /**
   * Like explainInconsistency, but ALSO returns the LACONIC justifications
   * (Horridge, Parsia, Sattler, "Laconic and Precise Justifications in OWL",
   * ISWC 2008): for each MIPS, the superfluous-part-free axiom PARTS that are the
   * precise culprit, each mapped back to the ORIGINAL axiom it was split from.
   *
   * `justifications` is identical to what explainInconsistency returns (the
   * regular, whole-axiom MIPS). `laconicJustifications` is aligned BY INDEX with
   * `justifications`; entry i is the laconic refinement of justification i:
   *   - parts: the laconic axiom parts (e.g. the `A ⊑ B` part of `A ⊑ B ⊓ C`),
   *     each carrying its source axiom's principal triple (sourceSubject/…);
   *   - sharpened: true when laconic dropped at least one superfluous part;
   *   - skipped: true when the worker's cost cap suppressed laconic for this MIPS
   *     (then parts == the regular axioms, lossless fallback).
   *
   * NON-BREAKING: the laconic data is purely additive; older worker builds omit
   * the field and `laconicJustifications` comes back as an empty array.
   */
  async explainInconsistencyWithLaconic(
    maxJustifications = 1,
  ): Promise<{
    justifications: {
      subject: string;
      predicate: string;
      object: string;
      objectTermType?: string;
      objectDatatype?: string;
      objectLanguage?: string;
      graph?: string;
    }[][];
    laconicJustifications: {
      parts: {
        subject: string;
        predicate: string;
        object: string;
        objectIsLiteral?: boolean;
        sourceSubject: string;
        sourcePredicate: string;
        sourceObject: string;
        isPartOf: boolean;
      }[];
      sharpened: boolean;
      skipped: boolean;
    }[];
  }> {
    const response = await this.worker.call("explainInconsistency", { maxJustifications });
    const safe = isPlainObject(response) ? response : {};
    const justifications = Array.isArray(safe.mips)
      ? (safe.mips as {
          subject: string;
          predicate: string;
          object: string;
          objectTermType?: string;
          objectDatatype?: string;
          objectLanguage?: string;
          graph?: string;
        }[][])
      : [];
    const laconicJustifications = Array.isArray(safe.laconicJustifications)
      ? (safe.laconicJustifications as {
          parts: {
            subject: string;
            predicate: string;
            object: string;
            objectIsLiteral?: boolean;
            sourceSubject: string;
            sourcePredicate: string;
            sourceObject: string;
            isPartOf: boolean;
          }[];
          sharpened: boolean;
          skipped: boolean;
        }[])
      : [];
    return { justifications, laconicJustifications };
  }

  async validate(): Promise<{ consistent: boolean; unsatisfiable: string[] }> {
    const response = await this.worker.call("validate", undefined);
    const safe = isPlainObject(response) ? response : {};
    return {
      consistent: (safe as any).consistent === true,
      unsatisfiable: Array.isArray((safe as any).unsatisfiable) ? ((safe as any).unsatisfiable as string[]) : [],
    };
  }

  /**
   * Explain why an entailed axiom (subjectIri predicateIri objectIri) holds —
   * Horridge-style justifications for an ARBITRARY entailed axiom, not just
   * inconsistency. Each justification is a minimal set of ontology axioms whose
   * conjunction entails the requested axiom. Returns `isEntailed:false` with an
   * empty list when the axiom is not entailed, and `isEntailed:true` with an
   * empty list when the axiom is asserted-only (nothing to derive) or for
   * unsupported shapes. Supported shapes: rdfs:subClassOf and rdf:type with an
   * IRI object. READ-ONLY — never mutates urn:vg:data.
   */
  async explainEntailment(
    subjectIri: string,
    predicateIri: string,
    objectIri: string,
    opts?: { objectIsLiteral?: boolean; maxJustifications?: number },
  ): Promise<{
    isEntailed: boolean | null;
    justifications: { subject: string; predicate: string; object: string }[][];
    ontologyInconsistent?: boolean;
    vacuous?: boolean;
    reason?: string;
  }> {
    const response = await this.worker.call("explainEntailment", {
      subjectIri,
      predicateIri,
      objectIri,
      objectIsLiteral: opts?.objectIsLiteral,
      maxJustifications: opts?.maxJustifications,
    });
    const safe = (isPlainObject(response) ? response : {}) as Record<string, unknown>;
    // C1: when the ontology is already inconsistent the reduction is invalid and
    // the worker reports isEntailed:null with ontologyInconsistent:true. Preserve
    // null (do NOT coerce to false) so the tool can distinguish "vacuous, fix
    // consistency first" from "not entailed".
    const ontologyInconsistent = safe.ontologyInconsistent === true;
    return {
      isEntailed: ontologyInconsistent ? null : safe.isEntailed === true,
      justifications: Array.isArray(safe.justifications)
        ? (safe.justifications as { subject: string; predicate: string; object: string }[][])
        : [],
      ...(ontologyInconsistent ? { ontologyInconsistent: true } : {}),
      ...(safe.vacuous === true ? { vacuous: true } : {}),
      ...(typeof safe.reason === "string" ? { reason: safe.reason } : {}),
    };
  }

  /**
   * Search existing ontology terms (classes / properties / individuals) by
   * label or IRI local-name across ALL graphs — especially urn:vg:ontologies
   * (loaded ontologies). Pure store query (no reasoner). Returns ranked
   * candidates so callers can REUSE an existing IRI instead of minting a new
   * one. `kinds` defaults to classes + properties; `limit` defaults to 25.
   */
  async searchTerms(
    query: string,
    opts?: {
      kinds?: ("class" | "objectProperty" | "datatypeProperty" | "property" | "individual")[];
      limit?: number;
    },
  ): Promise<
    Array<{
      iri: string;
      label: string;
      kind: "class" | "objectProperty" | "datatypeProperty" | "property" | "individual";
      prefix?: string;
      score: number;
    }>
  > {
    const response = await this.worker.call("searchTerms", {
      query,
      kinds: opts?.kinds,
      limit: opts?.limit,
    });
    const safe = isPlainObject(response) ? response : {};
    return Array.isArray(safe.results)
      ? (safe.results as Array<{
          iri: string;
          label: string;
          kind: "class" | "objectProperty" | "datatypeProperty" | "property" | "individual";
          prefix?: string;
          score: number;
        }>)
      : [];
  }

  /**
   * Symbolically verify a repair candidate: re-run the Konclude consistency
   * oracle on a COPY of the data store with the given axioms removed. Returns
   * true when removing those axioms makes the ontology consistent. Never
   * mutates urn:vg:data.
   *
   * Backwards-compatible boolean wrapper around `verifyRepairDetailed`.
   */
  async verifyRepair(
    removals: VerifyRepairRemoval[],
  ): Promise<boolean> {
    return (await this.verifyRepairDetailed(removals)).verifiedConsistent;
  }

  /**
   * Like `verifyRepair` but also reports how many of the requested removals
   * actually matched a quad in the store. `matchedCount < requestedCount`
   * means some removals matched nothing (e.g. a serialization mismatch), so a
   * `verifiedConsistent:false` may simply mean "the store was not changed"
   * rather than "removing this repair leaves the ontology inconsistent" (L2).
   */
  async verifyRepairDetailed(
    removals: VerifyRepairRemoval[],
  ): Promise<{
    verifiedConsistent: boolean;
    removedCount: number;
    requestedCount: number;
    matchedCount: number;
  }> {
    const response = await this.worker.call("verifyRepair", { removals });
    const safe = (isPlainObject(response) ? response : {}) as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === "number" ? v : 0);
    return {
      verifiedConsistent: safe.verifiedConsistent === true,
      removedCount: num(safe.removedCount),
      requestedCount: num(safe.requestedCount),
      matchedCount: num(safe.matchedCount),
    };
  }

  onReasoningStage(handler: (payload: { id: string; stage: string; meta?: Record<string, unknown> }) => void): () => void {
    return this.worker.on('reasoningStage', handler);
  }

  /**
   * Subscribe to streaming import-progress events emitted while a large
   * importSerialized is writing triples to the store in chunks. `loaded` is the
   * running count of parsed triples processed so far; `total` is the full parsed
   * count for this import. Optional and non-breaking — callers that don't
   * subscribe see no behavioural change. Returns an unsubscribe function.
   */
  onImportProgress(
    handler: (payload: { id: string; loaded: number; total?: number; graphName?: string }) => void,
  ): () => void {
    return this.worker.on('importProgress', handler);
  }

  private mergePrefixes(input?: Record<string, string>, graphName?: string) {
    const targetGraph = graphName || DEFAULT_GRAPH;
    if (
      targetGraph !== DEFAULT_GRAPH &&
      targetGraph !== "urn:vg:data" &&
      targetGraph !== "urn:vg:ontologies"
    ) {
      return;
    }
    if (!input || typeof input !== "object") return;
    let changed = false;
    for (const [prefix, uri] of Object.entries(input)) {
      if (typeof prefix !== "string" || typeof uri !== "string") continue;
      const idx = this.namespaces.findIndex(e => e.prefix === prefix);
      if (idx >= 0) {
        const existing = this.namespaces[idx];
        if (existing.uri !== uri) {
          this.namespaces[idx] = { prefix, uri };
          changed = true;
        }
      } else {
        this.namespaces.push({ prefix, uri });
        changed = true;
      }
    }
    if (changed) {
      const appConfig = (useAppConfigStore as any)?.getState?.();
      if (appConfig && typeof appConfig.setConfig === "function") {
        try {
          appConfig.setConfig({ rdfNamespaces: entriesToRecord(this.namespaces) });
        } catch (err) {
          console.debug("[rdfManager] persist namespaces failed", err);
        }
      }
      this.pushNamespacesToWorker();
      this.notifyNamespacesChanged();
    }
  }

  async loadRDFIntoGraph(
    rdfContent: string,
    graphName?: string,
    mimeType?: string,
    filename?: string,
    forceGraph?: boolean,
  ): Promise<void> {
    if (typeof rdfContent !== "string" || rdfContent.trim().length === 0) {
      throw new Error("Empty RDF content provided to loadRDFIntoGraph");
    }
    const targetGraph = graphName || DEFAULT_GRAPH;
    const payload: ImportSerializedPayload = {
      content: rdfContent,
      graphName: targetGraph,
      contentType: mimeType,
      filename,
      forceGraph,
      ontologyUrl: targetGraph === "urn:vg:ontologies" && filename ? filename : undefined,
    };
    const result = await this.worker.call("importSerialized", payload);
    if (isPlainObject(result)) {
      if (result && isStringRecord(result.prefixes)) {
        this.mergePrefixes(
          result.prefixes as Record<string, string>,
          payload.graphName,
        );
      }
    }
  }

  async unloadOntologySubjects(ontologyUrl: string): Promise<string[]> {
    if (!ontologyUrl) return [];
    const result = await this.worker.call("unloadOntologySubjects", { ontologyUrl });
    return isPlainObject(result) && Array.isArray((result as any).removedSubjects)
      ? (result as any).removedSubjects as string[]
      : [];
  }

  /** Fetches a URL, falling back to a user-configured CORS proxy on network/CORS errors. */
  private async fetchWithCorsFallback(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
    authHeader?: { name: string; value: string },
    corsProxyUrl?: string,
  ): Promise<Response> {
    const reqHeaders = authHeader
      ? { ...headers, [authHeader.name]: authHeader.value }
      : headers;
    try {
      return await fetch(url, { signal, redirect: "follow", headers: reqHeaders });
    } catch (err) {
      // Network/CORS error — retry via the user-configured CORS proxy if set.
      // Ontology URLs often redirect through purl.org/w3id.org where the final
      // destination lacks CORS headers; a proxy fetches server-side without that restriction.
      if (corsProxyUrl) {
        const proxied = corsProxyUrl + encodeURIComponent(url);
        return await fetch(proxied, { signal, headers: { Accept: headers["Accept"] ?? "*/*" } });
      }
      throw err;
    }
  }

  async loadRDFFromUrl(
    url: string,
    graphName?: string,
    options?: { timeoutMs?: number; apiKey?: string; apiKeyHeader?: string; corsProxyUrl?: string },
  ): Promise<{ contextUrls?: string[] }> {
    if (!url) throw new Error("loadRDFFromUrl requires a url");
    const timeoutMs = options?.timeoutMs ?? 120000;
    const corsProxyUrl = options?.corsProxyUrl;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    const authHeader = options?.apiKey
      ? { name: options.apiKeyHeader || "Authorization", value: options.apiKey }
      : undefined;
    try {
      // If the URL pattern identifies a SPARQL endpoint, skip the probe fetch and go straight to CONSTRUCT.
      if (isSparqlEndpointUrl(url)) {
        const sparqlUrl = buildSparqlConstructUrl(url);
        const sparqlResponse = await this.fetchWithCorsFallback(
          sparqlUrl,
          { Accept: "text/turtle, application/n-triples" },
          controller.signal,
          authHeader,
          corsProxyUrl,
        );
        if (!sparqlResponse.ok) {
          throw new Error(`SPARQL CONSTRUCT query failed: ${sparqlResponse.status}`);
        }
        const text = await sparqlResponse.text();
        const ct = sparqlResponse.headers.get("content-type");
        const inferredContentType = inferRdfMediaType(ct, sparqlUrl, text);
        await this.loadRDFIntoGraph(text, graphName || DEFAULT_GRAPH, inferredContentType, url, true);
        return {};
      }

      const rdfAccept = "text/turtle, application/ld+json, application/n-triples, text/n3, application/rdf+xml, */*;q=0.1";
      const response = await this.fetchWithCorsFallback(url, { Accept: rdfAccept }, controller.signal, authHeader, corsProxyUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch RDF: ${response.status}`);
      }
      const contentTypeHeader = response.headers.get("content-type");

      if (isSparqlEndpointResponse(contentTypeHeader)) {
        // The URL returned HTML or SPARQL results — re-fetch using a CONSTRUCT ALL query
        const sparqlUrl = buildSparqlConstructUrl(url);
        const sparqlResponse = await this.fetchWithCorsFallback(
          sparqlUrl,
          { Accept: "text/turtle, application/n-triples" },
          controller.signal,
          authHeader,
          corsProxyUrl,
        );
        if (!sparqlResponse.ok) {
          throw new Error(`SPARQL CONSTRUCT query failed: ${sparqlResponse.status}`);
        }
        const text = await sparqlResponse.text();
        const ct = sparqlResponse.headers.get("content-type");
        const inferredContentType = inferRdfMediaType(ct, sparqlUrl, text);
        await this.loadRDFIntoGraph(text, graphName || DEFAULT_GRAPH, inferredContentType, url, true);
      } else {
        let text = await response.text();
        const inferredContentType = inferRdfMediaType(contentTypeHeader, url, text);
        // Pre-resolve remote @context URLs on main thread so the worker parser
        // doesn't need to fetch them (Firefox blocks cross-origin redirects in workers).
        let contextUrls: string[] | undefined;
        if (inferredContentType === "application/ld+json") {
          const fetchBound = this.fetchWithCorsFallback.bind(this);
          const fetchForCtx = (ctxUrl: string, headers: Record<string, string>, sig: AbortSignal) =>
            fetchBound(ctxUrl, headers, sig, authHeader, corsProxyUrl);
          const resolved = await resolveJsonLdContexts(text, fetchForCtx, controller.signal);
          text = resolved.json;
          contextUrls = resolved.contextUrls;
        }
        await this.loadRDFIntoGraph(text, graphName || DEFAULT_GRAPH, inferredContentType, url, true);
        return { contextUrls };
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
    return {};
  }

  removeQuadsInGraphByNamespaces(graphName: string, namespaceUris?: string[] | null): void {
    if (!graphName || !Array.isArray(namespaceUris) || namespaceUris.length === 0) return;
    const payload: RemoveQuadsByNamespacePayload = {
      graphName,
      namespaceUris: namespaceUris.map((ns) => String(ns)).filter(Boolean),
    };
    void this.worker.call("removeQuadsByNamespace", payload).catch((err) => {
      console.error("[rdfManager] removeQuadsByNamespace failed", err);
    });
  }

  async renameNamespaceUri(oldUri: string, newUri: string): Promise<void> {
    const allNamespaceUris = this.namespaces.map(e => e.uri).filter(Boolean);
    await this.worker.call("renameNamespaceUri", { oldUri, newUri, allNamespaceUris });
    this.namespaces = this.namespaces.map(e =>
      e.uri === oldUri ? { ...e, uri: newUri } : e,
    );
    this.notifyNamespacesChanged();
    void this.emitAllSubjects().catch(() => {});
  }

  async sparqlQuery(sparql: string, options?: { graphName?: string; limit?: number }): Promise<any> {
    return this.worker.call("sparqlQuery", { sparql, graphName: options?.graphName, limit: options?.limit });
  }

  async removeAllQuadsForIri(
    iri: string,
    graphName: string = DEFAULT_GRAPH,
  ): Promise<void> {
    if (!iri) return;
    await this.worker.call("syncRemoveAllQuadsForIri", {
      iri,
      graphName,
    });
  }

  async getGraphCounts(): Promise<Record<string, number>> {
    const counts = await this.worker.call("getGraphCounts");
    return isPlainObject(counts) ? (counts as Record<string, number>) : {};
  }

  async getOntologyStats(): Promise<{
    totalTriples: number;
    classCount: number;
    objectPropertyCount: number;
    datatypePropertyCount: number;
    namedIndividualCount: number;
    subjectCount: number;
    labeledClassCount: number;
    assertedTriples: number;
    inferredTriples: number;
    namespaceBreakdown: Array<{ prefix: string; uri: string; subjects: number }>;
  }> {
    const result = await this.worker.call("getOntologyStats");
    const safe = isPlainObject(result) ? (result as Record<string, unknown>) : {};
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      totalTriples: num(safe.totalTriples),
      classCount: num(safe.classCount),
      objectPropertyCount: num(safe.objectPropertyCount),
      datatypePropertyCount: num(safe.datatypePropertyCount),
      namedIndividualCount: num(safe.namedIndividualCount),
      subjectCount: num(safe.subjectCount),
      labeledClassCount: num(safe.labeledClassCount),
      assertedTriples: num(safe.assertedTriples),
      inferredTriples: num(safe.inferredTriples),
      namespaceBreakdown: Array.isArray(safe.namespaceBreakdown)
        ? (safe.namespaceBreakdown as Array<{ prefix: string; uri: string; subjects: number }>)
        : [],
    };
  }

  async fetchQuadsPage(options: {
    graphName: string;
    offset?: number;
    limit?: number;
    filter?: { subject?: string; predicate?: string; object?: string };
    serialize?: boolean;
  }): Promise<any> {
    const payload: RDFWorkerCommandPayloads["fetchQuadsPage"] = {
      graphName: options.graphName || DEFAULT_GRAPH,
      offset: typeof options.offset === "number" ? options.offset : 0,
      limit: typeof options.limit === "number" ? options.limit : 0,
      serialize: options.serialize !== false,
      filter: options.filter,
    };
    return this.worker.call("fetchQuadsPage", payload);
  }

  async emitAllSubjects(graphName: string = DEFAULT_GRAPH): Promise<void> {
    await this.worker.call("emitAllSubjects", { graphName });
  }

  updateNode(entityUri: string, updates: any): void {
    if (!entityUri || !updates) return;
    const adds: any[] = Array.isArray(updates.adds) ? updates.adds : [];
    const removes: any[] = Array.isArray(updates.removes) ? updates.removes : [];
    void this.applyBatch({ adds, removes }, DEFAULT_GRAPH);
  }

  addTriple(subject: any, predicate: any, object: any, graphName: string = DEFAULT_GRAPH): void {
    const subjectTerm = toWorkerSubjectTerm(subject);
    const predicateTerm = toWorkerPredicateTerm(predicate);
    const objectTerm = toWorkerObjectTerm(object);
    if (!subjectTerm || !predicateTerm || !objectTerm) return;
    const graphTerm = toWorkerGraphTerm(graphName, graphName);
    const payload: RDFWorkerCommandPayloads["syncBatch"] = {
      graphName,
      adds: [
        {
          subject: subjectTerm,
          predicate: predicateTerm,
          object: objectTerm,
          graph: graphTerm,
        },
      ],
      removes: [],
    };
    void this.worker.call("syncBatch", payload).catch((err) => {
      console.error("[rdfManager] addTriple failed", err);
    });
  }

  removeTriple(subject: any, predicate: any, object: any, graphName: string = DEFAULT_GRAPH): void {
    const subjectTerm = toWorkerSubjectTerm(subject);
    const predicateTerm = toWorkerPredicateTerm(predicate);
    if (!subjectTerm || !predicateTerm) return;
    const update: WorkerQuadUpdate = {
      subject: subjectTerm,
      predicate: predicateTerm,
      graph: toWorkerGraphTerm(graphName, graphName),
    };
    const objectTerm = toWorkerObjectTerm(object);
    if (objectTerm) {
      update.object = objectTerm;
    }
    const payload: RDFWorkerCommandPayloads["syncBatch"] = {
      graphName,
      adds: [],
      removes: [update],
    };
    void this.worker.call("syncBatch", payload).catch((err) => {
      console.error("[rdfManager] removeTriple failed", err);
    });
  }

  async applyBatch(
    changes: { adds?: any[]; removes?: any[]; options?: { suppressSubjects?: boolean } },
    graphName: string = DEFAULT_GRAPH,
  ): Promise<{ added: number; removed: number }> {
    const payload: RDFWorkerCommandPayloads["syncBatch"] = {
      graphName,
      adds: [],
      removes: [],
    };

    if (Array.isArray(changes?.adds)) {
      for (const entry of changes.adds) {
        try {
          const subject = toWorkerSubjectTerm(entry?.subject ?? entry?.s);
          const predicate = toWorkerPredicateTerm(entry?.predicate ?? entry?.p);
          const object = toWorkerObjectTerm(entry?.object ?? entry?.o ?? entry?.value);
          if (!subject || !predicate || !object) continue;
          payload.adds.push({
            subject,
            predicate,
            object,
            graph: toWorkerGraphTerm(entry?.graph ?? entry?.g, graphName),
          });
        } catch (err) {
          console.error("[rdfManager] applyBatch.add failed", err);
        }
      }
    }

    if (Array.isArray(changes?.removes)) {
      for (const entry of changes.removes) {
        try {
          const subject = toWorkerSubjectTerm(entry?.subject ?? entry?.s);
          const predicate = toWorkerPredicateTerm(entry?.predicate ?? entry?.p);
          if (!subject || !predicate) continue;
          const removal: WorkerQuadUpdate = {
            subject,
            predicate,
            graph: toWorkerGraphTerm(entry?.graph ?? entry?.g, graphName),
          };
          const objectSource = entry?.object ?? entry?.o ?? entry?.value;
          const object = toWorkerObjectTerm(objectSource);
          if (object) removal.object = object;
          payload.removes.push(removal);
        } catch (err) {
          console.error("[rdfManager] applyBatch.remove failed", err);
        }
      }
    }

    if (changes?.options && typeof changes.options === "object") {
      payload.options = {
        suppressSubjects: changes.options.suppressSubjects === true,
      };
    }

    // The worker's syncBatch returns the ACTUAL number of quads added/removed
    // from the store (after match resolution and de-duplication). Surfacing
    // these real deltas lets callers (e.g. provenance revert) report honest
    // partial outcomes instead of assuming the requested counts were applied.
    const delta = (await this.worker.call("syncBatch", payload)) as
      | { added?: number; removed?: number }
      | undefined;
    return {
      added: typeof delta?.added === "number" ? delta.added : 0,
      removed: typeof delta?.removed === "number" ? delta.removed : 0,
    };
  }

  clear(): void {
    void this.worker.call("clear").catch((err) => {
      console.error("[rdfManager] clear failed", err);
    });
  }

  removeGraph(graphName: string): void {
    if (!graphName) return;
    void this.worker.call("syncRemoveGraph", { graphName }).catch((err) => {
      console.error("[rdfManager] removeGraph failed", err);
    });
  }

  async removeGraphAsync(graphName: string): Promise<void> {
    if (!graphName) return;
    await this.worker.call("syncRemoveGraph", { graphName });
  }

  getNamespaces(): NamespaceEntry[] {
    return [...this.namespaces];
  }

  setNamespaces(namespaces: Record<string, string>, options?: { replace?: boolean }): void {
    const replace = options?.replace === true;
    const normalized = ensureDefaultNamespaceMap(namespaces);
    if (replace) {
      this.namespaces = recordToEntries(normalized);
    } else {
      const record = { ...entriesToRecord(this.namespaces), ...normalized };
      this.namespaces = recordToEntries(ensureDefaultNamespaceMap(record));
    }
    const payloadNamespaces = replace ? entriesToRecord(this.namespaces) : normalized;
    void this.worker.call("setNamespaces", { namespaces: { ...payloadNamespaces }, replace }).catch((err) => {
      console.error("[rdfManager] setNamespaces failed", err);
    });
    this.notifyNamespacesChanged();
  }

  addNamespace(prefix: string, uri: string): void {
    if (prefix === null || typeof prefix === "undefined") return;
    if (typeof uri !== "string" || !uri) return;
    const idx = this.namespaces.findIndex(e => e.prefix === prefix);
    if (idx >= 0) {
      this.namespaces[idx] = { prefix, uri };
    } else {
      this.namespaces.push({ prefix, uri });
    }
    this.pushNamespacesToWorker();
    this.notifyNamespacesChanged();
    void this.emitAllSubjects().catch(() => {});
  }

  removeNamespace(prefix: string): void {
    if (prefix === null || typeof prefix === "undefined") return;
    const before = this.namespaces.length;
    this.namespaces = this.namespaces.filter(e => e.prefix !== prefix);
    if (this.namespaces.length !== before) {
      this.pushNamespacesToWorker();
      this.notifyNamespacesChanged();
      void this.emitAllSubjects().catch(() => {});
    }
  }

  removeNamespaceAndQuads(prefixOrUri: string): void {
    if (!prefixOrUri) return;
    const payload: PurgeNamespacePayload = { prefixOrUri };
    void this.worker.call("purgeNamespace", payload).catch((err) => {
      console.error("[rdfManager] purgeNamespace failed", err);
    });
  }

  async exportToTurtle(graphName: string = DEFAULT_GRAPH): Promise<string> {
    const payload: ExportGraphPayload = {
      graphName,
      format: "text/turtle",
    };
    const response = await this.worker.call("exportGraph", payload);
    if (isPlainObject(response) && typeof (response as any).content === "string") {
      return (response as any).content;
    }
    return "";
  }

  async exportToJsonLD(graphName: string = DEFAULT_GRAPH): Promise<string> {
    const payload: ExportGraphPayload = {
      graphName,
      format: "application/ld+json",
    };
    const response = await this.worker.call("exportGraph", payload);
    if (isPlainObject(response) && typeof (response as any).content === "string") {
      return (response as any).content;
    }
    return "";
  }

  async exportToRdfXml(graphName: string = DEFAULT_GRAPH): Promise<string> {
    const payload: ExportGraphPayload = {
      graphName,
      format: "application/rdf+xml",
    };
    const response = await this.worker.call("exportGraph", payload);
    if (isPlainObject(response) && typeof (response as any).content === "string") {
      return (response as any).content;
    }
    return "";
  }

  /**
   * Dataset-faithful export as N-Quads. Unlike the single-graph Turtle/JSON-LD/RDF-XML
   * exporters, this collects quads from ALL urn:vg:* graphs (data, inferred, shapes,
   * ontologies, workflows) and preserves each quad's graph term so the multi-graph
   * partition round-trips. The `graphName` argument is ignored for dataset formats; it
   * is accepted only for signature symmetry with the other exporters.
   */
  async exportToNQuads(_graphName: string = DEFAULT_GRAPH): Promise<string> {
    const payload: ExportGraphPayload = {
      format: "application/n-quads",
    };
    const response = await this.worker.call("exportGraph", payload);
    if (isPlainObject(response) && typeof (response as any).content === "string") {
      return (response as any).content;
    }
    return "";
  }

  /**
   * Dataset-faithful export as TriG. Same multi-graph semantics as {@link exportToNQuads}
   * but with the more human-readable TriG syntax (prefixes + grouped GRAPH blocks).
   */
  async exportToTriG(_graphName: string = DEFAULT_GRAPH): Promise<string> {
    const payload: ExportGraphPayload = {
      format: "application/trig",
    };
    const response = await this.worker.call("exportGraph", payload);
    if (isPlainObject(response) && typeof (response as any).content === "string") {
      return (response as any).content;
    }
    return "";
  }

  /**
   * Produce the W3C RDFC-1.0 canonical N-Quads form + a content hash of the
   * graph. Per the W3C "RDF Dataset Canonicalization" Recommendation (RDFC-1.0,
   * 2024-05-21, https://www.w3.org/TR/rdf-canon/) the output is invariant under
   * blank-node relabelling and triple reordering, so two isomorphic graphs share
   * one canonical form and one hash — the basis for reproducible snapshots,
   * deterministic diffs, and content-addressable dataset identity.
   *
   * Quads are gathered from the dataset-faithful N-Quads export (all urn:vg:*
   * graphs) and re-parsed client-side with N3 — zero-backend, no network.
   *   • opts.graph        — restrict to one named graph (e.g. "urn:vg:data").
   *                         Omit to canonicalize the whole dataset.
   *   • opts.includeInferred — when no specific graph is requested, include the
   *                         urn:vg:inferred graph (default false: asserted-only).
   *   • opts.algorithm    — digest for the content hash (default 'SHA-256').
   */
  async canonicalize(opts?: {
    graph?: string;
    includeInferred?: boolean;
    algorithm?: CanonicalHashAlgorithm;
  }): Promise<{ canonical: string; hash: string; quadCount: number }> {
    const graph = opts?.graph;
    const includeInferred = opts?.includeInferred === true;
    const algorithm: CanonicalHashAlgorithm = opts?.algorithm ?? "SHA-256";

    // Dataset-faithful N-Quads carry every quad's graph term, so the multi-graph
    // partition survives the round-trip and named graphs are canonicalized too.
    const nquads = await this.exportToNQuads();
    const parser = new N3Parser({ format: "application/n-quads" });
    const allQuads = parser.parse(nquads);

    const quads = allQuads.filter((q) => {
      const g = q.graph && q.graph.termType !== "DefaultGraph" ? q.graph.value : "";
      if (graph) return g === graph;
      // No explicit graph: include everything except inferred unless asked.
      if (!includeInferred && g === "urn:vg:inferred") return false;
      return true;
    });

    const canonical = await canonicalizeQuads(quads);
    const hash = await canonicalHash(quads, algorithm);
    return { canonical, hash, quadCount: quads.length };
  }

  dispose(): void {
    if (this.workerChangeUnsub) {
      try {
        this.workerChangeUnsub();
      } catch (err) {
        console.debug("[rdfManager] change unsub failed", err);
      }
      this.workerChangeUnsub = null;
    }
    if (this.workerSubjectsUnsub) {
      try {
        this.workerSubjectsUnsub();
      } catch (err) {
        console.debug("[rdfManager] subjects unsub failed", err);
      }
      this.workerSubjectsUnsub = null;
    }
  }
}
