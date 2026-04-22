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
  RDFWorkerRunReasoningMessage,
  ExportGraphPayload,
  ImportSerializedPayload,
  PurgeNamespacePayload,
  RenameNamespaceUriPayload,
  RemoveQuadsByNamespacePayload,
  WorkerReconcileSubjectSnapshotPayload,
} from "../utils/rdfManager.workerProtocol.ts";
import type { ReasoningResult } from "../utils/reasoningTypes.ts";
import { deserializeQuad, deserializeTerm, serializeQuad } from "../utils/rdfSerialization.ts";
import type { WorkerQuad } from "../utils/rdfSerialization.ts";
import { WELL_KNOWN } from "../utils/wellKnownOntologies.ts";
import { ensureDefaultNamespaceMap } from "../constants/namespaces.ts";
import { RDF_TYPE, RDFS_LABEL, SHACL } from "../constants/vocabularies.ts";
import { OWL_SCHEMA_AXIOMS } from "../constants/owlSchemaData.ts";

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

  /**
   * Seed the store with OWL/RDFS/RDF meta-ontology domain/range axioms into the
   * ontology named graph (`urn:vg:ontologies`).  This is the same graph that
   * buildFatMap reads, so the fat-map reconciliation automatically picks up these
   * predicates and their domain/range values — producing correct ObjectProperty
   * entries that the mapper uses for data-driven TBox structural classification.
   *
   * These subjects are blacklisted from diagram emission (owl/rdf/rdfs prefixes),
   * so they never appear as canvas nodes. They exist solely to inform classification.
   */
  function loadSchemaOntology(store: any, DataFactory: any): void {
    try {
      const ontologiesGraph = DataFactory.namedNode("urn:vg:ontologies");
      const RDFS_DOMAIN = DataFactory.namedNode("http://www.w3.org/2000/01/rdf-schema#domain");
      const RDFS_RANGE  = DataFactory.namedNode("http://www.w3.org/2000/01/rdf-schema#range");
      for (const axiom of OWL_SCHEMA_AXIOMS) {
        const subject = DataFactory.namedNode(axiom.predicate);
        if (axiom.domain) {
          store.addQuad(subject, RDFS_DOMAIN, DataFactory.namedNode(axiom.domain), ontologiesGraph);
        }
        if (axiom.range) {
          store.addQuad(subject, RDFS_RANGE, DataFactory.namedNode(axiom.range), ontologiesGraph);
        }
      }
    } catch (err) {
      console.error("[rdfManager.worker] loadSchemaOntology failed", err);
    }
  }

  function resetSharedStore() {
    const { StoreCls, DataFactory } = resolveN3();
    if (!StoreCls) throw new Error("n3-store-unavailable");
    sharedStore = new (StoreCls as any)();
    workerChangeCounter = 0;
    // Non-negotiable: always seed the store with OWL/RDFS/RDF meta-ontology axioms
    if (DataFactory) loadSchemaOntology(sharedStore, DataFactory);
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

  const VG_LOADED_FROM = "urn:vg:loadedFrom";

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
          if (q.predicate?.value === VG_LOADED_FROM) continue;
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
    subject: string | undefined;
    predicate: string | undefined;
    object: string | undefined;
  };

  /**
   * Convert a value from the N3.js _entities map to an RDF Term.
   *
   * The N3.js Store's `_entities` object maps numeric IDs to string representations:
   *   - Named nodes: plain IRI string (e.g. "http://example.org/alice")
   *   - Default graph: empty string ""
   *   - Blank nodes: "_:localname"
   *   - Literals: '"value"', '"value"@lang', '"value"^^datatype'
   */
  function termFromReasonerValue(DataFactory: any, value: unknown): any {
    if (value === null || value === undefined) return null;
    const str = String(value);
    if (str === "") return DataFactory.defaultGraph();
    // Blank node
    if (str.startsWith("_:")) return DataFactory.blankNode(str.slice(2));
    // N3.js literal formats (all start with '"')
    if (str.startsWith('"')) {
      const langMatch = /^"(.*)"\@([a-zA-Z-]+)$/.exec(str);
      if (langMatch) return DataFactory.literal(langMatch[1], langMatch[2]);
      const typedMatch = /^"(.*)"\^\^(.+)$/.exec(str);
      if (typedMatch) return DataFactory.literal(typedMatch[1], DataFactory.namedNode(typedMatch[2]));
      const plainMatch = /^"(.*)"$/.exec(str);
      if (plainMatch) return DataFactory.literal(plainMatch[1]);
      return DataFactory.literal(str);
    }
    // Absolute IRI
    if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:[^\s]/.test(str)) return DataFactory.namedNode(str);
    return DataFactory.literal(str);
  }

  function attachReasonerAddInterceptor(reasoner: any, store: any) {
    if (!reasoner || typeof reasoner._add !== "function") {
      return () => [] as ReasonerInsertion[];
    }
    const originalAdd = reasoner._add.bind(reasoner);
    const insertions: ReasonerInsertion[] = [];
    const seen = new Set<string>();
    // N3.js Store._entities maps numeric entity IDs → N3.js term string representations
    const entities: Record<string | number, string> = store._entities ?? {};

    const resolveId = (id: any): string | undefined => {
      if (id === null || id === undefined) return undefined;
      return entities[id] ?? entities[String(id)];
    };

    reasoner._add = (subject: unknown, predicate: unknown, object: unknown, graphItem: any, cb: () => void) => {
      originalAdd(subject, predicate, object, graphItem, () => {
        try {
          const sStr = resolveId(subject);
          const pStr = resolveId(predicate);
          const oStr = resolveId(object);
          if (sStr !== undefined && pStr !== undefined && oStr !== undefined) {
            const dedupeKey = `${sStr}|${pStr}|${oStr}`;
            if (!seen.has(dedupeKey)) {
              seen.add(dedupeKey);
              insertions.push({ subject: sStr, predicate: pStr, object: oStr });
            }
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
    const RDF_REST_IRI = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";

    const subjects: string[] = [];
    const quadsBySubject: SubjectQuadMap = {};
    const snapshot: WorkerReconcileSubjectSnapshotPayload[] = [];

    // Use a queue so rdf:rest chains are followed inline.
    // When any subject has a rdf:rest → BlankNode triple, that blank node is
    // enqueued as an additional subject so its own quads (including rdf:first →
    // member) are also emitted — without requiring a separate round-trip query.
    const queue: string[] = Array.from(subjectSet);
    const processed = new Set<string>();

    while (queue.length > 0) {
      const raw = queue.shift()!;
      try {
        const subject = String(raw || "").trim();
        if (!subject || processed.has(subject)) continue;
        processed.add(subject);

        if (isBlacklistedIri(subject)) continue;
        subjects.push(subject);
        const quads = collectWorkerQuadsForSubject(subject, store, DataFactory);
        quadsBySubject[subject] = quads;
        const entry = snapshotEntryFromQuads(subject, quads);
        if (entry) snapshot.push(entry);

        // Follow rdf:rest → BlankNode chains so every cons-cell in the list is
        // emitted together with its quads (including rdf:first → member triples).
        for (const q of quads) {
          if (q.predicate?.value !== RDF_REST_IRI) continue;
          if (q.object?.termType !== "BlankNode") continue;
          const bnSubject = `_:${String(q.object.value)}`;
          if (!processed.has(bnSubject)) {
            queue.push(bnSubject);
          }
        }
      } catch (err) {
        console.error("[rdfManager.worker] prepareSubjectEmissionFromSet item failed", err);
      }
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
              { reason: "syncLoad", graphName },
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
                { reason: "removeGraph", graphName },
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
                { reason: "removeAllQuadsForIri", graphName },
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
            ontologyUrl,
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
                  (payload as any).forceGraph ||
                  !incoming.graph || !incoming.graph.termType || incoming.graph.termType === "DefaultGraph"
                    ? targetGraph
                    : incoming.graph;
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

          if (ontologyUrl && touchedSubjects.size > 0) {
            const ontUrlNode = DataFactory.namedNode(ontologyUrl);
            const loadedFromNode = DataFactory.namedNode(VG_LOADED_FROM);
            const ontGraphTerm = DataFactory.namedNode("urn:vg:ontologies");
            for (const subj of touchedSubjects) {
              try {
                const subjNode = DataFactory.namedNode(subj);
                store.addQuad(DataFactory.quad(subjNode, loadedFromNode, ontUrlNode, ontGraphTerm));
              } catch (_) { /* ignore */ }
            }
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
                { reason: "importSerialized", graphName },
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
        case "syncRemoveBatchSubjectsFromGraph": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const batchGraphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : "urn:vg:ontologies";
          const batchIris: string[] =
            payload && typeof payload === "object" && Array.isArray(payload.subjects)
              ? payload.subjects.map(String).filter(Boolean)
              : [];
          const batchGraphTerm = createGraphTerm(batchGraphName, DataFactory);
          const batchTouched = new Set<string>();
          let batchRemoved = 0;
          for (const iri of batchIris) {
            try {
              const subjTerm = DataFactory.namedNode(iri);
              const subjectQuads = store.getQuads(subjTerm, null, null, batchGraphTerm) || [];
              for (const q of subjectQuads) {
                store.removeQuad(q);
                batchRemoved += 1;
                batchTouched.add(subjectTermToString(q.subject));
              }
            } catch (err) {
              console.error("[rdfManager.worker] syncRemoveBatchSubjectsFromGraph failed for", iri, err);
            }
          }
          if (batchRemoved > 0) {
            const emission = prepareSubjectEmissionFromSet(batchTouched, store, DataFactory);
            emitChange({ reason: "removeSubjectsFromGraph", graphName: batchGraphName, removed: batchRemoved });
            emitSubjects(emission.subjects, emission.quadsBySubject, emission.snapshot, { reason: "removeSubjectsFromGraph", graphName: batchGraphName, removedSubjects: Array.from(batchTouched) });
          }
          result = { graphName: batchGraphName, removed: batchRemoved };
          break;
        }
        case "unloadOntologySubjects": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const unloadUrl =
            payload && typeof payload === "object" && typeof payload.ontologyUrl === "string"
              ? payload.ontologyUrl
              : "";
          if (!unloadUrl) { result = { removed: 0, removedSubjects: [] }; break; }

          const ontGraphTerm = DataFactory.namedNode("urn:vg:ontologies");
          const loadedFromNode = DataFactory.namedNode(VG_LOADED_FROM);
          const ontUrlNode = DataFactory.namedNode(unloadUrl);

          // Find all subjects annotated with this ontology URL
          const annotatedSubjects: string[] = [];
          try {
            const annQuads = store.getQuads(null, loadedFromNode, ontUrlNode, ontGraphTerm) || [];
            for (const q of annQuads) {
              const s = subjectTermToString(q.subject);
              if (s) annotatedSubjects.push(s);
            }
          } catch (_) { /* ignore */ }

          const removedSubjects: string[] = [];
          const touchedForEmit = new Set<string>();

          for (const subj of annotatedSubjects) {
            try {
              const subjNode = DataFactory.namedNode(subj);
              // Remove this ontology's loadedFrom annotation
              store.removeQuad(DataFactory.quad(subjNode, loadedFromNode, ontUrlNode, ontGraphTerm));
              // Check if any other loadedFrom annotation remains
              const remaining = store.getQuads(subjNode, loadedFromNode, null, ontGraphTerm) || [];
              if (remaining.length === 0) {
                // No other ontology claims this subject — remove all its quads from ontologies graph
                const subjQuads = store.getQuads(subjNode, null, null, ontGraphTerm) || [];
                for (const q of subjQuads) {
                  store.removeQuad(q);
                }
                removedSubjects.push(subj);
              }
              touchedForEmit.add(subj);
            } catch (err) {
              console.error("[rdfManager.worker] unloadOntologySubjects failed for", subj, err);
            }
          }

          if (touchedForEmit.size > 0) {
            const emission = prepareSubjectEmissionFromSet(touchedForEmit, store, DataFactory);
            emitChange({ reason: "unloadOntologySubjects", ontologyUrl: unloadUrl, removed: removedSubjects.length });
            emitSubjects(emission.subjects, emission.quadsBySubject, emission.snapshot, { reason: "unloadOntologySubjects", ontologyUrl: unloadUrl, removedSubjects });
          }
          result = { removed: removedSubjects.length, removedSubjects };
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

          // Collect quads from the requested graph PLUS urn:vg:inferred.
          // For inferred quads, apply "data-grounded" filtering: only keep inferred
          // triples whose subject is a NamedNode present in the data graph.
          // This eliminates OWL-vocabulary self-inferences, literal-as-subject noise,
          // and reflexive owl:sameAs trivia that the reasoner produces as side-effects.
          const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";
          const graphTerm = createGraphTerm(graphName, DataFactory);
          const inferredTerm = DataFactory.namedNode("urn:vg:inferred");
          const primaryQuads: Quad[] = store.getQuads(null, null, null, graphTerm) || [];

          // Build the set of data-graph subjects for inferred-triple filtering
          const dataSubjects = new Set<string>();
          for (const q of primaryQuads) {
            if (q.subject.termType === "NamedNode") dataSubjects.add(q.subject.value);
          }

          const rawInferred: Quad[] =
            graphName !== "urn:vg:inferred"
              ? (store.getQuads(null, null, null, inferredTerm) || [])
              : [];

          const filteredInferred = rawInferred.filter((q) => {
            // Must be grounded in data (subject is a NamedNode known from the data graph)
            if (q.subject.termType !== "NamedNode") return false;
            if (!dataSubjects.has(q.subject.value)) return false;
            // Drop reflexive owl:sameAs (X sameAs X)
            if (
              q.predicate.value === OWL_SAME_AS &&
              q.object.termType === "NamedNode" &&
              q.object.value === q.subject.value
            ) return false;
            return true;
          });

          // Merge, deduplicating by quad key
          const seenKeys = new Set<string>();
          const mergedQuads: Quad[] = [];
          for (const q of [...primaryQuads, ...filteredInferred]) {
            const k = quadKeyFromTerms(q);
            if (!seenKeys.has(k)) { seenKeys.add(k); mergedQuads.push(q); }
          }

          const toWrite: Quad[] = formatInfo.dropGraph
            ? mergedQuads.map((q) =>
                DataFactory.quad(q.subject, q.predicate, q.object, DataFactory.defaultGraph()),
              )
            : mergedQuads;

          let output: string;

          if (formatInfo.mediaType === "application/ld+json") {
            // N3.js Writer does not support JSON-LD — build expanded JSON-LD manually.
            const nodeMap = new Map<string, Record<string, any[]>>();
            for (const q of toWrite) {
              const subjId =
                q.subject.termType === "BlankNode"
                  ? `_:${q.subject.value}`
                  : q.subject.value;
              if (!nodeMap.has(subjId)) nodeMap.set(subjId, { "@id": subjId } as any);
              const node = nodeMap.get(subjId)!;
              const predId = q.predicate.value;
              if (!node[predId]) node[predId] = [];
              if (q.object.termType === "NamedNode") {
                node[predId].push({ "@id": q.object.value });
              } else if (q.object.termType === "BlankNode") {
                node[predId].push({ "@id": `_:${q.object.value}` });
              } else {
                const lit: Record<string, string> = { "@value": q.object.value };
                if ((q.object as any).language) {
                  lit["@language"] = (q.object as any).language;
                } else if (
                  (q.object as any).datatype &&
                  (q.object as any).datatype.value !== "http://www.w3.org/2001/XMLSchema#string"
                ) {
                  lit["@type"] = (q.object as any).datatype.value;
                }
                node[predId].push(lit);
              }
            }
            output = JSON.stringify(Array.from(nodeMap.values()), null, 2);
          } else if (formatInfo.mediaType === "application/rdf+xml") {
            // N3.js Writer does not support RDF/XML — build it manually.
            const xe = (s: string) =>
              s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
            // Build prefix → namespace map; auto-assign short prefixes for unknown namespaces.
            const ns: Record<string, string> = { rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#", ...workerNamespaces };
            const nsReverse = new Map<string, string>(Object.entries(ns).map(([p, u]) => [u, p]));
            let autoIdx = 0;
            const qname = (iri: string): string => {
              const hash = iri.lastIndexOf("#");
              const slash = iri.lastIndexOf("/");
              const cut = Math.max(hash, slash);
              if (cut <= 0) return null as any;
              const nsUri = iri.slice(0, cut + 1);
              const local = iri.slice(cut + 1);
              if (!local || /\s/.test(local)) return null as any;
              if (!nsReverse.has(nsUri)) {
                const p = `ns${autoIdx++}`;
                nsReverse.set(nsUri, p);
                ns[p] = nsUri;
              }
              return `${nsReverse.get(nsUri)}:${local}`;
            };
            // Pre-scan predicates to populate ns map before building header
            for (const q of toWrite) qname(q.predicate.value);
            const nsAttrs = Object.entries(ns)
              .map(([p, u]) => `xmlns:${p}="${xe(u)}"`)
              .join("\n      ");
            const lines: string[] = [
              '<?xml version="1.0" encoding="UTF-8"?>',
              `<rdf:RDF ${nsAttrs}>`,
            ];
            // Group by subject
            const subjectMap = new Map<string, Quad[]>();
            for (const q of toWrite) {
              const k = q.subject.termType === "BlankNode" ? `_:${q.subject.value}` : q.subject.value;
              if (!subjectMap.has(k)) subjectMap.set(k, []);
              subjectMap.get(k)!.push(q);
            }
            for (const [subjId, qs] of subjectMap) {
              const aboutAttr = subjId.startsWith("_:")
                ? `rdf:nodeID="${xe(subjId.slice(2))}"`
                : `rdf:about="${xe(subjId)}"`;
              lines.push(`  <rdf:Description ${aboutAttr}>`);
              for (const q of qs) {
                const pq = qname(q.predicate.value);
                const tag = pq || `rdf:predicate rdf:resource="${xe(q.predicate.value)}"`;
                if (q.object.termType === "NamedNode") {
                  lines.push(`    <${tag} rdf:resource="${xe(q.object.value)}"/>`);
                } else if (q.object.termType === "BlankNode") {
                  lines.push(`    <${tag} rdf:nodeID="${xe(q.object.value)}"/>`);
                } else {
                  let attrs = "";
                  if ((q.object as any).language) {
                    attrs = ` xml:lang="${xe((q.object as any).language)}"`;
                  } else if (
                    (q.object as any).datatype &&
                    (q.object as any).datatype.value !== "http://www.w3.org/2001/XMLSchema#string"
                  ) {
                    attrs = ` rdf:datatype="${xe((q.object as any).datatype.value)}"`;
                  }
                  lines.push(`    <${tag}${attrs}>${xe(q.object.value)}</${tag}>`);
                }
              }
              lines.push(`  </rdf:Description>`);
            }
            lines.push("</rdf:RDF>");
            output = lines.join("\n");
          } else {
            // Turtle (and any other N3.js-supported format)
            const writer = new (N3 as any).Writer({
              prefixes: { ...workerNamespaces },
              format: formatInfo.writerFormat,
            });
            writer.addQuads(toWrite);
            output = await new Promise((resolve, reject) => {
              writer.end((err: unknown, res: unknown) => {
                if (err) { reject(err); return; }
                resolve(typeof res === "string" ? res : String(res ?? ""));
              });
            });
          }

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
        case "renameNamespaceUri": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const { oldUri, newUri, allNamespaceUris } =
            payload as RenameNamespaceUriPayload;

          if (!oldUri || !newUri || oldUri === newUri) {
            result = { renamed: 0 };
            break;
          }

          // Sort all namespace URIs longest-first for prefix disambiguation.
          const baseUris = allNamespaceUris.includes(oldUri)
            ? allNamespaceUris
            : [...allNamespaceUris, oldUri];
          const sortedUris = [...baseUris].sort((a, b) => b.length - a.length);

          // Find the longest namespace URI that an IRI starts with.
          // Returns undefined if none match.
          const longestMatch = (iri: string): string | undefined =>
            sortedUris.find((u) => iri.startsWith(u));

          // Replace the oldUri prefix with newUri in a named-node IRI, if it matches.
          // Returns null if this IRI should not be renamed.
          const maybeRename = (iri: string): string | null => {
            if (!iri.startsWith(oldUri)) return null;
            if (longestMatch(iri) !== oldUri) return null;
            return newUri + iri.slice(oldUri.length);
          };

          const quads = store.getQuads(null, null, null, null) || [];
          let renamed = 0;
          const touchedSubjects = new Set<string>();

          for (const q of quads) {
            try {
              const sVal = q.subject?.value ?? "";
              const pVal = q.predicate?.value ?? "";
              const oIsNamed = q.object?.termType === "NamedNode";
              const oVal = oIsNamed ? (q.object?.value ?? "") : "";
              const gVal = q.graph?.termType === "NamedNode" ? (q.graph?.value ?? "") : "";

              const newS = maybeRename(sVal);
              const newP = maybeRename(pVal);
              const newO = oIsNamed ? maybeRename(oVal) : null;
              const newG = gVal ? maybeRename(gVal) : null;

              if (newS === null && newP === null && newO === null && newG === null) continue;

              store.removeQuad(q);

              const subj = DataFactory.namedNode(newS ?? sVal);
              const pred = DataFactory.namedNode(newP ?? pVal);
              let obj = q.object;
              if (newO !== null) obj = DataFactory.namedNode(newO);
              const graph =
                newG !== null
                  ? DataFactory.namedNode(newG)
                  : q.graph?.termType === "NamedNode"
                  ? DataFactory.namedNode(gVal)
                  : DataFactory.defaultGraph();

              store.addQuad(subj, pred, obj, graph);
              renamed += 1;
              touchedSubjects.add(newS !== null ? newS : subjectTermToString(q.subject));
            } catch (err) {
              console.debug("[rdfManager.worker] renameNamespaceUri failed for quad", err);
            }
          }

          if (renamed > 0) {
            emitChange({ reason: "renameNamespaceUri", oldUri, newUri, renamed });
            const emission = prepareSubjectEmissionFromSet(touchedSubjects, store, DataFactory);
            if (emission.subjects.length > 0) {
              emitSubjects(
                emission.subjects,
                emission.quadsBySubject,
                emission.snapshot,
              );
            }
          }

          result = { renamed };
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
          // Collect the set of subjects from the requested graph, then re-fetch
          // complete quad sets (all graphs) for each subject so that inferred quads
          // from urn:vg:inferred are included in the emitted snapshot.
          const graphQuads = store.getQuads(null, null, null, graphTerm) || [];
          const subjectSet = new Set<string>();
          for (const q of graphQuads) {
            try {
              const s = subjectTermToString(q.subject);
              if (s && !isBlacklistedIri(s)) subjectSet.add(s);
            } catch (_) { /* ignore */ }
          }
          const emission = prepareSubjectEmissionFromSet(subjectSet, store, DataFactory);
          // Diagnostic: log total quad count across all subjects so we can verify inferred quads are included
          const totalQuadCount = Object.values(emission.quadsBySubject).reduce((s, qs) => s + qs.length, 0);
          console.debug("[emitAllSubjects] subjects:", emission.subjects.length, "totalQuads:", totalQuadCount, "graph:", graphName);
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
      // Always reason on a working copy so the N3 Reasoner's internal _addToIndex
      // calls (which write string-keyed entries) never pollute the main store.
      // After reasoning we persist only the captured inferred quads to urn:vg:inferred
      // in the main store via the proper addQuad API.
      workingStore = new (StoreCls as any)();
      try {
        // Only copy data + ontology graphs — never feed previous inferred quads
        // back into the reasoner, which would accumulate spurious inferences on
        // repeated runs (OWL-RL re-applies rules to already-inferred triples).
        const sourceGraphs = [
          DataFactory.namedNode("urn:vg:data"),
          DataFactory.namedNode("urn:vg:ontologies"),
        ];
        for (const g of sourceGraphs) {
          workingStore.addQuads(sharedStoreRef.getQuads(null, null, null, g));
        }
      } catch (_) {
        // Fallback: reason directly on the main store (old, broken behaviour).
        // This path should never be hit with a standard N3.js store.
        workingStore = sharedStoreRef;
      }
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

    // capturedInsertions hold raw string values from the N3 Reasoner's internal _add
    // (c.subject.value, c.predicate.value, c.object.value).  Convert them directly to
    // RDF Terms and persist to urn:vg:inferred in the MAIN store.
    // No removal step is needed: the reasoner ran on a working copy so the main store
    // was never touched by string-keyed _addToIndex calls.
    if (capturedInsertions.length > 0) {
      for (const insertion of capturedInsertions) {
        const subjectTerm = termFromReasonerValue(DataFactory, insertion.subject);
        const predicateTerm = termFromReasonerValue(DataFactory, insertion.predicate);
        const objectTerm = termFromReasonerValue(DataFactory, insertion.object);
        if (!subjectTerm || !predicateTerm || !objectTerm) continue;

        const inferredQuad = DataFactory.quad(
          subjectTerm,
          predicateTerm,
          objectTerm,
          inferredGraphTerm,
        );
        const additionKey = quadKeyFromTerms(inferredQuad);
        if (!additionSeen.has(additionKey)) {
          additionSeen.add(additionKey);
          addedQuads.push(inferredQuad);

          // Persist to the main store under urn:vg:inferred
          if (mutateSharedStore && sharedStoreRef) {
            try {
              sharedStoreRef.addQuad(inferredQuad);
            } catch (_) {
              /* duplicate or store error — ignore */
            }
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
            { reason: "reasoning", graphName: "urn:vg:inferred" },
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
