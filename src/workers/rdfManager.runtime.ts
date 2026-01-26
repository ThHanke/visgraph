import { Readable } from "readable-stream";
import { Buffer } from "buffer";
import rdfParsePkg from "rdf-parse";
import * as N3 from "n3";
import { Reasoner as N3ReasonerExplicit } from "n3";
import type { Quad } from "@rdfjs/types";
import { assertRdfWorkerInbound } from "../utils/rdfManager.workerProtocol.ts";
import type {
  RDFWorkerCommand,
  RDFWorkerCommandPayloads,
  RDFWorkerLoadCompleteMessage,
  RDFWorkerLoadFromUrlMessage,
  RDFWorkerRunReasoningMessage,
  ExportGraphPayload,
  ImportSerializedPayload,
  PurgeNamespacePayload,
  RemoveQuadsByNamespacePayload,
  WorkerReconcileSubjectSnapshotPayload,
} from "../utils/rdfManager.workerProtocol.ts";
import type { ReasoningResult } from "../utils/reasoningTypes.ts";
import { deserializeQuad, deserializeTerm, serializeQuad } from "../utils/rdfSerialization.ts";
import type { WorkerQuad } from "../utils/rdfSerialization.ts";
import { WELL_KNOWN } from "../utils/wellKnownOntologies.ts";
import { ensureDefaultNamespaceMap } from "../constants/namespaces.ts";
import { RDF_TYPE, RDFS_LABEL, SHACL } from "../constants/vocabularies.ts";

const BATCH_SIZE = 1000;
const RDF_TYPE_IRI = RDF_TYPE;
const RDFS_LABEL_IRI = RDFS_LABEL;

/**
 * Create a graph term from a graph name string.
 * Returns defaultGraph() for "default" or null/undefined, otherwise creates a namedNode.
 */
function createGraphTerm(graphName: string | null | undefined, DataFactory: any): any {
  return graphName && graphName !== "default"
    ? DataFactory.namedNode(String(graphName))
    : DataFactory.defaultGraph();
}

type SubjectQuadMap = Record<string, WorkerQuad[]>;

type ReasoningStageMessage = {
  type: "reasoningStage";
  id: string;
  stage: string;
  meta?: Record<string, unknown>;
};

type ReasoningWarning = {
  nodeId?: string;
  edgeId?: string;
  message: string;
  rule: string;
  severity?: "critical" | "warning" | "info";
};

type ReasoningError = {
  nodeId?: string;
  edgeId?: string;
  message: string;
  rule: string;
  severity: "critical" | "error";
};

type ReasoningInference = {
  type: "property" | "class" | "relationship";
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
};

type ReasoningResultMessage = {
  type: "reasoningResult";
  id: string;
  durationMs: number;
  startedAt: number;
  added?: WorkerQuad[];
  addedCount: number;
  warnings: ReasoningWarning[];
  errors: ReasoningError[];
  inferences: ReasoningInference[];
  usedReasoner: boolean;
  workerDurationMs?: number;
  ruleQuadCount?: number;
};

type ReasoningErrorMessage = {
  type: "reasoningError";
  id: string;
  message: string;
  stack?: string;
};

type RunReasoningOptions = {
  mutateSharedStore?: boolean;
  includeAdded?: boolean;
  emitSubjects?: boolean;
  emitChange?: boolean;
  emitResultEvent?: boolean;
};

export interface RdfWorkerRuntime {
  handleEvent: (message: unknown) => void;
  terminate: () => void;
}

export function createRdfWorkerRuntime(postMessage: (message: unknown) => void): RdfWorkerRuntime {
  (globalThis as any).Buffer = Buffer;

  const pendingAcks = new Map<string, boolean>();

  let sharedStore: any | null = null;
  let workerNamespaces: Record<string, string> = {};
  let workerBlacklistPrefixes: Set<string> = new Set(["owl", "rdf", "rdfs", "xml", "xsd"]);
  let workerBlacklistUris: string[] = [
    "http://www.w3.org/2002/07/owl",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "http://www.w3.org/2000/01/rdf-schema#",
    "http://www.w3.org/XML/1998/namespace",
    "http://www.w3.org/2001/XMLSchema#",
  ];
  let workerChangeCounter = 0;

  function resetSharedStore() {
    const { StoreCls } = resolveN3();
    if (!StoreCls) throw new Error("n3-store-unavailable");
    sharedStore = new (StoreCls as any)();
    workerChangeCounter = 0;
    return sharedStore;
  }

  function getSharedStore() {
    if (sharedStore) return sharedStore;
    return resetSharedStore();
  }

  function handleInbound(incoming: unknown) {
    if (!incoming) return;

    try {
      assertRdfWorkerInbound(incoming);
    } catch (err) {
      console.error("[rdfManager.worker] received malformed message", err);
      return;
    }

    switch (incoming.type) {
      case "command":
        void handleCommand(incoming);
        return;
      case "ack":
        pendingAcks.set(String(incoming.id), true);
        return;
      case "loadFromUrl":
        void handleLoad(incoming).catch((err) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          post({ type: "error", id: incoming.id, message: errorMessage });
        });
        return;
      case "runReasoning": {
        const hasExternalQuads = Array.isArray(incoming.quads) && incoming.quads.length > 0;
        handleRunReasoning(incoming, {
          mutateSharedStore: !hasExternalQuads,
          includeAdded: hasExternalQuads,
          emitSubjects: !hasExternalQuads,
          emitChange: !hasExternalQuads,
          emitResultEvent: false,
        })
          .then((result) => {
            post(result);
          })
          .catch((err) => {
            const errorMessage: ReasoningErrorMessage = {
              type: "reasoningError",
              id: incoming.id,
              message: String((err as Error).message || err),
              stack: err instanceof Error && err.stack ? err.stack : undefined,
            };
            post(errorMessage);
          });
        return;
      }
      case "subscribe":
      case "unsubscribe":
        // Subscriptions are managed on the main thread; worker broadcasts to all listeners.
        return;
      default:
        console.warn("[rdfManager.worker] Unhandled message type", incoming);
    }
  }

  function post(message: any) {
    postMessage(message);
  }

  function waitForAck(id: string) {
    return new Promise<void>((resolve) => {
      const key = String(id);
      const check = () => {
        if (pendingAcks.get(key)) {
          pendingAcks.delete(key);
          resolve();
          return;
        }
        setTimeout(check, 10);
      };
      check();
    });
  }

  function reasoningStage(message: ReasoningStageMessage) {
    try {
      post(message);
    } catch (err) {
      console.debug("[rdfManager.worker] reasoningStage emission skipped", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  let lastChangeMeta: Record<string, unknown> | null = null;

  function emitChange(meta?: Record<string, unknown> | null) {
    try {
      lastChangeMeta = meta ? { ...meta } : null;
      workerChangeCounter += 1;
      post({
        type: "event",
        event: "change",
        payload: { changeCount: workerChangeCounter, meta: meta || null },
      });
    } catch (err) {
      console.error("[rdfManager.worker] emitChange failed", err);
    }
  }

  function emitSubjects(
    subjects: string[],
    quadsBySubject?: SubjectQuadMap,
    snapshot?: WorkerReconcileSubjectSnapshotPayload[],
    meta?: Record<string, unknown> | null,
  ) {
    const effectiveMeta =
      typeof meta === "undefined" ? lastChangeMeta : meta;
    lastChangeMeta = null;
    const serialisedMeta =
      effectiveMeta && typeof effectiveMeta === "object"
        ? { ...effectiveMeta }
        : effectiveMeta ?? null;
    try {
      post({
        type: "event",
        event: "subjects",
        payload: {
          subjects,
          quads:
            quadsBySubject && Object.keys(quadsBySubject).length > 0
              ? quadsBySubject
              : undefined,
          snapshot:
            snapshot && snapshot.length > 0
              ? snapshot
              : undefined,
          meta: serialisedMeta,
        },
      });
    } catch (err) {
      console.error("[rdfManager.worker] emitSubjects failed", err);
    }
  }

  function resolveN3() {
    const mod: any = N3;
    const root = mod && mod.default ? mod.default : mod;
    const DataFactory = (root && root.DataFactory) ? root.DataFactory : null;
    const StoreCls = (root && root.Store) ? root.Store : null;
    const ParserCls = (root && root.Parser) ? root.Parser : null;
    const ReasonerCls =
      (root && root.Reasoner) ||
      (root && root.N3Reasoner) ||
      (root && root.default && (root.default.Reasoner || root.default.N3Reasoner)) ||
      N3ReasonerExplicit ||
      null;
    return { DataFactory, StoreCls, ParserCls, ReasonerCls };
  }

  function quadKeyFromTerms(q: any): string {
    try {
      const s = q.subject && q.subject.value ? String(q.subject.value) : "";
      const p = q.predicate && q.predicate.value ? String(q.predicate.value) : "";
      const o = q.object && q.object.value ? String(q.object.value) : "";
      const g = q.graph && q.graph.value ? String(q.graph.value) : "";
      return `${s}|${p}|${o}|${g}`;
    } catch (_) {
      return Math.random().toString(36).slice(2);
    }
  }

  function subjectTermToString(term: any, fallback?: string): string {
    try {
      if (!term) return fallback || "";
      const value = term.value ?? "";
      if (term.termType === "BlankNode") {
        return `_:${String(value)}`;
      }
      return String(value || "");
    } catch (_) {
      return fallback || "";
    }
  }

  function collectWorkerQuadsForSubject(subject: string, store: any, DataFactory: any): WorkerQuad[] {
    try {
      const term =
        /^_:/i.test(String(subject))
          ? DataFactory.blankNode(String(subject).replace(/^_:/, ""))
          : DataFactory.namedNode(String(subject));
      const quads = store.getQuads(term, null, null, null) || [];
      const out: WorkerQuad[] = [];
      for (const q of quads) {
        try {
          out.push(serializeQuad(q));
        } catch (err) {
          console.error("[rdfManager.worker] collectWorkerQuadsForSubject serialize failed", err);
        }
      }
      return out;
    } catch (err) {
      console.error("[rdfManager.worker] collectWorkerQuadsForSubject failed", err);
      return [];
    }
  }

  function snapshotEntryFromQuads(
    subject: string,
    quads: WorkerQuad[] | undefined,
  ): WorkerReconcileSubjectSnapshotPayload | null {
    const iri = String(subject || "").trim();
    if (!iri) return null;
    const types = new Set<string>();
    let label: string | undefined;
    for (const quad of quads || []) {
      if (!quad || !quad.predicate) continue;
      const predicate = String(quad.predicate.value || "");
      if (!predicate) continue;
      if (predicate === RDF_TYPE_IRI && quad.object) {
        const objectValue = String((quad.object as any).value || "");
        if (objectValue) types.add(objectValue);
        continue;
      }
      if (!label && predicate === RDFS_LABEL_IRI && quad.object) {
        const term = quad.object as any;
        if (typeof term.value === "string" && term.value.trim().length > 0) {
          label = term.value;
        }
      }
    }
    return {
      iri,
      types: Array.from(types),
      ...(label ? { label } : {}),
    };
  }

  function termToString(term: any): string {
    try {
      if (!term) return "";
      if (term.termType === "BlankNode") {
        return `_:${String(term.value || "")}`;
      }
      if (term.termType === "Literal") {
        return String(term.value || "");
      }
      if (term.termType === "NamedNode") {
        return String(term.value || "");
      }
      if (typeof term === "object" && term.value) {
        return String(term.value);
      }
      return String(term);
    } catch (_) {
      return "";
    }
  }

  type ReasonerInsertion = {
    subject: unknown;
    predicate: unknown;
    object: unknown;
    graphKey?: string;
  };

  function ensureGraphKeyInStore(store: any, graphTerm: any): string | undefined {
    try {
      if (!store) return undefined;
      let graphId =
        typeof store._termToNumericId === "function" ? store._termToNumericId(graphTerm) : undefined;
      if (!graphId && typeof store._termToNewNumericId === "function") {
        graphId = store._termToNewNumericId(graphTerm);
      }
      if (graphId === undefined || graphId === null) return undefined;
      const key = String(graphId);
      if (store._graphs && !store._graphs[key]) {
        const graphItem = {
          subjects: Object.create(null),
          predicates: Object.create(null),
          objects: Object.create(null),
        };
        if (typeof Object.freeze === "function") Object.freeze(graphItem);
        store._graphs[key] = graphItem;
      }
      return key;
    } catch (_) {
      return undefined;
    }
  }

  function storeIdToTerm(store: any, id: unknown) {
    try {
      if (!store || !store._entities || typeof store._termFromId !== "function") return null;
      const candidates: Array<string | number> = [];
      if (typeof id === "number" || typeof id === "string") {
        candidates.push(id);
        if (typeof id === "number") candidates.push(String(id));
        else {
          const num = Number(id);
          if (!Number.isNaN(num)) candidates.push(num);
        }
      }
      for (const candidate of candidates) {
        if (candidate in store._entities) {
          const entity = store._entities[candidate];
          if (entity !== undefined) {
            return store._termFromId(entity);
          }
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  function attachReasonerAddInterceptor(reasoner: any, store: any) {
    if (!reasoner || typeof reasoner._add !== "function") {
      return () => [] as ReasonerInsertion[];
    }
    const originalAdd = reasoner._add.bind(reasoner);
    const insertions: ReasonerInsertion[] = [];
    const seen = new Set<string>();
    const graphItemToKey = new Map<any, string>();
    const resolveGraphKey = (graphItem: any) => {
      if (!graphItem || !store || !store._graphs) return undefined;
      if (graphItemToKey.has(graphItem)) return graphItemToKey.get(graphItem);
      for (const key in store._graphs) {
        if (store._graphs[key] === graphItem) {
          graphItemToKey.set(graphItem, key);
          return key;
        }
      }
      return undefined;
    };

    reasoner._add = (subject: unknown, predicate: unknown, object: unknown, graphItem: any, cb: () => void) => {
      originalAdd(subject, predicate, object, graphItem, () => {
        try {
          const graphKey = resolveGraphKey(graphItem);
          const dedupeKey = `${String(subject)}|${String(predicate)}|${String(object)}|${String(
            graphKey ?? "",
          )}`;
          if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            insertions.push({ subject, predicate, object, graphKey });
          }
        } catch (_) {
          /* ignore capture failures */
        }
        if (typeof cb === "function") cb();
      });
    };

    return () => insertions;
  }

  function isBlacklistedIri(iri: string): boolean {
    try {
      const value = String(iri || "").trim();
      if (!value) return false;
      if (value.startsWith("_:")) return false;

      if (!/^https?:\/\//i.test(value) && value.includes(":")) {
        const prefix = value.split(":", 1)[0];
        if (workerBlacklistPrefixes.has(prefix)) return true;
      }

      const candidates = new Set<string>();
      for (const uri of workerBlacklistUris) {
        if (uri) candidates.add(String(uri));
      }

      for (const prefix of Array.from(workerBlacklistPrefixes)) {
        const namespace = workerNamespaces[prefix];
        if (namespace) candidates.add(String(namespace));

        const wkPrefix = WELL_KNOWN?.prefixes?.[prefix];
        if (wkPrefix) candidates.add(String(wkPrefix));

        const ontologies = WELL_KNOWN?.ontologies ?? {};
        for (const [ontUrl, meta] of Object.entries(ontologies)) {
          const data = meta as { namespaces?: Record<string, string>; aliases?: string[] } | undefined;
          if (!data?.namespaces?.[prefix]) continue;
          candidates.add(String(ontUrl));
          if (Array.isArray(data.aliases)) {
            for (const alias of data.aliases) {
              if (alias) candidates.add(String(alias));
            }
          }
        }
      }

      const normalized = new Set<string>();
      for (const candidate of candidates) {
        const trimmed = String(candidate || "").trim();
        if (!trimmed) continue;
        normalized.add(trimmed);
        if (trimmed.endsWith("#")) normalized.add(trimmed.slice(0, -1));
        else normalized.add(`${trimmed}#`);
        if (trimmed.endsWith("/")) normalized.add(trimmed.slice(0, -1));
        else normalized.add(`${trimmed}/`);
      }

      for (const candidate of normalized) {
        if (candidate && value.startsWith(candidate)) return true;
      }
    } catch (err) {
      console.error("[rdfManager.worker] isBlacklistedIri failed", err);
    }
    return false;
  }

  function prepareSubjectEmissionFromSet(
    subjectSet: Set<string>,
    store: any,
    DataFactory: any,
  ): {
    subjects: string[];
    quadsBySubject: SubjectQuadMap;
    snapshot: WorkerReconcileSubjectSnapshotPayload[];
  } {
    const subjects: string[] = [];
    const quadsBySubject: SubjectQuadMap = {};
    const snapshot: WorkerReconcileSubjectSnapshotPayload[] = [];
    for (const raw of subjectSet) {
      try {
        const subject = String(raw || "").trim();
        if (!subject) continue;
        if (isBlacklistedIri(subject)) continue;
        subjects.push(subject);
        const quads = collectWorkerQuadsForSubject(subject, store, DataFactory);
        quadsBySubject[subject] = quads;
        const entry = snapshotEntryFromQuads(subject, quads);
        if (entry) snapshot.push(entry);
      } catch (err) {
        console.error("[rdfManager.worker] prepareSubjectEmissionFromSet item failed", err);
      }
    }
    return { subjects, quadsBySubject, snapshot };
  }

  function prepareSubjectEmissionFromQuads(quads: Quad[]): {
    subjects: string[];
    quadsBySubject: SubjectQuadMap;
    snapshot: WorkerReconcileSubjectSnapshotPayload[];
  } {
    const map = new Map<string, WorkerQuad[]>();
    for (const q of quads || []) {
      try {
        const subject = subjectTermToString(q.subject);
        if (!subject) continue;
        if (isBlacklistedIri(subject)) continue;
        const serialized = serializeQuad(q);
        if (!map.has(subject)) map.set(subject, []);
        map.get(subject)!.push(serialized);
      } catch (err) {
        console.error("[rdfManager.worker] prepareSubjectEmissionFromQuads item failed", err);
      }
    }
    const subjects = Array.from(map.keys());
    const quadsBySubject: SubjectQuadMap = {};
    for (const subject of subjects) {
      quadsBySubject[subject] = map.get(subject)!;
    }
    const snapshot: WorkerReconcileSubjectSnapshotPayload[] = [];
    for (const subject of subjects) {
      const entry = snapshotEntryFromQuads(subject, quadsBySubject[subject]);
      if (entry) snapshot.push(entry);
    }
    return { subjects, quadsBySubject, snapshot };
  }

  function collectShaclResults(all: Quad[]): { warnings: ReasoningWarning[]; errors: ReasoningError[] } {
    // Use imported constants from vocabularies.ts
    const SH_RESULT = SHACL.ValidationResult;
    const SH_FOCUS = SHACL.focusNode;
    const SH_MESSAGE = SHACL.resultMessage;
    const SH_SEVERITY = SHACL.resultSeverity;
    const SEVERITY_VIOLATION = SHACL.Violation;

    const bySubject = new Map<string, Quad[]>();
    for (const q of all) {
      const graphIri =
        q.graph && q.graph.termType !== "DefaultGraph" ? String(q.graph.value) : "";
      const key = `${graphIri}|${String(q.subject.value)}`;
      const existing = bySubject.get(key) || [];
      existing.push(q);
      bySubject.set(key, existing);
    }

    const warnings: ReasoningWarning[] = [];
    const errors: ReasoningError[] = [];

    for (const q of all) {
      if (q.predicate.value !== RDF_TYPE) continue;
      if (q.object.termType !== "NamedNode" || q.object.value !== SH_RESULT) continue;
      const graphIri =
        q.graph && q.graph.termType !== "DefaultGraph" ? String(q.graph.value) : "";
      const key = `${graphIri}|${String(q.subject.value)}`;
      const subjectQuads = bySubject.get(key) || [];
      
      // Find ALL focus nodes (N3 reasoner may create multiple sh:focusNode triples)
      const focusNodes = subjectQuads
        .filter((sq) => sq.predicate.value === SH_FOCUS)
        .map((sq) => termToString(sq.object))
        .filter(Boolean);
      
      const message = subjectQuads.find((sq) => sq.predicate.value === SH_MESSAGE);
      const severityQuad = subjectQuads.find((sq) => sq.predicate.value === SH_SEVERITY);

      const messageText = message ? termToString(message.object) || "Validation issue" : "Validation issue";
      const severityUri = severityQuad ? termToString(severityQuad.object) : "";
      const severity =
        severityUri && severityUri.includes("Violation") ? "critical" : "warning";
      
      // Create separate error/warning for each focus node
      for (const nodeId of focusNodes) {
        if (severity === "critical") {
          errors.push({
            nodeId,
            message: messageText,
            rule: "sh:ValidationResult",
            severity: "critical",
          });
        } else {
          warnings.push({
            nodeId,
            message: messageText,
            rule: "sh:ValidationResult",
            severity: severity === "warning" ? "warning" : "info",
          });
        }
      }
    }

    return { warnings, errors };
  }

  function collectGraphCountsFromStore(store: any): Record<string, number> {
    const counts: Record<string, number> = {};
    try {
      const quads = store.getQuads(null, null, null, null) || [];
      for (const q of quads) {
        const graphValue = q?.graph?.value;
        const graphName =
          typeof graphValue === "string" && graphValue.length > 0 ? graphValue : "urn:vg:default";
        counts[graphName] = (counts[graphName] || 0) + 1;
      }
    } catch (err) {
      console.debug("[VG_REASONING_WORKER] collectGraphCountsFromStore failed", err);
    }
    return counts;
  }

  function resolveRdfParser(pkg: any) {
    if (!pkg) return null;
    if (typeof pkg.parse === "function") return pkg;
    if (pkg.rdfParser && typeof pkg.rdfParser.parse === "function") return pkg.rdfParser;
    if (pkg.default && typeof pkg.default.parse === "function") return pkg.default;
    return null;
  }

  async function createReadable(resp: Response) {
    if ((Readable as any).fromWeb) {
      try {
        return (Readable as any).fromWeb(resp.body as any);
      } catch (_) {
        // fall through
      }
    }
    if (resp.body && typeof (resp.body as any).getReader === "function" && typeof (Readable as any).from === "function") {
      const reader = (resp.body as any).getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
      }
      const total = chunks.reduce((acc, c) => acc + c.length, 0);
      const buf = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        buf.set(c, offset);
        offset += c.length;
      }
      const BufferImpl = (globalThis as any).Buffer || Buffer;
      if (BufferImpl && typeof (Readable as any).from === "function") {
        return (Readable as any).from([BufferImpl.from(buf)]);
      }
    }
    const arr = await resp.arrayBuffer();
    const BufferImpl2 = (globalThis as any).Buffer || Buffer;
    if (BufferImpl2 && typeof (Readable as any).from === "function") {
      return (Readable as any).from([BufferImpl2.from(new Uint8Array(arr))]);
    }
    return null;
  }

  function createReadableFromString(content: string) {
    try {
      const text = typeof content === "string" ? content : String(content ?? "");
      const BufferImpl = (globalThis as any).Buffer || Buffer;
      if (typeof (Readable as any).from === "function" && BufferImpl) {
        return (Readable as any).from([BufferImpl.from(text)]);
      }
      const stream = new Readable();
      stream.push(BufferImpl ? BufferImpl.from(text) : text);
      stream.push(null);
      return stream;
    } catch (err) {
      console.debug("[rdfManager.worker] createReadableFromString failed", err);
      return null;
    }
  }

  function normalizeExportFormat(format?: string) {
    const raw = typeof format === "string" ? format.toLowerCase().trim() : "";
    if (raw === "application/ld+json" || raw === "ld+json" || raw === "jsonld" || raw === "json-ld") {
      return { writerFormat: "application/ld+json", mediaType: "application/ld+json", dropGraph: true };
    }
    if (raw === "application/rdf+xml" || raw === "rdfxml" || raw === "rdf+xml" || raw === "rdf-xml") {
      return { writerFormat: "application/rdf+xml", mediaType: "application/rdf+xml", dropGraph: true };
    }
    if (raw === "application/n-quads" || raw === "nquads" || raw === "n-quads") {
      return { writerFormat: "application/n-quads", mediaType: "application/n-quads", dropGraph: false };
    }
    return { writerFormat: "text/turtle", mediaType: "text/turtle", dropGraph: true };
  }

  async function handleLoad(msg: RDFWorkerLoadFromUrlMessage) {
    const { id, url } = msg;
    const timeoutMs = typeof msg.timeoutMs === "number" ? msg.timeoutMs : 15000;
    const targetGraphName =
      typeof msg.graphName === "string" && msg.graphName.length > 0
        ? msg.graphName
        : "urn:vg:data";

    post({ type: "stage", id, stage: "start", url });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers:
          msg.headers ||
          { Accept: "text/turtle, application/rdf+xml, application/ld+json, */*" },
      });
    } catch (err) {
      clearTimeout(timeout);
      post({ type: "error", id, message: String((err as Error).message || err) });
      return;
    }
    clearTimeout(timeout);
    post({ type: "stage", id, stage: "fetched", status: resp.status });

    const readable = await createReadable(resp.clone ? (resp.clone() as Response) : resp);
    if (!readable) {
      post({ type: "error", id, message: "node-readable-unavailable" });
      return;
    }

    let parserImpl = resolveRdfParser(rdfParsePkg);
    if (!parserImpl) {
      try {
        const dyn = await import("rdf-parse").catch(() => null);
        parserImpl = resolveRdfParser(dyn);
      } catch (_) {
        /* ignore */
      }
    }
    if (!parserImpl) {
      post({ type: "error", id, message: "rdf-parse-unavailable" });
      return;
    }

    const supportedMedia = new Set<string>();
    if (typeof parserImpl.getContentTypes === "function") {
      try {
        const types = await parserImpl.getContentTypes();
        if (Array.isArray(types)) {
          types.forEach((t: any) => {
            if (t) supportedMedia.add(String(t).split(";")[0].trim().toLowerCase());
          });
        }
      } catch (err) {
        post({
          type: "stage",
          id,
          stage: "getContentTypesFailed",
          error: String(err),
        });
      }
    }

    const contentTypeHeader = resp.headers?.get("content-type") || null;
    const ctRaw = contentTypeHeader
      ? String(contentTypeHeader).split(";")[0].trim().toLowerCase()
      : null;
    const parseOpts: Record<string, unknown> = {};
    const candidateNames: string[] = [];

    try {
      const u = new URL(url);
      const pathSeg = u.pathname.split("/").filter(Boolean).pop();
      if (pathSeg) candidateNames.push(pathSeg);
      for (const value of u.searchParams.values()) {
        if (value) candidateNames.push(value);
      }
    } catch (_) {
      // ignore URL parse failure
    }

    const cdHeader = resp.headers?.get("content-disposition");
    if (cdHeader) {
      const filenameMatch = cdHeader.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
      if (filenameMatch && filenameMatch[1]) {
        candidateNames.push(filenameMatch[1]);
      }
    }
    candidateNames.push(url);

    const mapNameToType = (name: string): string | null => {
      const lower = name.toLowerCase();
      if (lower.endsWith(".ttl") || lower.endsWith(".turtle")) return "text/turtle";
      if (lower.endsWith(".nt")) return "application/n-triples";
      if (lower.endsWith(".nq")) return "application/n-quads";
      if (lower.endsWith(".jsonld") || lower.endsWith(".json")) return "application/ld+json";
      if (lower.endsWith(".rdf") || lower.endsWith(".owl") || lower.endsWith(".xml")) {
        return "application/rdf+xml";
      }
      if (lower.endsWith(".trig")) return "application/trig";
      if (lower.endsWith(".trix")) return "application/trix";
      return null;
    };

    const inferContentType = () => {
      const canTrustRaw = ctRaw && ctRaw !== "text/plain" && supportedMedia.has(ctRaw);
      if (canTrustRaw) return ctRaw!;

      if (ctRaw === "text/plain" || !ctRaw) {
        for (const name of candidateNames) {
          const inferred = mapNameToType(name);
          if (inferred) return inferred;
        }
      }
      return null;
    };

    const inferred = inferContentType();
    if (inferred) {
      parseOpts.contentType = inferred;
      parseOpts.path = candidateNames[0] || url;
      post({ type: "stage", id, stage: "parser-content-type", contentType: inferred });
    } else {
      parseOpts.path = candidateNames[0] || url;
      post({ type: "stage", id, stage: "parser-filename", path: String(parseOpts.path) });
    }

  const { DataFactory } = resolveN3();
  if (!DataFactory) {
    post({ type: "error", id, message: "n3-api-unavailable" });
    return;
  }

    const sharedStoreRef = getSharedStore();
    const targetGraphTerm =
      targetGraphName === "default"
        ? DataFactory.defaultGraph()
        : DataFactory.namedNode(String(targetGraphName));

    const prefixes: Record<string, string> = {};
    const touchedSubjects = new Set<string>();
    const serializedBatch: WorkerQuad[] = [];
    let addedCount = 0;

    const flushSerialized = async () => {
      if (serializedBatch.length === 0) return;
      const payload = serializedBatch.splice(0, serializedBatch.length);
      post({ type: "quads", id, quads: payload });
      await waitForAck(id);
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const opts = { ...parseOpts, baseIRI: url };
        const quadStream = parserImpl.parse(readable, opts);

        quadStream.on("data", async (q: any) => {
          try {
            const incoming = q as Quad;
            const graphTerm =
              incoming.graph && incoming.graph.termType && incoming.graph.termType !== "DefaultGraph"
                ? incoming.graph
                : targetGraphTerm;
            const normalized = DataFactory.quad(
              incoming.subject,
              incoming.predicate,
              incoming.object,
              graphTerm,
            );

            const exists =
              typeof sharedStoreRef.countQuads === "function"
                ? sharedStoreRef.countQuads(
                    normalized.subject,
                    normalized.predicate,
                    normalized.object,
                    normalized.graph,
                  ) > 0
                : (sharedStoreRef.getQuads(
                    normalized.subject,
                    normalized.predicate,
                    normalized.object,
                    normalized.graph,
                  ) || []).length > 0;
            if (exists) return;

            const inserted = sharedStoreRef.addQuad(normalized);
            if (inserted === false) return;
            addedCount += 1;

            const subjectValue = subjectTermToString(
              normalized.subject,
              normalized.subject.value,
            );
            if (subjectValue) touchedSubjects.add(subjectValue);

            serializedBatch.push(serializeQuad(normalized));
            if (serializedBatch.length >= BATCH_SIZE) {
              await flushSerialized();
            }
          } catch (err) {
            console.debug("[rdfManager.worker] loadFromUrl data handler failed", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });

        quadStream.on("prefix", (pfx: string, iri: any) => {
          const value =
            iri && typeof iri.value === "string" ? String(iri.value) : String(iri || "");
          if (value) {
            prefixes[pfx] = value;
            post({ type: "prefix", id, prefixes: { [pfx]: value } });
          }
        });

        quadStream.on("context", (ctx: any) => {
          post({ type: "context", id, context: ctx });
        });

        quadStream.on("error", (err: any) => {
          quadStream.removeAllListeners();
          reject(err);
        });

        quadStream.on("end", () => {
          quadStream.removeAllListeners();
          resolve();
        });
      });
    } catch (err) {
      post({ type: "error", id, message: String((err as Error).message || err) });
      return;
  }

  try {
    await flushSerialized();

    if (addedCount > 0) {
      emitChange({ reason: "loadFromUrl", addedCount, graphName: targetGraphName });
    }
      if (touchedSubjects.size > 0) {
        const emission = prepareSubjectEmissionFromSet(
          touchedSubjects,
          sharedStoreRef,
          DataFactory,
        );
        if (emission.subjects.length > 0) {
          emitSubjects(
            emission.subjects,
            emission.quadsBySubject,
            emission.snapshot,
          );
        }
      }

    const loadResult: RDFWorkerLoadCompleteMessage = {
      type: "end",
      id,
      prefixes,
      quadCount: addedCount,
      touchedSubjects: Array.from(touchedSubjects),
    };

    post(loadResult);
  } catch (err) {
    try {
      console.error("[rdfManager.worker] loadFromUrl parse failed", {
        url,
        inferredContentType: parseOpts.contentType ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
    } catch (_) {
      /* ignore console failures */
    }
    const errorMessage =
      err instanceof Error && err.message
        ? `[rdf.loadFromUrl] ${url} :: ${err.message}`
        : `[rdf.loadFromUrl] ${url} :: ${String(err)}`;
    post({ type: "error", id, message: errorMessage });
  }
}




  async function handleCommand(msg: RDFWorkerCommand) {
    try {
      const payload = (msg as { payload?: unknown }).payload;
      let result: unknown;
      switch (msg.command) {
        case "ping":
          result = "pong";
          break;
        case "clear":
          resetSharedStore();
          workerNamespaces = {};
          workerBlacklistPrefixes = new Set(["owl", "rdf", "rdfs", "xml", "xsd"]);
          workerBlacklistUris = [
            "http://www.w3.org/2002/07/owl",
            "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
            "http://www.w3.org/2000/01/rdf-schema#",
            "http://www.w3.org/XML/1998/namespace",
            "http://www.w3.org/2001/XMLSchema#",
          ];
          emitChange({ reason: "clear" });
          emitSubjects([]);
          result = true;
          break;
        case "getGraphCounts":
          result = collectGraphCountsFromStore(getSharedStore());
          break;
        case "getNamespaces":
          result = { ...workerNamespaces };
          break;
        case "setNamespaces":
          if (payload && typeof payload === "object" && payload.namespaces && typeof payload.namespaces === "object") {
            const normalized = ensureDefaultNamespaceMap(payload.namespaces as Record<string, string>);
            if (payload.replace === true) {
              workerNamespaces = { ...normalized };
            } else {
              workerNamespaces = ensureDefaultNamespaceMap({ ...workerNamespaces, ...normalized });
            }
          }
          result = { ...workerNamespaces };
          break;
        case "getBlacklist":
          result = {
            prefixes: Array.from(workerBlacklistPrefixes),
            uris: workerBlacklistUris.slice(),
          };
          break;
        case "setBlacklist":
          if (payload && typeof payload === "object") {
            if (Array.isArray(payload.prefixes)) {
              workerBlacklistPrefixes = new Set(payload.prefixes.map((p: any) => String(p)));
            }
            if (Array.isArray(payload.uris)) {
              workerBlacklistUris = payload.uris.map((u: any) => String(u));
            }
          }
          result = {
            prefixes: Array.from(workerBlacklistPrefixes),
            uris: workerBlacklistUris.slice(),
          };
          break;
        case "syncLoad": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : "urn:vg:data";
          const graphTerm = createGraphTerm(graphName, DataFactory);
          const existing = store.getQuads(null, null, null, graphTerm) || [];
          const touchedSubjects = new Set<string>();
          let removed = 0;
          let added = 0;

          for (const q of existing) {
            try {
              store.removeQuad(q);
              removed += 1;
              touchedSubjects.add(subjectTermToString(q.subject));
            } catch (err) {
              console.error("[rdfManager.worker] syncLoad remove existing failed", err);
            }
          }

          if (payload && Array.isArray(payload.quads)) {
            for (const pq of payload.quads) {
              try {
                const quad = deserializeQuad(pq as any, DataFactory);
                store.addQuad(quad);
                added += 1;
                touchedSubjects.add(subjectTermToString(quad.subject));
              } catch (err) {
                console.error("[rdfManager.worker] syncLoad add failed", err);
              }
            }
          }

          if (
            payload &&
            payload.prefixes &&
            typeof payload.prefixes === "object" &&
            (graphName === "urn:vg:data" || graphName === "urn:vg:ontologies")
          ) {
            workerNamespaces = {
              ...workerNamespaces,
              ...(payload.prefixes as Record<string, string>),
            };
          }

          const emission = prepareSubjectEmissionFromSet(
            touchedSubjects,
            store,
            DataFactory,
          );

          emitChange({ reason: "syncLoad", graphName, added, removed });
          if (emission.subjects.length > 0) {
            emitSubjects(
              emission.subjects,
              emission.quadsBySubject,
              emission.snapshot,
            );
          }

          result = { graphName, added, removed };
          break;
        }
        case "syncRemoveGraph": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : "urn:vg:data";
          const graphTerm = createGraphTerm(graphName, DataFactory);
          const quads = store.getQuads(null, null, null, graphTerm) || [];
          const touchedSubjects = new Set<string>();
          let removed = 0;
          for (const q of quads) {
            try {
              store.removeQuad(q);
              removed += 1;
              touchedSubjects.add(subjectTermToString(q.subject));
            } catch (err) {
              console.error("[rdfManager.worker] syncRemoveGraph remove failed", err);
            }
          }
          if (removed > 0) {
            const emission = prepareSubjectEmissionFromSet(
              touchedSubjects,
              store,
              DataFactory,
            );
            emitChange({ reason: "removeGraph", graphName, removed });
            if (emission.subjects.length > 0) {
              emitSubjects(
                emission.subjects,
                emission.quadsBySubject,
                emission.snapshot,
              );
            }
          }
          result = { graphName, removed };
          break;
        }
        case "syncRemoveAllQuadsForIri": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const iri =
            payload && typeof payload === "object" && typeof payload.iri === "string"
              ? payload.iri
              : "";
          if (!iri) {
            result = { removedSubjects: 0, removedObjects: 0 };
            break;
          }
          const graphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : "urn:vg:data";
          const graphTerm = createGraphTerm(graphName, DataFactory);
          const subjTerm = /^_:/i.test(String(iri))
            ? DataFactory.blankNode(String(iri).replace(/^_:/, ""))
            : DataFactory.namedNode(String(iri));
          const touchedSubjects = new Set<string>();
          let removedSubjects = 0;
          let removedObjects = 0;

          try {
            const subjectQuads = store.getQuads(subjTerm, null, null, graphTerm) || [];
            for (const q of subjectQuads) {
              try {
                store.removeQuad(q);
                removedSubjects += 1;
                touchedSubjects.add(subjectTermToString(q.subject));
              } catch (err) {
                console.error("[rdfManager.worker] syncRemoveAllQuadsForIri subject removal failed", err);
              }
            }
          } catch (err) {
            console.error("[rdfManager.worker] syncRemoveAllQuadsForIri subject scan failed", err);
          }

          try {
            const objectTerm = DataFactory.namedNode(String(iri));
            const objectQuads = store.getQuads(null, null, objectTerm, graphTerm) || [];
            for (const q of objectQuads) {
              try {
                store.removeQuad(q);
                removedObjects += 1;
                touchedSubjects.add(subjectTermToString(q.subject));
              } catch (err) {
                console.error("[rdfManager.worker] syncRemoveAllQuadsForIri object removal failed", err);
              }
            }
          } catch (err) {
            console.error("[rdfManager.worker] syncRemoveAllQuadsForIri object scan failed", err);
          }

          if (removedSubjects > 0 || removedObjects > 0) {
            const emission = prepareSubjectEmissionFromSet(
              touchedSubjects,
              store,
              DataFactory,
            );
            emitChange({
              reason: "removeAllQuadsForIri",
              iri,
              graphName,
              removedSubjects,
              removedObjects,
            });
            if (emission.subjects.length > 0) {
              emitSubjects(
                emission.subjects,
                emission.quadsBySubject,
                emission.snapshot,
              );
            }
          }

          result = { removedSubjects, removedObjects };
          break;
        }
        case "importSerialized": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          if (!payload || typeof payload !== "object" || typeof (payload as any).content !== "string") {
            result = { added: 0, prefixes: {}, graphName: "urn:vg:data", quads: [] };
            break;
          }
          const store = getSharedStore();
          const {
            content,
            graphName: requestedGraph,
            contentType,
            filename,
            baseIri,
          } = payload as ImportSerializedPayload;
          const graphName =
            typeof requestedGraph === "string" && requestedGraph.length > 0
              ? requestedGraph
              : "urn:vg:data";
          const targetGraph =
            graphName === "default"
              ? DataFactory.defaultGraph()
              : DataFactory.namedNode(String(graphName));

          let parserImpl = resolveRdfParser(rdfParsePkg);
          if (!parserImpl) {
            try {
              const dyn = await import("rdf-parse").catch(() => null);
              parserImpl = resolveRdfParser(dyn);
            } catch (_) {
              /* ignore */
            }
          }
          if (!parserImpl) throw new Error("rdf-parse-unavailable");

          const readable = createReadableFromString(content);
          if (!readable) throw new Error("importSerialized.readable-unavailable");

          const prefixes: Record<string, string> = {};
          const touchedSubjects = new Set<string>();
          const addedSerialized: WorkerQuad[] = [];
          let addedCount = 0;

          await new Promise<void>((resolve, reject) => {
            const opts: Record<string, unknown> = {};
            if (contentType) opts.contentType = contentType;
            if (filename) opts.path = filename;
            if (baseIri) opts.baseIRI = baseIri;
            const quadStream = parserImpl.parse(readable, opts);

            quadStream.on("data", (incoming: Quad) => {
              try {
                const graphTerm =
                  incoming.graph && incoming.graph.termType && incoming.graph.termType !== "DefaultGraph"
                    ? incoming.graph
                    : targetGraph;
                const normalized = DataFactory.quad(
                  incoming.subject,
                  incoming.predicate,
                  incoming.object,
                  graphTerm,
                );
                const exists =
                  typeof store.countQuads === "function"
                    ? store.countQuads(
                        normalized.subject,
                        normalized.predicate,
                        normalized.object,
                        normalized.graph,
                      ) > 0
                    : (store.getQuads(
                        normalized.subject,
                        normalized.predicate,
                        normalized.object,
                        normalized.graph,
                      ) || []).length > 0;
                if (exists) return;
                store.addQuad(normalized);
                addedCount += 1;
                touchedSubjects.add(subjectTermToString(normalized.subject));
                addedSerialized.push(serializeQuad(normalized));
              } catch (err) {
                console.debug("[rdfManager.worker] importSerialized.data failed", err);
              }
            });

            quadStream.on("prefix", (pfx: string, iri: any) => {
              const value =
                iri && typeof iri.value === "string"
                  ? iri.value
                  : typeof iri === "string"
                    ? iri
                    : undefined;
              if (typeof value === "string" && value.trim()) {
                prefixes[pfx] = value.trim();
              }
            });

            quadStream.on("error", (err: any) => {
              quadStream.removeAllListeners();
              reject(err);
            });

            quadStream.on("end", () => {
              quadStream.removeAllListeners();
              resolve();
            });
          });

          if (
            Object.keys(prefixes).length > 0 &&
            (graphName === "urn:vg:data" || graphName === "urn:vg:ontologies")
          ) {
            workerNamespaces = { ...workerNamespaces, ...prefixes };
          }

          if (addedCount > 0) {
            emitChange({ reason: "importSerialized", graphName, added: addedCount });
            const emission = prepareSubjectEmissionFromSet(
              touchedSubjects,
              store,
              DataFactory,
            );
            if (emission.subjects.length > 0) {
              emitSubjects(
                emission.subjects,
                emission.quadsBySubject,
                emission.snapshot,
              );
            }
          }

          result = {
            graphName,
            added: addedCount,
            prefixes,
            quads: addedSerialized,
          };
          break;
        }
        case "exportGraph": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof (payload as any).graphName === "string"
              ? (payload as ExportGraphPayload).graphName || "urn:vg:data"
              : "urn:vg:data";
          const formatInfo = normalizeExportFormat(
            payload && typeof payload === "object" ? (payload as ExportGraphPayload).format : undefined,
          );
          const graphTerm = createGraphTerm(graphName, DataFactory);
          const quads = store.getQuads(null, null, null, graphTerm) || [];
          const writer = new (N3 as any).Writer({
            prefixes: { ...workerNamespaces },
            format: formatInfo.writerFormat,
          });
          const toWrite = formatInfo.dropGraph
            ? quads.map((q: Quad) =>
                DataFactory.quad(q.subject, q.predicate, q.object, DataFactory.defaultGraph()),
              )
            : quads;
          writer.addQuads(toWrite);
          const output: string = await new Promise((resolve, reject) => {
            writer.end((err: unknown, res: unknown) => {
              if (err) {
                reject(err);
                return;
              }
              resolve(typeof res === "string" ? res : String(res ?? ""));
            });
          });
          result = {
            graphName,
            format: formatInfo.mediaType,
            content: output,
          };
          break;
        }
        case "removeQuadsByNamespace": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof (payload as any).graphName === "string"
              ? (payload as RemoveQuadsByNamespacePayload).graphName
              : "urn:vg:data";
          const namespaces =
            payload && typeof payload === "object" && Array.isArray((payload as any).namespaceUris)
              ? (payload as RemoveQuadsByNamespacePayload).namespaceUris
                  .map((ns) => (typeof ns === "string" ? ns.trim() : ""))
                  .filter((ns) => ns.length > 0)
              : [];
          if (namespaces.length === 0) {
            result = { graphName, removed: 0 };
            break;
          }
          const graphTerm = createGraphTerm(graphName, DataFactory);
          const quads = store.getQuads(null, null, null, graphTerm) || [];
          const touchedSubjects = new Set<string>();
          let removed = 0;
          for (const q of quads) {
            try {
              const subj = q.subject && (q.subject as any).value ? String((q.subject as any).value) : "";
              const pred = q.predicate && (q.predicate as any).value ? String((q.predicate as any).value) : "";
              const obj =
                q.object && (q.object as any).value ? String((q.object as any).value) : String(q.object || "");
              const matches = namespaces.some(
                (ns) => (subj && subj.startsWith(ns)) || (pred && pred.startsWith(ns)) || (obj && obj.startsWith(ns)),
              );
              if (!matches) continue;
              store.removeQuad(q);
              removed += 1;
              touchedSubjects.add(subjectTermToString(q.subject));
            } catch (err) {
              console.debug("[rdfManager.worker] removeQuadsByNamespace remove failed", err);
            }
          }
          if (removed > 0) {
            emitChange({ reason: "removeQuadsByNamespace", graphName, removed });
            const emission = prepareSubjectEmissionFromSet(touchedSubjects, store, DataFactory);
            if (emission.subjects.length > 0) {
              emitSubjects(
                emission.subjects,
                emission.quadsBySubject,
                emission.snapshot,
              );
            }
          }
          result = { graphName, removed };
          break;
        }
        case "purgeNamespace": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const prefixOrUri =
            payload && typeof payload === "object" && typeof (payload as any).prefixOrUri === "string"
              ? (payload as PurgeNamespacePayload).prefixOrUri
              : "";
          if (!prefixOrUri) {
            result = { removed: 0, namespaceUri: null, prefixRemoved: null };
            break;
          }
          let namespaceUri: string | null = null;
          let prefixRemoved: string | null = null;
          if (workerNamespaces[prefixOrUri]) {
            namespaceUri = workerNamespaces[prefixOrUri];
            prefixRemoved = prefixOrUri;
          } else {
            for (const [pfx, uri] of Object.entries(workerNamespaces)) {
              if (uri === prefixOrUri) {
                namespaceUri = uri;
                prefixRemoved = pfx;
                break;
              }
            }
            if (!namespaceUri && /^https?:\/\//i.test(prefixOrUri)) {
              namespaceUri = prefixOrUri;
            }
          }
          if (!namespaceUri) {
            result = { removed: 0, namespaceUri: null, prefixRemoved: null };
            break;
          }
          if (prefixRemoved) {
            const next = { ...workerNamespaces };
            delete next[prefixRemoved];
            workerNamespaces = next;
          }
          const quads = store.getQuads(null, null, null, null) || [];
          let removed = 0;
          const touchedSubjects = new Set<string>();
          for (const q of quads) {
            try {
              const subj = q.subject && (q.subject as any).value ? String((q.subject as any).value) : "";
              const pred = q.predicate && (q.predicate as any).value ? String((q.predicate as any).value) : "";
              const obj =
                q.object && (q.object as any).value ? String((q.object as any).value) : String(q.object || "");
              if (
                (subj && subj.startsWith(namespaceUri)) ||
                (pred && pred.startsWith(namespaceUri)) ||
                (obj && obj.startsWith(namespaceUri))
              ) {
                store.removeQuad(q);
                removed += 1;
                touchedSubjects.add(subjectTermToString(q.subject));
              }
            } catch (err) {
              console.debug("[rdfManager.worker] purgeNamespace removal failed", err);
            }
          }
          if (removed > 0) {
            emitChange({ reason: "purgeNamespace", namespaceUri, removed });
            const emission = prepareSubjectEmissionFromSet(touchedSubjects, store, DataFactory);
            if (emission.subjects.length > 0) {
              emitSubjects(
                emission.subjects,
                emission.quadsBySubject,
                emission.snapshot,
              );
            }
          }
          result = { removed, namespaceUri, prefixRemoved };
          break;
        }
        case "emitAllSubjects": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : "urn:vg:data";
          const graphTerm = createGraphTerm(graphName, DataFactory);
          const quads = store.getQuads(null, null, null, graphTerm) || [];
          const emission = prepareSubjectEmissionFromQuads(quads);
          if (emission.subjects.length > 0) {
            emitSubjects(
              emission.subjects,
              emission.quadsBySubject,
              emission.snapshot,
              { reason: "emitAllSubjects", graphName },
            );
          }
          result = { subjects: emission.subjects.length };
          break;
        }
        case "triggerSubjects": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const subjectInput =
            payload && typeof payload === "object" && Array.isArray((payload as any).subjects)
              ? (payload as any).subjects
              : [];
          const subjectSet = new Set<string>();
          for (const item of subjectInput) {
            const value = typeof item === "string" ? item.trim() : String(item ?? "").trim();
            if (!value) continue;
            subjectSet.add(value);
          }
          const emission = prepareSubjectEmissionFromSet(
            subjectSet,
            store,
            DataFactory,
          );
          if (emission.subjects.length > 0) {
            emitSubjects(
              emission.subjects,
              emission.quadsBySubject,
              emission.snapshot,
              { reason: "triggerSubjects" },
            );
          }
          result = { subjects: emission.subjects.length };
          break;
        }
        case "fetchQuadsPage": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : "urn:vg:data";
          const graphTerm = createGraphTerm(graphName, DataFactory);
          const all = store.getQuads(null, null, null, graphTerm) || [];
          const filter =
            payload && typeof payload === "object" && payload.filter ? payload.filter : undefined;
          const filtered = !filter
            ? all
            : all.filter((q: any) => {
                try {
                  if (filter.subject && subjectTermToString(q.subject) !== String(filter.subject)) {
                    return false;
                  }
                  if (filter.predicate) {
                    const pred = termToString(q.predicate);
                    if (pred !== String(filter.predicate)) return false;
                  }
                  if (filter.object) {
                    const obj = termToString(q.object);
                    if (obj !== String(filter.object)) return false;
                  }
                  return true;
                } catch (_) {
                  return false;
                }
              });
          const total = filtered.length;
          const offset =
            payload && typeof (payload as any).offset === "number"
              ? Math.max(0, (payload as any).offset)
              : 0;
          const limit =
            payload && typeof (payload as any).limit === "number"
              ? Math.max(0, (payload as any).limit)
              : 0;
          const slice =
            limit > 0 ? filtered.slice(offset, offset + limit) : filtered.slice(offset);
          const shouldSerialize = !payload || (payload as any).serialize !== false;
          const items = shouldSerialize
            ? slice.map((q: any) => ({
                subject: subjectTermToString(q.subject),
                predicate: termToString(q.predicate),
                object: termToString(q.object),
                graph: q.graph && q.graph.value ? String(q.graph.value) : "default",
              }))
            : slice.map((q: Quad) => serializeQuad(q));
          result = { total, offset, limit, items, serialize: shouldSerialize };
          break;
        }
        case "getQuads": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : null;
          const graphTerm = graphName === null ? null : createGraphTerm(graphName, DataFactory);
          const subjectTerm =
            payload && typeof payload === "object" && typeof payload.subject === "string"
              ? payload.subject.startsWith("_:")
                ? DataFactory.blankNode(payload.subject.slice(2))
                : DataFactory.namedNode(String(payload.subject))
              : null;
          const predicateTerm =
            payload && typeof payload === "object" && typeof payload.predicate === "string"
              ? DataFactory.namedNode(String(payload.predicate))
              : null;
          const objectTerm =
            payload && typeof payload === "object" && payload.object
              ? deserializeTerm(payload.object, DataFactory)
              : null;
          const quads = store.getQuads(subjectTerm, predicateTerm, objectTerm, graphTerm) || [];
          result = quads.map((q: Quad) => serializeQuad(q));
          break;
        }
        case "syncBatch": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : "urn:vg:data";
          const graphTerm = createGraphTerm(graphName, DataFactory);
          const touchedSubjects = new Set<string>();
          let added = 0;
          let removed = 0;

          if (payload && Array.isArray(payload.removes)) {
            for (const rem of payload.removes) {
              if (!rem) continue;
              try {
                const subject = deserializeTerm(rem.subject, DataFactory);
                const predicate = deserializeTerm(rem.predicate, DataFactory);
                const graphOverride =
                  rem.graph && rem.graph.termType !== "DefaultGraph"
                    ? deserializeTerm(rem.graph, DataFactory)
                    : graphTerm;
                if (!rem.object) {
                  const matches = store.getQuads(subject, predicate, null, graphOverride) || [];
                  for (const q of matches) {
                    store.removeQuad(q);
                    removed += 1;
                    touchedSubjects.add(subjectTermToString(q.subject));
                  }
                  continue;
                }

                const object = deserializeTerm(rem.object, DataFactory);
                const matches = store.getQuads(subject, predicate, object, graphOverride) || [];
                let handled = false;
                for (const q of matches) {
                  store.removeQuad(q);
                  removed += 1;
                  handled = true;
                  touchedSubjects.add(subjectTermToString(q.subject));
                }
                if (!handled && rem.object.termType === "Literal") {
                  const lexical = rem.object.value || "";
                  const allForPredicate = store.getQuads(subject, predicate, null, graphOverride) || [];
                  for (const q of allForPredicate) {
                    const objTerm = q.object;
                    if (
                      objTerm &&
                      objTerm.termType === "Literal" &&
                      String(objTerm.value || "") === lexical
                    ) {
                      store.removeQuad(q);
                      removed += 1;
                      touchedSubjects.add(subjectTermToString(q.subject));
                    }
                  }
                }
              } catch (err) {
                console.error("[rdfManager.worker] syncBatch remove failed", err);
              }
            }
          }

          if (payload && Array.isArray(payload.adds)) {
            for (const add of payload.adds) {
              if (!add) continue;
              try {
                const quad = deserializeQuad(add, DataFactory);
                store.addQuad(quad);
                added += 1;
                touchedSubjects.add(subjectTermToString(quad.subject));
              } catch (err) {
                console.error("[rdfManager.worker] syncBatch add failed", err);
              }
            }
          }

          const shouldEmitSubjects =
            !payload?.options || payload.options.suppressSubjects !== true;
          let emissionSubjects: string[] = [];
          let emissionQuads: SubjectQuadMap = {};
          let emissionSnapshot: WorkerReconcileSubjectSnapshotPayload[] = [];
          if (shouldEmitSubjects) {
            const emission = prepareSubjectEmissionFromSet(
              touchedSubjects,
              store,
              DataFactory,
            );
            emissionSubjects = emission.subjects;
            emissionQuads = emission.quadsBySubject;
            emissionSnapshot = emission.snapshot;
          }

          if (added > 0 || removed > 0) {
            emitChange({ reason: "syncBatch", graphName, added, removed });
            if (shouldEmitSubjects && emissionSubjects.length > 0) {
              emitSubjects(emissionSubjects, emissionQuads, emissionSnapshot);
            }
          }

          result = { added, removed };
          break;
        }
        case "runReasoning": {
          const payload = msg.payload as RDFWorkerCommandPayloads["runReasoning"];
          const reasoningId = payload.reasoningId;
          const reasoningRequest: RDFWorkerRunReasoningMessage = {
            type: "runReasoning",
            id: reasoningId,
            quads: payload.quads,
            rulesets: payload.rulesets,
            baseUrl: payload.baseUrl,
            emitSubjects: payload.emitSubjects,
          };
          const outcome = await handleRunReasoning(reasoningRequest, {
            mutateSharedStore: true,
            includeAdded: false,
            emitSubjects: payload.emitSubjects !== false,
            emitChange: true,
            emitResultEvent: true,
          });
          result = {
            id: outcome.id,
            durationMs: outcome.durationMs,
            startedAt: outcome.startedAt,
            warnings: outcome.warnings,
            errors: outcome.errors,
            inferences: outcome.inferences,
            usedReasoner: outcome.usedReasoner,
            addedCount: outcome.addedCount,
            workerDurationMs: outcome.workerDurationMs,
            ruleQuadCount: outcome.ruleQuadCount,
          };
          break;
        }
        default:
          throw new Error(`Unsupported command: ${String(msg.command)}`);
      }
      post({ type: "response", id: msg.id, ok: true, result });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error && err.stack ? err.stack : undefined;
      post({
        type: "response",
        id: msg.id,
        ok: false,
        error: errorMessage,
        stack: errorStack,
      });
    }
  }

  async function handleRunReasoning(
    msg: RDFWorkerRunReasoningMessage,
    options: RunReasoningOptions = {},
  ): Promise<ReasoningResultMessage> {
    const startedAt = Date.now();
    reasoningStage({ type: "reasoningStage", id: msg.id, stage: "start" });

    const { DataFactory, StoreCls, ParserCls, ReasonerCls } = resolveN3();
    if (!DataFactory || !StoreCls) {
      reasoningStage({ type: "reasoningStage", id: msg.id, stage: "n3-unavailable" });
      throw new Error("n3-api-unavailable");
    }

    const mutateSharedStore =
      options.mutateSharedStore ?? !(Array.isArray(msg.quads) && msg.quads.length > 0);
    const includeAdded = options.includeAdded ?? !mutateSharedStore;
    const emitSubjectsFlag = options.emitSubjects ?? mutateSharedStore;
    const emitChangeFlag = options.emitChange ?? mutateSharedStore;
    const emitResultEvent = options.emitResultEvent ?? true;

    let sharedStoreRef: any | null = null;
    let workingStore: any;

    if (mutateSharedStore) {
      sharedStoreRef = getSharedStore();
      workingStore = sharedStoreRef;
    } else {
      workingStore = new (StoreCls as any)();
      for (const pq of msg.quads || []) {
        try {
          const quad = deserializeQuad(pq, DataFactory);
          workingStore.addQuad(quad);
        } catch (err) {
          reasoningStage({
            type: "reasoningStage",
            id: msg.id,
            stage: "ingest-quad-failed",
            meta: { error: String((err as Error).message || err) },
          });
        }
      }
    }

    try {
      const countsBefore = collectGraphCountsFromStore(workingStore);
      console.debug("[VG_REASONING_WORKER] quad counts before reasoning", {
        id: msg.id,
        total: Object.values(countsBefore).reduce((acc, v) => acc + v, 0),
        counts: countsBefore,
      });
    } catch (err) {
      console.debug("[VG_REASONING_WORKER] unable to log pre-reasoning counts", err);
    }

    const parser = ParserCls ? new (ParserCls as any)({ format: "text/n3" }) : null;
    const parsedRules: any[] = [];
    const ruleDiagnostics: { name: string; quadCount: number }[] = [];

    const rulesets = Array.isArray(msg.rulesets)
      ? msg.rulesets.filter((r) => typeof r === "string" && r)
      : [];
    const baseUrlRaw =
      typeof msg.baseUrl === "string" && msg.baseUrl.length > 0 ? msg.baseUrl : "/";
    const normalizedBase = (() => {
      try {
        let v = baseUrlRaw;
        if (!v.startsWith("/")) v = `/${v}`;
        if (!v.endsWith("/")) v = `${v}/`;
        return v;
      } catch (_) {
        return "/";
      }
    })();
    const workerDir = (() => {
      try {
        if (typeof globalThis !== "undefined" && (globalThis as any).location && (globalThis as any).location.href) {
          const dir = new URL("./", (globalThis as any).location.href).pathname;
          return dir.endsWith("/") ? dir : `${dir}/`;
        }
      } catch (_) {
        /* ignore */
      }
      return "";
    })();
    const origin = (() => {
      try {
        return (globalThis as any).location && (globalThis as any).location.origin
          ? String((globalThis as any).location.origin)
          : "";
      } catch (_) {
        return "";
      }
    })();

    const fetchRuleText = async (name: string) => {
      const attemptsSet = new Set<string>();
      attemptsSet.add(`${normalizedBase}reasoning-rules/${name}`);
      attemptsSet.add(`/reasoning-rules/${name}`);
      attemptsSet.add(`${normalizedBase}${name}`);
      attemptsSet.add(name);
      if (workerDir) attemptsSet.add(`${workerDir}reasoning-rules/${name}`);
      if (origin) {
        attemptsSet.add(`${origin}${normalizedBase}reasoning-rules/${name}`);
        attemptsSet.add(`${origin}/reasoning-rules/${name}`);
        if (workerDir) attemptsSet.add(`${origin}${workerDir}reasoning-rules/${name}`);
      }
      const attempts = Array.from(attemptsSet);
      let lastErr: unknown = null;
      for (const url of attempts) {
        try {
          reasoningStage({
            type: "reasoningStage",
            id: msg.id,
            stage: "fetch-ruleset",
            meta: { name },
          });
          const response = await fetch(url, { mode: "cors" });
          if (response.ok) {
            const text = await response.text();
            if (text && text.length > 0) {
              return text;
            }
          }
          lastErr = new Error(`Failed to fetch ruleset ${name} from ${url}`);
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) throw lastErr;
      throw new Error(`Unable to fetch ruleset ${name}`);
    };

    if (parser && rulesets.length > 0) {
      for (const name of rulesets) {
        try {
          const text = await fetchRuleText(String(name));
          if (text && text.trim()) {
            const quads = parser.parse(text);
            if (Array.isArray(quads) && quads.length > 0) {
              parsedRules.push(...quads);
              ruleDiagnostics.push({ name: String(name), quadCount: quads.length });
              reasoningStage({
                type: "reasoningStage",
                id: msg.id,
                stage: "ruleset-parsed",
                meta: { name, quadCount: quads.length },
              });
            }
          }
        } catch (err) {
          reasoningStage({
            type: "reasoningStage",
            id: msg.id,
            stage: "ruleset-parse-error",
            meta: { name, error: String((err as Error).message || err) },
          });
        }
      }
    }

    try {
      const totalRuleQuads = ruleDiagnostics.reduce((acc, item) => acc + item.quadCount, 0);
      console.debug("[VG_REASONING_WORKER] ruleset load summary", {
        id: msg.id,
        requested: rulesets,
        parsedRuleSets: ruleDiagnostics,
        totalRuleQuads,
        parserAvailable: Boolean(parser),
      });
    } catch (_) {
      /* ignore diagnostics errors */
    }

    const inferredGraphTerm = DataFactory.namedNode("urn:vg:inferred");
    const inferenceGraphKey = ensureGraphKeyInStore(workingStore, inferredGraphTerm);

    let usedReasoner = false;
    let reasonerDuration = 0;
    let captureReasonerInsertions: () => ReasonerInsertion[] = () => [];

    if (ReasonerCls) {
      try {
        const reasoner = new (ReasonerCls as any)(workingStore);
        captureReasonerInsertions = attachReasonerAddInterceptor(reasoner, workingStore);
        const totalRuleQuads = ruleDiagnostics.reduce((acc, item) => acc + item.quadCount, 0);
        reasoningStage({
          type: "reasoningStage",
          id: msg.id,
          stage: "reasoner-start",
          meta: { ruleQuadCount: totalRuleQuads },
        });
        let rulesInput: any = new (StoreCls as any)();
        if (parsedRules.length > 0) {
          try {
            rulesInput = new (StoreCls as any)(parsedRules);
          } catch (_) {
            rulesInput = new (StoreCls as any)();
            for (const quad of parsedRules) {
              try {
                rulesInput.addQuad(quad);
              } catch (_) {
                /* ignore individual rule quad failures */
              }
            }
          }
        }
        const reasonerStart = Date.now();
        const maybePromise = reasoner.reason(rulesInput);
        if (maybePromise && typeof maybePromise.then === "function") {
          await maybePromise;
        }
        usedReasoner = true;
        reasonerDuration = Date.now() - reasonerStart;
        reasoningStage({
          type: "reasoningStage",
          id: msg.id,
          stage: "reasoner-complete",
          meta: { durationMs: reasonerDuration, ruleQuadCount: totalRuleQuads },
        });
        console.debug("[VG_REASONING_WORKER] reasoner run complete", {
          id: msg.id,
          durationMs: reasonerDuration,
          ruleQuadCount: totalRuleQuads,
        });
      } catch (err) {
        reasoningStage({
          type: "reasoningStage",
          id: msg.id,
          stage: "reasoner-error",
          meta: { error: String((err as Error).message || err) },
        });
        usedReasoner = false;
      }
    } else {
      reasoningStage({ type: "reasoningStage", id: msg.id, stage: "reasoner-missing" });
    }

    const capturedInsertions = captureReasonerInsertions();

    console.debug("[VG_REASONING_WORKER] captured insertions summary", {
      id: msg.id,
      capturedCount: capturedInsertions.length,
      usedReasoner,
    });

    if (!usedReasoner) {
      reasoningStage({
        type: "reasoningStage",
        id: msg.id,
        stage: "reasoner-missing",
        meta: { message: "Reasoner unavailable after execution attempt" },
      });

      const durationMs = Date.now() - startedAt;
      const fallbackWarnings: ReasoningWarning[] = [
        {
          message: "Reasoner unavailable; no inferred triples were generated.",
          rule: "reasoner-missing",
          severity: "warning",
        },
      ];

      const fallbackResult: ReasoningResultMessage = {
        type: "reasoningResult",
        id: msg.id,
        durationMs,
        startedAt,
        added: includeAdded ? [] : undefined,
        addedCount: 0,
        warnings: fallbackWarnings,
        errors: [],
        inferences: [],
        usedReasoner: false,
        workerDurationMs: 0,
        ruleQuadCount: ruleDiagnostics.reduce((acc, item) => acc + item.quadCount, 0),
      };

      if (emitResultEvent) {
        const eventPayload: ReasoningResult = {
          id: msg.id,
          timestamp: startedAt,
          status: "completed",
          duration: durationMs,
          errors: [],
          warnings: fallbackWarnings,
          inferences: [],
          meta: {
            usedReasoner: false,
            workerDurationMs: 0,
            totalDurationMs: durationMs,
            addedCount: 0,
            ruleQuadCount: fallbackResult.ruleQuadCount,
          },
        };
        post({
          type: "event",
          event: "reasoningResult",
          payload: eventPayload,
        });
      }

      reasoningStage({
        type: "reasoningStage",
        id: msg.id,
        stage: "complete",
        meta: {
          durationMs,
          addedCount: 0,
          usedReasoner: false,
          inferenceCount: 0,
          ruleQuadCount: fallbackResult.ruleQuadCount,
        },
      });

      return fallbackResult;
    }

    const touchedSubjects = new Set<string>();
    const addedQuads: Quad[] = [];
    const additionSeen = new Set<string>();
    const removalSeen = new Set<string>();
    const idStore = mutateSharedStore && sharedStoreRef ? sharedStoreRef : workingStore;

    if (idStore && capturedInsertions.length > 0) {
      for (const insertion of capturedInsertions) {
        const subjectTerm = storeIdToTerm(idStore, insertion.subject);
        const predicateTerm = storeIdToTerm(idStore, insertion.predicate);
        const objectTerm = storeIdToTerm(idStore, insertion.object);
        if (!subjectTerm || !predicateTerm || !objectTerm) continue;

        let originalGraphTerm =
          insertion.graphKey !== undefined && insertion.graphKey !== null
            ? storeIdToTerm(idStore, insertion.graphKey)
            : null;
        if (!originalGraphTerm) {
          originalGraphTerm = DataFactory.defaultGraph();
        }

        let insertedIntoShared = true;
        if (mutateSharedStore && sharedStoreRef) {
          const skipRemoval =
            typeof inferenceGraphKey === "string" && insertion.graphKey === inferenceGraphKey;
          const removalQuad = DataFactory.quad(
            subjectTerm,
            predicateTerm,
            objectTerm,
            originalGraphTerm,
          );
          const removalKey = quadKeyFromTerms(removalQuad);
          if (!skipRemoval && !removalSeen.has(removalKey)) {
            removalSeen.add(removalKey);
            try {
              sharedStoreRef.removeQuad(removalQuad);
            } catch (_) {
              /* ignore removal failure */
            }
          }
          try {
            const inferredQuad = DataFactory.quad(
              subjectTerm,
              predicateTerm,
              objectTerm,
              inferredGraphTerm,
            );
            insertedIntoShared = sharedStoreRef.addQuad(inferredQuad) !== false;
          } catch (_) {
            insertedIntoShared = false;
          }
        }

        if (!mutateSharedStore || insertedIntoShared) {
          const additionQuad = DataFactory.quad(
            subjectTerm,
            predicateTerm,
            objectTerm,
            inferredGraphTerm,
          );
          const additionKey = quadKeyFromTerms(additionQuad);
          if (!additionSeen.has(additionKey)) {
            additionSeen.add(additionKey);
            addedQuads.push(additionQuad);
          }
          const subjectValue = subjectTermToString(subjectTerm, subjectTerm.value);
          if (subjectValue) touchedSubjects.add(subjectValue);
        }
      }
    }

    const effectiveAdded = addedQuads;

    if (mutateSharedStore && sharedStoreRef) {
      if (emitChangeFlag && effectiveAdded.length > 0) {
        emitChange({ reason: "reasoning", addedCount: effectiveAdded.length });
      }
      if (emitSubjectsFlag && effectiveAdded.length > 0) {
        const emission = prepareSubjectEmissionFromSet(
          touchedSubjects,
          sharedStoreRef,
          DataFactory,
        );
        if (emission.subjects.length > 0) {
          emitSubjects(
            emission.subjects,
            emission.quadsBySubject,
            emission.snapshot,
          );
        }
      }
    }

    const { warnings, errors } = collectShaclResults(effectiveAdded);

    const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
    const inferences: ReasoningInference[] = effectiveAdded
      .map((quad) => {
        const subject = subjectTermToString(quad.subject, quad.subject.value);
        const predicate = termToString(quad.predicate);
        const object = termToString(quad.object);
        if (!subject || !predicate) return null;
        if (predicate === RDF_TYPE) {
          return {
            type: "class",
            subject,
            predicate,
            object,
            confidence: 0.95,
          } as ReasoningInference;
        }
        return {
          type: "relationship",
          subject,
          predicate,
          object,
          confidence: 0.9,
        } as ReasoningInference;
      })
      .filter((entry): entry is ReasoningInference => Boolean(entry));

    const durationMs = Date.now() - startedAt;

    try {
      const countsAfter = collectGraphCountsFromStore(
        mutateSharedStore && sharedStoreRef ? sharedStoreRef : workingStore,
      );
      console.debug("[VG_REASONING_WORKER] quad counts after reasoning", {
        id: msg.id,
        durationMs,
        total: Object.values(countsAfter).reduce((acc, v) => acc + v, 0),
        counts: countsAfter,
        addedCount: effectiveAdded.length,
        usedReasoner,
        ruleQuadCount: ruleDiagnostics.reduce((acc, item) => acc + item.quadCount, 0),
      });
    } catch (err) {
      console.debug("[VG_REASONING_WORKER] unable to log post-reasoning counts", err);
    }

    const result: ReasoningResultMessage = {
      type: "reasoningResult",
      id: msg.id,
      durationMs,
      startedAt,
      added: includeAdded ? effectiveAdded.map((quad) => serializeQuad(quad)) : undefined,
      addedCount: effectiveAdded.length,
      warnings,
      errors,
      inferences,
      usedReasoner,
      workerDurationMs: reasonerDuration,
      ruleQuadCount: ruleDiagnostics.reduce((acc, item) => acc + item.quadCount, 0),
    };

    if (emitResultEvent) {
      const eventPayload: ReasoningResult = {
        id: msg.id,
        timestamp: startedAt,
        status: "completed",
        duration: durationMs,
        errors,
        warnings,
        inferences,
        meta: {
          usedReasoner,
          workerDurationMs: reasonerDuration,
          totalDurationMs: durationMs,
          addedCount: result.addedCount,
          ruleQuadCount: result.ruleQuadCount,
        },
      };
      post({
        type: "event",
        event: "reasoningResult",
        payload: eventPayload,
      });
    }

    reasoningStage({
      type: "reasoningStage",
      id: msg.id,
      stage: "complete",
      meta: {
        durationMs,
        addedCount: result.addedCount,
        usedReasoner,
        inferenceCount: usedReasoner ? inferences.length : 0,
        ruleQuadCount: result.ruleQuadCount,
      },
    });

    return result;
  }
  return {
    handleEvent(message: unknown) {
      handleInbound(message);
    },
    terminate() {
      pendingAcks.clear();
      sharedStore = null;
      workerNamespaces = {};
      workerBlacklistPrefixes = new Set(["owl", "rdf", "rdfs", "xml", "xsd"]);
      workerBlacklistUris = [
        "http://www.w3.org/2002/07/owl",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        "http://www.w3.org/2000/01/rdf-schema#",
        "http://www.w3.org/XML/1998/namespace",
        "http://www.w3.org/2001/XMLSchema#",
      ];
      workerChangeCounter = 0;
    },
  };
}
