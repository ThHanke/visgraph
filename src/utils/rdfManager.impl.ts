import type {
  ReasoningError,
  ReasoningInference,
  ReasoningResult,
  ReasoningWarning,
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
import { useOntologyStore } from "../stores/ontologyStore";
import { useAppConfigStore } from "../stores/appConfigStore";
import { ensureDefaultNamespaceMap } from "../constants/namespaces";

type ChangeSubscriber = (count: number, meta?: unknown) => void;
type SubjectsSubscriber = (
  subjects: string[],
  quads?: WorkerQuad[],
  snapshot?: WorkerReconcileSubjectSnapshotPayload[],
  meta?: Record<string, unknown> | null,
) => void;

const DEFAULT_GRAPH = "urn:vg:data";
const IRI_REGEX = /^[a-z][a-z0-9+.-]*:/i;

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

  if (isRdfTerm(value)) {
    try {
      return normalizeWorkerTerm(serializeTerm(value as any), context);
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

const workerQuadToFatEntry = (quad: WorkerQuad) => {
  return {
    subject: {
      termType: quad.subject.termType,
      value: quad.subject.value,
    },
    predicate: {
      termType: quad.predicate.termType,
      value: quad.predicate.value,
    },
    object: (() => {
      if (quad.object.termType === "Literal") {
        return {
          termType: "Literal",
          value: quad.object.value,
          datatype: quad.object.datatype,
          language: quad.object.language,
        };
      }
      return {
        termType: quad.object.termType,
        value: quad.object.value,
      };
    })(),
    graph: quad.graph,
  };
};

export class RDFManagerImpl {
  private worker: RdfManagerWorkerClient;
  private changeSubscribers = new Set<ChangeSubscriber>();
  private subjectsSubscribers = new Set<SubjectsSubscriber>();
  private changeCount = 0;
  private reconcileInProgress: Promise<void> | null = null;
  private namespaces: Record<string, string> = ensureDefaultNamespaceMap({});
  private blacklistPrefixes: Set<string> = new Set(DEFAULT_BLACKLIST_PREFIXES);
  private blacklistUris: string[] = [...DEFAULT_BLACKLIST_URIS];
  private workerChangeUnsub: (() => void) | null = null;
  private workerSubjectsUnsub: (() => void) | null = null;

  constructor(options?: { workerClient?: RdfManagerWorkerClient }) {
    this.worker = options?.workerClient ?? createRdfManagerWorkerClient();
    this.workerChangeUnsub = this.worker.on("change", this.handleWorkerChange);
    this.workerSubjectsUnsub = this.worker.on("subjects", this.handleWorkerSubjects);
    void this.bootstrapState();
  }

  private async bootstrapState() {
    try {
      const namespaces = await this.worker.call("getNamespaces");
      if (isStringRecord(namespaces)) {
        this.namespaces = ensureDefaultNamespaceMap(namespaces as Record<string, string>);
      }
    } catch (err) {
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

    let reconcilePromise: Promise<void> | undefined;
    if (snapshot.length > 0) {
      reconcilePromise = this.runReconcile(undefined, snapshot);
    } else if (quads.length > 0) {
      reconcilePromise = this.runReconcile(quads);
    } else {
      reconcilePromise = this.runReconcile();
    }

    const finalize = () =>
      this.notifySubjectSubscribers(subjects, quads, snapshot, meta);
    if (reconcilePromise) {
      reconcilePromise.then(finalize, (err) => {
        console.error("[rdfManager] reconcile during subjects event failed", err);
        finalize();
      });
    } else {
      finalize();
    }
  };

  private async runReconcile(
    quads?: WorkerQuad[],
    snapshot?: WorkerReconcileSubjectSnapshotPayload[],
  ): Promise<void> {
    const perform = async () => {
      try {
        const os = (useOntologyStore as any)?.getState?.();
        if (!os) return;
        if (snapshot && snapshot.length > 0 && typeof os.updateFatMapFromWorker === "function") {
          await os.updateFatMapFromWorker(snapshot);
          return;
        }
        if (Array.isArray(quads) && quads.length > 0) {
          const converted = quads.map(workerQuadToFatEntry);
          if (typeof os.updateFatMap === "function") {
            await os.updateFatMap(converted);
          }
          return;
        }
        if (typeof os.updateFatMap === "function") {
          await os.updateFatMap();
        }
      } catch (err) {
        console.error("[rdfManager] runReconcile failed", err);
      } finally {
        this.reconcileInProgress = null;
      }
    };

    if (this.reconcileInProgress) {
      this.reconcileInProgress = this.reconcileInProgress.then(() => perform());
      return this.reconcileInProgress;
    }

    this.reconcileInProgress = perform();
    return this.reconcileInProgress;
  }

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

  async triggerSubjectUpdate(subjectIris: string[]): Promise<void> {
    if (!Array.isArray(subjectIris) || subjectIris.length === 0) return;
    const subjects = subjectIris.map((s) => String(s)).filter(Boolean);
    if (subjects.length === 0) return;
    await this.worker.call("triggerSubjects", { subjects });
  }

  async runReasoning(options?: { rulesets?: string[] }): Promise<ReasoningResult> {
    const reasoningId = `reasoning-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const rulesets = Array.isArray(options?.rulesets)
      ? options!.rulesets.map((r) => String(r)).filter(Boolean)
      : [];
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

    const payload = {
      reasoningId,
      rulesets,
      emitSubjects: true,
      baseUrl: resolveBaseUrl(),
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
      meta: {
        usedReasoner: !!safe.usedReasoner,
        workerDurationMs: typeof safe.workerDurationMs === "number" ? safe.workerDurationMs : undefined,
        totalDurationMs: typeof safe.durationMs === "number" ? safe.durationMs : undefined,
        addedCount: typeof safe.addedCount === "number" ? safe.addedCount : undefined,
        ruleQuadCount: typeof safe.ruleQuadCount === "number" ? safe.ruleQuadCount : undefined,
      },
    };
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
      if (!this.namespaces[prefix] || this.namespaces[prefix] !== uri) {
        this.namespaces[prefix] = uri;
        changed = true;
      }
    }
    if (changed) {
      this.namespaces = ensureDefaultNamespaceMap(this.namespaces);
      const appConfig = (useAppConfigStore as any)?.getState?.();
      if (appConfig && typeof appConfig.setConfig === "function") {
        try {
          appConfig.setConfig({
            rdfNamespaces: { ...this.namespaces },
          });
        } catch (err) {
          console.debug("[rdfManager] persist namespaces failed", err);
        }
      }
    }
  }

  async loadRDFIntoGraph(
    rdfContent: string,
    graphName?: string,
    mimeType?: string,
    filename?: string,
  ): Promise<void> {
    if (typeof rdfContent !== "string" || rdfContent.trim().length === 0) {
      throw new Error("Empty RDF content provided to loadRDFIntoGraph");
    }
    const payload: ImportSerializedPayload = {
      content: rdfContent,
      graphName: graphName || DEFAULT_GRAPH,
      contentType: mimeType,
      filename,
    };
    const result = await this.worker.call("importSerialized", payload);
    if (isPlainObject(result)) {
      if (result && isStringRecord(result.prefixes)) {
        this.mergePrefixes(
          result.prefixes as Record<string, string>,
          payload.graphName,
        );
      }
      if (Array.isArray((result as any).quads)) {
        const quads = ((result as any).quads as WorkerQuad[]).filter(isWorkerQuad);
        if (quads.length > 0) {
          await this.runReconcile(quads);
        }
      }
    }
  }

  async loadRDFFromUrl(
    url: string,
    graphName?: string,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    if (!url) throw new Error("loadRDFFromUrl requires a url");
    const timeoutMs = options?.timeoutMs ?? 120000;
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Failed to fetch RDF: ${response.status}`);
      }
      const text = await response.text();
      const contentTypeHeader = response.headers.get("content-type");
      const inferredContentType = inferRdfMediaType(contentTypeHeader, url, text);
      await this.loadRDFIntoGraph(text, graphName || DEFAULT_GRAPH, inferredContentType, url);
    } finally {
      clearTimeout(timeoutHandle);
    }
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
  ): Promise<void> {
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

    await this.worker.call("syncBatch", payload);
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

  getNamespaces(): Record<string, string> {
    this.namespaces = ensureDefaultNamespaceMap(this.namespaces);
    return { ...this.namespaces };
  }

  setNamespaces(namespaces: Record<string, string>, options?: { replace?: boolean }): void {
    const replace = options?.replace === true;
    const normalized = ensureDefaultNamespaceMap(namespaces);
    if (replace) {
      this.namespaces = { ...normalized };
    } else {
      this.namespaces = ensureDefaultNamespaceMap({ ...this.namespaces, ...normalized });
    }
    const payloadNamespaces = replace ? this.namespaces : normalized;
    void this.worker.call("setNamespaces", { namespaces: { ...payloadNamespaces }, replace }).catch((err) => {
      console.error("[rdfManager] setNamespaces failed", err);
    });
  }

  addNamespace(prefix: string, uri: any): void {
    if (prefix === null || typeof prefix === "undefined") return;
    const term = toWorkerObjectTerm(uri);
    if (!term || term.termType !== "NamedNode") return;
    this.namespaces = ensureDefaultNamespaceMap({
      ...this.namespaces,
      [prefix]: term.value || "",
    });
    this.setNamespaces(this.namespaces, { replace: true });
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
