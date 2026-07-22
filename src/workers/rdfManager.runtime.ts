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
import { quadMatchesRemoval, type MatchQuad } from "./verifyRepairMatch.ts";
import { WELL_KNOWN } from "../utils/wellKnownOntologies.ts";
import { ensureDefaultNamespaceMap } from "../constants/namespaces.ts";
import { RDF_TYPE, RDFS_LABEL, SHACL } from "../constants/vocabularies.ts";
import { OWL_SCHEMA_AXIOMS } from "../constants/owlSchemaData.ts";
import { mipsToReasoningError, shaclViolationToEntry } from "./reasoningDiagnostics.ts";
import { RdfReasoner, type LaconicJustification, type LaconicPart, type ValidationResult, type ExplainEntailmentOptions, type InferenceDelta } from "rdf-reasoner-konclude";

import { QueryEngine } from "@comunica/query-sparql-rdfjs";
const KONCLUDE_INFERRED_GRAPH_IRI = "urn:vg:inferred";

/**
 * Serialize a package LaconicJustification (Quad-based) into the string-based
 * format the worker→main boundary uses.
 */
type SerializedLaconicPart = {
  subject: string;
  predicate: string;
  object: string;
  objectIsLiteral?: boolean;
  sourceSubject: string;
  sourcePredicate: string;
  sourceObject: string;
  isPartOf: boolean;
};

type SerializedLaconicJustification = {
  parts: SerializedLaconicPart[];
  sharpened: boolean;
  skipped: boolean;
};

function serializeLaconicJustification(lj: LaconicJustification): SerializedLaconicJustification {
  return {
    parts: lj.parts.map((p: LaconicPart) => ({
      subject: p.quad.subject.value,
      predicate: p.quad.predicate.value,
      object: p.quad.object.value,
      ...(p.quad.object.termType === "Literal" ? { objectIsLiteral: true } : {}),
      sourceSubject: p.sourceQuad.subject.value,
      sourcePredicate: p.sourceQuad.predicate.value,
      sourceObject: p.sourceQuad.object.value,
      isPartOf: p.isPartOf,
    })),
    sharpened: lj.sharpened,
    skipped: lj.skipped,
  };
}

const INFERRED_GRAPH = KONCLUDE_INFERRED_GRAPH_IRI;



// ---------------------------------------------------------------------------
// DlReasoner — thin pass-through to rdf-reasoner-konclude RdfReasoner.
// Handles ontosphere-specific concerns: INFERRED_GRAPH mapping and
// SerializedLaconicJustification format conversion for the worker boundary.
// ---------------------------------------------------------------------------


class DlReasoner {
  readonly ready: Promise<void>;
  private readonly _reasoner: RdfReasoner;

  constructor() {
    const base = (import.meta as any).env?.BASE_URL ?? "/";
    const workerUrl = new URL(`${base}rdf-reasoner-konclude/worker.js`, self.location.href);
    this._reasoner = new RdfReasoner({ workerUrl });
    this.ready = this._reasoner.ready;
  }

  reason(store: N3.Store): Promise<{ delta: InferenceDelta }> {
    return this._reasoner.materialize(store, {
      includeClassHierarchy: true,
      inferredGraph: INFERRED_GRAPH,
      returnDelta: true,
      explanations: true,
    }) as Promise<{ delta: InferenceDelta }>;
  }

  validate(store: N3.Store): Promise<ValidationResult> {
    return this._reasoner.validate(store) as Promise<ValidationResult>;
  }

  explainInconsistency(store: N3.Store, maxJustifications = 1): Promise<N3.Quad[][]> {
    return this._reasoner.explainInconsistency(store, { maxJustifications, inferredGraph: INFERRED_GRAPH }) as Promise<N3.Quad[][]>;
  }

  explainInconsistencyLaconic(
    store: N3.Store,
    maxJustifications = 1,
  ): Promise<
    Array<{
      justification: N3.Quad[];
      laconic: SerializedLaconicJustification;
    }>
  > {
    return (async () => {
      const results = await this._reasoner.explainInconsistencyLaconic(store, { maxJustifications, inferredGraph: INFERRED_GRAPH });
      return (results as Array<{ justification: N3.Quad[]; laconic: LaconicJustification }>).map((r) => ({
        justification: r.justification as N3.Quad[],
        laconic: serializeLaconicJustification(r.laconic),
      }));
    })();
  }

  explainEntailment(
    store: N3.Store,
    subjectIri: string,
    predicateIri: string,
    objectIri: string,
    opts?: ExplainEntailmentOptions,
  ): Promise<{
    isEntailed: boolean | null;
    justifications: N3.Quad[][];
    ontologyInconsistent?: boolean;
    vacuous?: boolean;
    reason?: string;
  }> {
    return this._reasoner.explainEntailment(
      store,
      subjectIri,
      predicateIri,
      objectIri,
      { inferredGraph: INFERRED_GRAPH, justificationMode: 'causal', ...opts },
    ) as Promise<{
      isEntailed: boolean | null;
      justifications: N3.Quad[][];
      ontologyInconsistent?: boolean;
      vacuous?: boolean;
      reason?: string;
    }>;
  }

  terminate(): void {
    this._reasoner.terminate();
  }
}
const RDF_TYPE_IRI = RDF_TYPE;
const RDFS_LABEL_IRI = RDFS_LABEL;

let _cachedQueryEngine: QueryEngine | null = null;

/**
 * The subset of DlReasoner the worker runtime depends on. Declared as an
 * interface so a TEST can inject a node-compatible adapter (the production
 * DlReasoner wraps RdfReasoner which spawns a nested Web Worker,
 * unavailable under vitest's node environment).
 */
export interface DlReasonerLike {
  readonly ready: Promise<void>;
  reason(store: N3.Store): Promise<{ delta: InferenceDelta }>;
  validate(store: N3.Store): Promise<ValidationResult>;
  explainInconsistency(store: N3.Store, maxJustifications?: number): Promise<N3.Quad[][]>;
  /**
   * LACONIC inconsistency explanation (Horridge et al. ISWC 2008). OPTIONAL —
   * the production DlReasoner implements it; the test node adapter may omit
   * it (the worker handler guards on its presence and falls back to the plain
   * MIPS-only result).
   */
  explainInconsistencyLaconic?(
    store: N3.Store,
    maxJustifications?: number,
  ): Promise<
    Array<{
      justification: N3.Quad[];
      laconic: SerializedLaconicJustification;
    }>
  >;
  explainEntailment(
    store: N3.Store,
    subjectIri: string,
    predicateIri: string,
    objectIri: string,
    opts?: ExplainEntailmentOptions,
  ): Promise<{
    isEntailed: boolean | null;
    justifications: N3.Quad[][];
    ontologyInconsistent?: boolean;
    vacuous?: boolean;
    reason?: string;
  }>;
  terminate(): void;
}

let _dlReasoner: DlReasonerLike | null = null;
let _dlReasonerFactory: (() => DlReasonerLike) | null = null;

export function setDlReasonerFactoryForTest(
  factory: (() => DlReasonerLike) | null,
): void {
  if (_dlReasoner) {
    try { _dlReasoner.terminate(); } catch { /* ignore */ }
    _dlReasoner = null;
  }
  _dlReasonerFactory = factory;
}

function getDlReasoner(): DlReasonerLike {
  if (!_dlReasoner) {
    _dlReasoner = _dlReasonerFactory
      ? _dlReasonerFactory()
      : new DlReasoner();
  }
  return _dlReasoner;
}

const _entailmentCache = new Map<string, unknown>();

function resetDlReasoner(): void {
  if (_dlReasoner) {
    _dlReasoner.terminate();
    _dlReasoner = null;
  }
  _entailmentCache.clear();
}

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
  sourceShape?: string;
  justification?: { subject: string; predicate: string; object: string }[];
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
  isConsistent?: boolean | null;
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

let workerDebugEnabled = false;

function debugLog(...args: unknown[]): void {
  if (workerDebugEnabled) console.debug(...args);
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

  // ── Per-named-graph triple counters ────────────────────────────────────────
  //
  // getGraphCounts is called frequently (every reasoning report refresh, UI
  // panel update). Full-scanning the store with getQuads(null,null,null,null)
  // on every call is O(store size). Instead we maintain a Map<graphIri,count>
  // that is kept in lock-step with the shared store by wrapping its mutation
  // methods (addQuad / removeQuad / removeQuads) at store-creation time. Because
  // EVERY mutation of the shared store funnels through those methods, this single
  // wrapping point covers all mutation sites — import, syncBatch, clearInferred,
  // namespace rename, graph purge, the Konclude reasoner's inferred-quad writes,
  // etc. — without touching any of those (protected) regions.
  //
  // The map key matches collectGraphCountsFromStore's bucketing exactly:
  // a non-empty graph IRI uses that IRI; the default graph maps to
  // "urn:vg:default".
  let graphCounts: Map<string, number> = new Map();
  // True once the counters are known to mirror the live store. Any store reset
  // re-installs the wrappers and recomputes, flipping this back to true. A false
  // value forces a one-time full recompute in getGraphCounts (the fallback).
  let graphCountsReady = false;

  const DEFAULT_GRAPH_KEY = "urn:vg:default";

  function graphKeyOf(graphTerm: any): string {
    const v = graphTerm?.value;
    return typeof v === "string" && v.length > 0 ? v : DEFAULT_GRAPH_KEY;
  }

  function incGraphCount(graphTerm: any, delta: number): void {
    const key = graphKeyOf(graphTerm);
    const next = (graphCounts.get(key) || 0) + delta;
    if (next > 0) graphCounts.set(key, next);
    else graphCounts.delete(key);
  }

  /** Recompute the counter map from scratch by scanning the store once. */
  function recomputeGraphCounts(store: any): void {
    graphCounts = new Map();
    try {
      const quads = store.getQuads(null, null, null, null) || [];
      for (const q of quads) incGraphCount(q?.graph, 1);
    } catch (err) {
      debugLog("[VG_REASONING_WORKER] recomputeGraphCounts failed", err);
    }
    graphCountsReady = true;
  }

  /**
   * Wrap addQuad / removeQuad / removeQuads on a store so that every mutation
   * adjusts the incremental graph counters. N3 Store.addQuad/removeQuad return a
   * boolean indicating whether the store actually changed (dedup-aware), so the
   * counter delta is exact. removeQuads returns no delta, so we route it through
   * the wrapped removeQuad to stay precise.
   */
  function installGraphCountTracking(store: any): void {
    if (!store || store.__vgCountTracked) return;
    const origAddQuad = store.addQuad.bind(store);
    const origRemoveQuad = store.removeQuad.bind(store);
    const origAddQuads = typeof store.addQuads === "function" ? store.addQuads.bind(store) : null;

    store.addQuad = (...args: any[]) => {
      const changed = origAddQuad(...args);
      if (changed) {
        const q = args[0];
        // addQuad(quad) or addQuad(s, p, o, g)
        const graphTerm = args.length >= 4 ? args[3] : q?.graph;
        incGraphCount(graphTerm, 1);
      }
      return changed;
    };

    store.removeQuad = (...args: any[]) => {
      const changed = origRemoveQuad(...args);
      if (changed) {
        const q = args[0];
        const graphTerm = args.length >= 4 ? args[3] : q?.graph;
        incGraphCount(graphTerm, -1);
      }
      return changed;
    };

    // removeQuads(quads) — iterate through wrapped removeQuad for exact deltas.
    store.removeQuads = (quads: any) => {
      const list = Array.isArray(quads) ? quads : Array.from(quads || []);
      for (const q of list) store.removeQuad(q);
    };

    if (origAddQuads) {
      store.addQuads = (quads: any) => {
        const list = Array.isArray(quads) ? quads : Array.from(quads || []);
        for (const q of list) store.addQuad(q);
      };
    }

    Object.defineProperty(store, "__vgCountTracked", {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }

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

  function fnv1a32(str: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  // Skolemize: replace blank-node subjects/objects with stable urn:vg:bnode:{hash} IRIs.
  // Hash is derived from the blank node's label (value) only — not its predicate-object
  // pairs — so the same label always maps to the same IRI regardless of batch size.
  // This enables building blank-node restrictions via individual addTriple calls:
  // every call that references "_:b0" produces the same urn:vg:bnode: IRI.
  // Callers are responsible for using distinct labels for distinct blank nodes.
  function skolemizeQuads(quads: Quad[], DataFactory: any): Quad[] {
    const hasBnodes = quads.some(
      (q) => q.subject.termType === "BlankNode" || q.object.termType === "BlankNode"
    );
    if (!hasBnodes) return quads;

    const cache = new Map<string, string>();
    const toIri = (id: string): string => {
      if (!cache.has(id)) cache.set(id, `urn:vg:bnode:${fnv1a32(id)}`);
      return cache.get(id)!;
    };

    return quads.map((q) => {
      const subj = q.subject.termType === "BlankNode"
        ? DataFactory.namedNode(toIri(q.subject.value))
        : q.subject;
      const obj = q.object.termType === "BlankNode"
        ? DataFactory.namedNode(toIri((q.object as any).value))
        : q.object;
      if (subj === q.subject && obj === q.object) return q;
      return DataFactory.quad(subj, q.predicate, obj, q.graph);
    });
  }

  function resetSharedStore(options?: { restore?: boolean }) {
    const { StoreCls, DataFactory } = resolveN3();
    if (!StoreCls) throw new Error("n3-store-unavailable");
    sharedStore = new (StoreCls as any)();
    workerChangeCounter = 0;
    graphCounts = new Map();
    graphCountsReady = true;
    installGraphCountTracking(sharedStore);
    // Non-negotiable: always seed the store with OWL/RDFS/RDF meta-ontology axioms
    if (DataFactory) loadSchemaOntology(sharedStore, DataFactory);
    return sharedStore;
  }

  function getSharedStore() {
    if (sharedStore) return sharedStore;
    return resetSharedStore({ restore: true });
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
      debugLog("[rdfManager.worker] reasoningStage emission skipped", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Streaming liveness signal during a large importSerialized. Uses the same
  // {type:"event"} envelope that emitChange/emitSubjects use, so clients can
  // subscribe via worker.on("importProgress", cb).
  function emitImportProgress(
    id: string,
    loaded: number,
    graphName?: string,
    total?: number,
  ) {
    try {
      post({
        type: "event",
        event: "importProgress",
        payload: {
          id,
          loaded,
          ...(typeof total === "number" ? { total } : {}),
          ...(graphName ? { graphName } : {}),
        },
      });
    } catch (err) {
      debugLog("[rdfManager.worker] importProgress emission skipped", {
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
      const langMatch = /^"(.*)"@([a-zA-Z-]+)$/.exec(str);
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

  interface ShaclViolation {
    focusNode: string | null;
    path: string | null;
    severity: string | null;
    message: string | null;
    sourceShape: string | null;
    constraint: string | null;
    source: "shacl";
  }

  interface ShaclValidationResult {
    conforms: boolean;
    violations: ShaclViolation[];
    shapeCount: number;
  }

  async function runShaclValidation(): Promise<ShaclValidationResult> {
    const { DataFactory } = resolveN3();
    if (!DataFactory) throw new Error("n3-datafactory-unavailable");
    const store = getSharedStore();

    const shapesGraph = DataFactory.namedNode("urn:vg:shapes");
    const shapesQuads = store.getQuads(null, null, null, shapesGraph) || [];
    if (shapesQuads.length === 0) {
      return { conforms: true, violations: [], shapeCount: 0 };
    }

    const dataGraph = DataFactory.namedNode("urn:vg:data");
    const inferredGraph = DataFactory.namedNode("urn:vg:inferred");
    const dataQuads = [
      ...(store.getQuads(null, null, null, dataGraph) || []),
      ...(store.getQuads(null, null, null, inferredGraph) || []),
    ];

    const [shaclMod, sparqlMod, dataModelMod, datasetMod] = await Promise.all([
      import("shacl-engine") as Promise<any>,
      import("shacl-engine/sparql.js") as Promise<any>,
      import("@rdfjs/data-model") as Promise<any>,
      import("@rdfjs/dataset") as Promise<any>,
    ]);
    const { Validator } = shaclMod;
    const { targetResolvers } = sparqlMod;
    const factory = dataModelMod.default ?? dataModelMod;
    const dataset = datasetMod.default?.dataset ?? datasetMod.dataset;

    function convertTerm(term: any) {
      if (term.termType === "BlankNode") return factory.blankNode(term.value);
      if (term.termType === "Literal")
        return factory.literal(term.value, term.language || (term.datatype ? factory.namedNode(term.datatype.value) : undefined));
      return factory.namedNode(term.value);
    }

    const shapesDs = dataset();
    for (const q of shapesQuads) {
      shapesDs.add(factory.quad(convertTerm(q.subject), factory.namedNode(q.predicate.value), convertTerm(q.object)));
    }

    const dataDs = dataset();
    for (const q of dataQuads) {
      dataDs.add(factory.quad(convertTerm(q.subject), factory.namedNode(q.predicate.value), convertTerm(q.object)));
    }

    const SH_NODESHAPE = "http://www.w3.org/ns/shacl#NodeShape";

    const shapeCount = [...shapesDs].filter(
      (q: any) => q.predicate.value === RDF_TYPE && q.object.value === SH_NODESHAPE,
    ).length;

    const validator = new Validator(shapesDs, { factory, targetResolvers });
    let report: any;
    try {
      report = await validator.validate({ dataset: dataDs });
    } catch (valErr: any) {
      const msg = valErr?.message ?? String(valErr);
      return {
        conforms: false,
        violations: [{
          focusNode: null, path: null, severity: "sh:Violation",
          message: `Validation engine error: ${msg}`,
          sourceShape: null, constraint: null, source: "shacl" as const,
        }],
        shapeCount,
      };
    }

    // Build reverse map: property shape (blank node) → parent NodeShape IRI
    const SH_PROPERTY = "http://www.w3.org/ns/shacl#property";
    const propShapeToNodeShape = new Map<string, string>();
    for (const q of [...shapesDs] as any[]) {
      if (q.predicate.value === SH_PROPERTY && q.subject.termType === "NamedNode") {
        propShapeToNodeShape.set(q.object.value, q.subject.value);
      }
    }

    // Collect subjects present in user data so we can exclude ontology classes
    // that reasoning materialized into the inferred graph.
    const dataSubjects = new Set<string>();
    for (const q of store.getQuads(null, null, null, dataGraph) || []) {
      if (q.subject?.value) dataSubjects.add(q.subject.value);
    }

    const violations: ShaclViolation[] = (report.results ?? []).map((r: any) => {
      let shapeVal = r.shape?.ptr?.term?.value ?? null;
      if (shapeVal && propShapeToNodeShape.has(shapeVal)) {
        shapeVal = propShapeToNodeShape.get(shapeVal)!;
      }
      const pathVal = Array.isArray(r.path) ? (r.path[0]?.predicates?.[0]?.value ?? null) : (r.path?.value ?? null);
      const msgVal = Array.isArray(r.message)
        ? r.message.map((m: any) => m.value).join("; ")
        : (typeof r.message === "string" ? r.message : (r.message?.value ?? null));
      return {
        focusNode: r.focusNode?.value ?? null,
        path: pathVal,
        severity: r.severity?.value?.replace("http://www.w3.org/ns/shacl#", "sh:") ?? null,
        message: msgVal,
        sourceShape: shapeVal,
        constraint: r.constraintComponent?.value ?? null,
        source: "shacl" as const,
      };
    }).filter((v: ShaclViolation) => !v.focusNode || dataSubjects.has(v.focusNode));

    return { conforms: report.conforms, violations, shapeCount };
  }

  function collectGraphCountsFromStore(store: any): Record<string, number> {
    // Fast path: for the live shared store, serve from the maintained counters
    // (O(graphs)) instead of scanning every quad. The counters are kept in
    // lock-step via the wrapped mutation methods installed in resetSharedStore.
    // Fallback: if the counters were never initialised for this store (e.g. a
    // store created before tracking was installed), recompute once and cache.
    if (store && store === sharedStore) {
      if (!graphCountsReady || !store.__vgCountTracked) {
        recomputeGraphCounts(store);
      }
      const out: Record<string, number> = {};
      for (const [k, v] of graphCounts) out[k] = v;
      return out;
    }

    // Transient / non-shared store (e.g. reasoning working copies): full scan.
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
      debugLog("[VG_REASONING_WORKER] collectGraphCountsFromStore failed", err);
    }
    return counts;
  }

  function collectOntologyStats(store: any): Record<string, unknown> {
    const DATA_GRAPH_IRI = "urn:vg:data";
    const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
    const OWL_CLASS = "http://www.w3.org/2002/07/owl#Class";
    const RDFS_CLASS = "http://www.w3.org/2000/01/rdf-schema#Class";
    const OWL_OBJECT_PROPERTY = "http://www.w3.org/2002/07/owl#ObjectProperty";
    const OWL_DATATYPE_PROPERTY = "http://www.w3.org/2002/07/owl#DatatypeProperty";
    const OWL_NAMED_INDIVIDUAL = "http://www.w3.org/2002/07/owl#NamedIndividual";
    const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";

    try {
      const toSet = (quads: any[]): Set<string> => {
        const s = new Set<string>();
        for (const q of quads) {
          const v = q?.subject?.value;
          if (typeof v === "string" && v.length > 0) s.add(v);
        }
        return s;
      };

      const owlClasses = toSet(store.getQuads(null, RDF_TYPE, OWL_CLASS, DATA_GRAPH_IRI));
      const rdfsClasses = toSet(store.getQuads(null, RDF_TYPE, RDFS_CLASS, DATA_GRAPH_IRI));
      const classSubjects = new Set([...owlClasses, ...rdfsClasses]);

      const objectPropertyCount = toSet(store.getQuads(null, RDF_TYPE, OWL_OBJECT_PROPERTY, DATA_GRAPH_IRI)).size;
      const datatypePropertyCount = toSet(store.getQuads(null, RDF_TYPE, OWL_DATATYPE_PROPERTY, DATA_GRAPH_IRI)).size;
      const namedIndividualCount = toSet(store.getQuads(null, RDF_TYPE, OWL_NAMED_INDIVIDUAL, DATA_GRAPH_IRI)).size;

      const allQuads = store.getQuads(null, null, null, DATA_GRAPH_IRI);
      const allSubjects = new Set<string>();
      for (const q of allQuads) {
        const v = q?.subject?.value;
        if (typeof v === "string" && v.length > 0) allSubjects.add(v);
      }

      const labeledSubjects = toSet(store.getQuads(null, RDFS_LABEL, null, DATA_GRAPH_IRI));
      let labeledClassCount = 0;
      for (const cls of classSubjects) {
        if (labeledSubjects.has(cls)) labeledClassCount++;
      }

      const gc = collectGraphCountsFromStore(store);
      const assertedTriples = gc[DATA_GRAPH_IRI] || 0;
      const inferredTriples = gc["urn:vg:inferred"] || 0;
      const totalTriples = assertedTriples;

      const namespacePrefixes = Object.entries(workerNamespaces);
      const nsBuckets = new Map<string, { prefix: string; uri: string; subjects: number }>();
      for (const subj of allSubjects) {
        for (const [prefix, uri] of namespacePrefixes) {
          if (subj.startsWith(uri)) {
            const existing = nsBuckets.get(uri);
            if (existing) {
              existing.subjects++;
            } else {
              nsBuckets.set(uri, { prefix, uri, subjects: 1 });
            }
            break;
          }
        }
      }
      const namespaceBreakdown = Array.from(nsBuckets.values())
        .filter((r) => r.subjects > 0)
        .sort((a, b) => b.subjects - a.subjects);

      return {
        totalTriples,
        classCount: classSubjects.size,
        objectPropertyCount,
        datatypePropertyCount,
        namedIndividualCount,
        subjectCount: allSubjects.size,
        labeledClassCount,
        assertedTriples,
        inferredTriples,
        namespaceBreakdown,
      };
    } catch (err) {
      debugLog("[VG_REASONING_WORKER] collectOntologyStats failed", err);
      return {
        totalTriples: 0,
        classCount: 0,
        objectPropertyCount: 0,
        datatypePropertyCount: 0,
        namedIndividualCount: 0,
        subjectCount: 0,
        labeledClassCount: 0,
        assertedTriples: 0,
        inferredTriples: 0,
        namespaceBreakdown: [],
      };
    }
  }

  // ── searchTerms (grounding / retrieval) ───────────────────────────────────
  //
  // Pure store query: find existing ontology terms by label or IRI local-name
  // across ALL graphs (especially urn:vg:ontologies) so agents reuse existing
  // IRIs instead of minting new ones. No reasoner involved.

  type SearchKind = "class" | "objectProperty" | "datatypeProperty" | "property" | "individual";

  type SearchTermResult = {
    iri: string;
    label: string;
    kind: SearchKind;
    prefix?: string;
    score: number;
  };

  const SKOS_PREF_LABEL = "http://www.w3.org/2004/02/skos/core#prefLabel";
  const SKOS_ALT_LABEL = "http://www.w3.org/2004/02/skos/core#altLabel";
  // rdf:type object IRI → the search kind it implies.
  const TYPE_IRI_TO_KIND: Record<string, SearchKind> = {
    "http://www.w3.org/2002/07/owl#Class": "class",
    "http://www.w3.org/2000/01/rdf-schema#Class": "class",
    "http://www.w3.org/2002/07/owl#ObjectProperty": "objectProperty",
    "http://www.w3.org/2002/07/owl#DatatypeProperty": "datatypeProperty",
    "http://www.w3.org/2002/07/owl#AnnotationProperty": "property",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property": "property",
    "http://www.w3.org/2002/07/owl#NamedIndividual": "individual",
  };
  // A requested kind matches a candidate's kind set. "property" is an umbrella
  // that also accepts object/datatype/annotation properties.
  function kindMatchesRequest(requested: Set<SearchKind>, candidateKinds: Set<SearchKind>): boolean {
    for (const k of candidateKinds) {
      if (requested.has(k)) return true;
      if (requested.has("property") && (k === "objectProperty" || k === "datatypeProperty")) {
        return true;
      }
    }
    return false;
  }

  function localNameOf(iri: string): string {
    const hash = iri.lastIndexOf("#");
    if (hash >= 0) return iri.slice(hash + 1);
    const slash = iri.lastIndexOf("/");
    if (slash >= 0) return iri.slice(slash + 1);
    const colon = iri.lastIndexOf(":");
    if (colon >= 0) return iri.slice(colon + 1);
    return iri;
  }

  // Resolve the prefix for an IRI: prefer the worker's live namespace map, then
  // fall back to the well-known registry, using longest-namespace-wins so more
  // specific namespaces (e.g. pmdco) beat broad ones.
  function resolvePrefixForIri(iri: string): string | undefined {
    let best: { prefix: string; len: number } | undefined;
    const consider = (prefix: string, ns: string) => {
      if (!ns || !prefix) return;
      if (!iri.startsWith(ns)) return;
      if (!best || ns.length > best.len) best = { prefix, len: ns.length };
    };
    for (const [prefix, ns] of Object.entries(workerNamespaces)) consider(prefix, String(ns));
    const wk = WELL_KNOWN?.prefixes ?? {};
    for (const [prefix, ns] of Object.entries(wk)) consider(prefix, String(ns));
    return best?.prefix;
  }

  /**
   * Ranking (higher = better match):
   *   100  exact label match
   *    80  label startsWith query
   *    60  label substring contains query
   *    50  exact local-name match
   *    40  local-name startsWith query
   *    30  local-name substring contains query
   * A small +5 bonus is added when the term has any label at all (prefer
   * documented terms). The best (highest) score across all of a term's labels
   * and its local name is kept.
   */
  function scoreMatch(query: string, labels: string[], localName: string): number {
    const q = query.trim().toLowerCase();
    if (!q) return 0;
    let best = 0;
    for (const raw of labels) {
      const label = String(raw || "").toLowerCase();
      if (!label) continue;
      if (label === q) best = Math.max(best, 100);
      else if (label.startsWith(q)) best = Math.max(best, 80);
      else if (label.includes(q)) best = Math.max(best, 60);
    }
    const ln = localName.toLowerCase();
    if (ln === q) best = Math.max(best, 50);
    else if (ln.startsWith(q)) best = Math.max(best, 40);
    else if (ln.includes(q)) best = Math.max(best, 30);
    if (best > 0 && labels.some((l) => String(l || "").trim().length > 0)) best += 5;
    return best;
  }

  function searchTermsInStore(
    store: any,
    payload: RDFWorkerCommandPayloads["searchTerms"],
  ): { results: SearchTermResult[] } {
    const query = String(payload?.query ?? "").trim();
    const limit =
      typeof payload?.limit === "number" && payload.limit > 0 ? Math.floor(payload.limit) : 25;
    const requestedKinds = new Set<SearchKind>(
      payload?.kinds && payload.kinds.length > 0
        ? payload.kinds
        : (["class", "objectProperty", "datatypeProperty", "property"] as SearchKind[]),
    );
    if (!query) return { results: [] };

    // Accumulate per-subject metadata across ALL graphs in one store pass.
    const meta = new Map<string, { kinds: Set<SearchKind>; labels: string[] }>();
    const ensure = (iri: string) => {
      let entry = meta.get(iri);
      if (!entry) {
        entry = { kinds: new Set<SearchKind>(), labels: [] };
        meta.set(iri, entry);
      }
      return entry;
    };

    const allQuads = store.getQuads(null, null, null, null) || [];
    for (const q of allQuads) {
      const subj = q?.subject;
      if (!subj || subj.termType !== "NamedNode") continue; // skip blank nodes / literals
      const subjIri = String(subj.value || "");
      if (!subjIri) continue;
      const pred = String(q?.predicate?.value || "");
      const obj = q?.object;

      if (pred === RDF_TYPE_IRI && obj?.termType === "NamedNode") {
        const kind = TYPE_IRI_TO_KIND[String(obj.value)];
        if (kind) ensure(subjIri).kinds.add(kind);
        continue;
      }
      if (
        (pred === RDFS_LABEL_IRI || pred === SKOS_PREF_LABEL || pred === SKOS_ALT_LABEL) &&
        obj?.termType === "Literal"
      ) {
        const text = String(obj.value || "").trim();
        if (text) ensure(subjIri).labels.push(text);
      }
    }

    const results: SearchTermResult[] = [];
    for (const [iri, entry] of meta) {
      // Only terms whose declared kind set intersects the requested kinds.
      if (entry.kinds.size === 0) continue;
      if (!kindMatchesRequest(requestedKinds, entry.kinds)) continue;

      const localName = localNameOf(iri);
      const score = scoreMatch(query, entry.labels, localName);
      if (score <= 0) continue;

      // Pick the representative kind: prefer one the caller actually asked for.
      let kind: SearchKind | undefined;
      for (const k of entry.kinds) {
        if (
          requestedKinds.has(k) ||
          (requestedKinds.has("property") && (k === "objectProperty" || k === "datatypeProperty"))
        ) {
          kind = k;
          break;
        }
      }
      if (!kind) kind = entry.kinds.values().next().value as SearchKind;

      results.push({
        iri,
        label: entry.labels[0] ?? "",
        kind,
        prefix: resolvePrefixForIri(iri),
        score,
      });
    }

    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Stable secondary ordering: labelled before unlabelled, then by IRI.
      const al = a.label ? 0 : 1;
      const bl = b.label ? 0 : 1;
      if (al !== bl) return al - bl;
      return a.iri.localeCompare(b.iri);
    });

    return { results: results.slice(0, limit) };
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
      debugLog("[rdfManager.worker] createReadableFromString failed", err);
      return null;
    }
  }

  /**
   * Resolve an export format string into the writer format + media type, and crucially
   * whether the serialisation can REPRESENT named graphs.
   *
   * `dropGraph:true`  → single-graph formats (Turtle / JSON-LD / RDF-XML). These cannot
   *                     encode quads, so every quad must be remapped into the default
   *                     graph before writing. The multi-graph partition is flattened.
   * `dropGraph:false` → dataset formats (N-Quads / TriG). N3.js' Writer emits the graph
   *                     term for each quad, so the urn:vg:* partition round-trips intact.
   *
   * For dataset formats we also flag `dataset:true`, which the export handler uses to
   * decide it should collect quads from ALL urn:vg:* graphs rather than a single graph.
   */
  function normalizeExportFormat(format?: string) {
    const raw = typeof format === "string" ? format.toLowerCase().trim() : "";
    if (raw === "application/ld+json" || raw === "ld+json" || raw === "jsonld" || raw === "json-ld") {
      return { writerFormat: "application/ld+json", mediaType: "application/ld+json", dropGraph: true, dataset: false };
    }
    if (raw === "application/rdf+xml" || raw === "rdfxml" || raw === "rdf+xml" || raw === "rdf-xml") {
      return { writerFormat: "application/rdf+xml", mediaType: "application/rdf+xml", dropGraph: true, dataset: false };
    }
    if (raw === "application/n-quads" || raw === "nquads" || raw === "n-quads") {
      return { writerFormat: "application/n-quads", mediaType: "application/n-quads", dropGraph: false, dataset: true };
    }
    if (raw === "application/trig" || raw === "trig") {
      return { writerFormat: "application/trig", mediaType: "application/trig", dropGraph: false, dataset: true };
    }
    return { writerFormat: "text/turtle", mediaType: "text/turtle", dropGraph: true, dataset: false };
  }

  /**
   * The complete set of named graphs that make up a VocabGraph "dataset". Dataset-faithful
   * exports (N-Quads / TriG) collect quads from every one of these so the five-graph
   * partition round-trips. Order is deterministic for stable output.
   */
  const VG_DATASET_GRAPHS = [
    "urn:vg:data",
    "urn:vg:inferred",
    "urn:vg:shapes",
    "urn:vg:ontologies",
    "urn:vg:workflows",
  ] as const;



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
        case "getOntologyStats":
          result = collectOntologyStats(getSharedStore());
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
        case "setDebug":
          workerDebugEnabled = !!(payload && typeof payload === "object" && (payload as { enabled?: unknown }).enabled);
          result = { enabled: workerDebugEnabled };
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
            const rawQuads = (payload.quads as any[]).map((pq) => deserializeQuad(pq, DataFactory));
            for (const quad of skolemizeQuads(rawQuads, DataFactory)) {
              try {
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
          if (removed > 0) resetDlReasoner();
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

          // Buffer raw parsed quads, then skolemize as a batch after the stream
          // ends — this ensures content-hash consistency across the whole parse.
          const parsedBuffer: Quad[] = [];

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
                parsedBuffer.push(DataFactory.quad(
                  incoming.subject,
                  incoming.predicate,
                  incoming.object,
                  graphTerm,
                ));
              } catch (err) {
                debugLog("[rdfManager.worker] importSerialized.data failed", err);
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

          // Skolemize + insert in CHUNKS rather than buffering a second fully
          // materialised copy and then probing the store once per quad.
          //
          // Two perf wins vs. the previous implementation:
          //  1. No per-quad existence pre-check (the old store.countQuads /
          //     store.getQuads probe was O(1) amortised but allocated and ran
          //     for EVERY quad). N3 Store.addQuad already dedupes and returns a
          //     boolean telling us whether the store actually changed — so we
          //     count newly-added quads exactly without any pre-probe.
          //  2. Progress is emitted after each chunk so the client sees liveness
          //     instead of one silent freeze until the whole file is loaded.
          //
          // skolemizeQuads hashes each blank-node label independently, so
          // skolemizing per-chunk yields identical urn:vg:bnode:* IRIs as
          // skolemizing the whole batch — chunking is safe for content hashing.
          const IMPORT_CHUNK_SIZE = 5000;
          const total = parsedBuffer.length;
          let processed = 0;
          for (let start = 0; start < total; start += IMPORT_CHUNK_SIZE) {
            const slice = parsedBuffer.slice(start, start + IMPORT_CHUNK_SIZE);
            for (const normalized of skolemizeQuads(slice, DataFactory)) {
              try {
                const changed = store.addQuad(normalized);
                // N3 returns true only when the quad was not already present.
                // Use the same truthiness the counter wrapper uses so addedCount
                // and the incremental graph counter never diverge.
                if (changed) {
                  addedCount += 1;
                  touchedSubjects.add(subjectTermToString(normalized.subject));
                  addedSerialized.push(serializeQuad(normalized));
                }
              } catch (err) {
                debugLog("[rdfManager.worker] importSerialized.data failed", err);
              }
            }
            processed += slice.length;
            // Release the slice's source references eagerly to keep peak memory
            // closer to a single materialisation rather than buffer + store copy.
            for (let i = start; i < start + slice.length && i < total; i++) {
              (parsedBuffer as any)[i] = undefined;
            }
            emitImportProgress(msg.id, processed, graphName, total);
          }

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
          if (removedSubjects.length > 0) resetDlReasoner();
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

          const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";

          // ----------------------------------------------------------------------------
          // Quad collection. Two strategies:
          //
          //  (A) DATASET-FAITHFUL (N-Quads / TriG, formatInfo.dataset === true):
          //      Collect quads from EVERY urn:vg:* graph and keep their graph terms intact
          //      so the five-graph partition (data / inferred / shapes / ontologies /
          //      workflows) round-trips. No data-grounded filtering or graph-flattening is
          //      applied — a dataset export is a faithful snapshot of the store.
          //
          //  (B) SINGLE-GRAPH (Turtle / JSON-LD / RDF-XML, the historical behaviour):
          //      Collect quads from the requested graph PLUS urn:vg:inferred, apply
          //      "data-grounded" filtering to the inferred quads (only keep inferred triples
          //      whose subject is a NamedNode present in the data graph — this strips
          //      OWL-vocabulary self-inferences, literal-as-subject noise, and reflexive
          //      owl:sameAs trivia), then flatten everything into the default graph below.
          // ----------------------------------------------------------------------------
          let mergedQuads: Quad[];

          if (formatInfo.dataset) {
            // (A) Faithful dataset export across all urn:vg:* graphs.
            const seenKeys = new Set<string>();
            mergedQuads = [];
            for (const g of VG_DATASET_GRAPHS) {
              const gTerm = DataFactory.namedNode(g);
              const rawGraphQuads: Quad[] = store.getQuads(null, null, null, gTerm) || [];
              // Skolemise blank nodes consistently with the single-graph path so output is
              // stable and re-parseable; they are de-skolemised back to bnodes below.
              for (const q of skolemizeQuads(rawGraphQuads, DataFactory)) {
                const k = quadKeyFromTerms(q);
                if (!seenKeys.has(k)) { seenKeys.add(k); mergedQuads.push(q); }
              }
            }
          } else {
            // (B) Single-graph export: requested graph + data-grounded inferred.
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

            const skolemizedInferred = skolemizeQuads(rawInferred, DataFactory);
            const filteredInferred = skolemizedInferred.filter((q) => {
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
            mergedQuads = [];
            for (const q of [...primaryQuads, ...filteredInferred]) {
              const k = quadKeyFromTerms(q);
              if (!seenKeys.has(k)) { seenKeys.add(k); mergedQuads.push(q); }
            }
          }

          const deskolemized = mergedQuads.map((q) => {
            const subj = q.subject.termType === "NamedNode" && q.subject.value.startsWith("urn:vg:bnode:")
              ? DataFactory.blankNode(q.subject.value.slice("urn:vg:bnode:".length))
              : q.subject;
            const obj = q.object.termType === "NamedNode" && q.object.value.startsWith("urn:vg:bnode:")
              ? DataFactory.blankNode(q.object.value.slice("urn:vg:bnode:".length))
              : q.object;
            if (subj === q.subject && obj === q.object) return q;
            return DataFactory.quad(subj, q.predicate, obj, q.graph);
          });

          const toWrite: Quad[] = formatInfo.dropGraph
            ? deskolemized.map((q) =>
                DataFactory.quad(q.subject, q.predicate, q.object, DataFactory.defaultGraph()),
              )
            : deskolemized;

          // Filter prefixes to only those whose namespace URI appears in the quads.
          const usedNamespaces = new Set<string>();
          for (const q of toWrite) {
            for (const term of [q.subject, q.predicate, q.object]) {
              if (term.termType === "NamedNode") {
                const v = term.value;
                const cut = Math.max(v.lastIndexOf("#"), v.lastIndexOf("/"));
                if (cut > 0) usedNamespaces.add(v.slice(0, cut + 1));
              }
            }
          }
          const usedPrefixes: Record<string, string> = {};
          for (const [prefix, ns] of Object.entries(workerNamespaces)) {
            if (usedNamespaces.has(ns)) usedPrefixes[prefix] = ns;
          }

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
            const ns: Record<string, string> = { rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#", ...usedPrefixes };
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
              prefixes: { ...usedPrefixes },
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
              debugLog("[rdfManager.worker] removeQuadsByNamespace remove failed", err);
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
              debugLog("[rdfManager.worker] purgeNamespace removal failed", err);
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

              store.addQuad(DataFactory.quad(subj, pred, obj, graph));
              renamed += 1;
              touchedSubjects.add(newS !== null ? newS : subjectTermToString(subj));
            } catch (err) {
              debugLog("[rdfManager.worker] renameNamespaceUri failed for quad", err);
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
          debugLog("[emitAllSubjects] subjects:", emission.subjects.length, "totalQuads:", totalQuadCount, "graph:", graphName);
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
          // C2: accumulate the FULL signature (subject + predicate + non-literal
          // object, de-skolemized) of every
          // ADDED and REMOVED quad — captured BEFORE removal for retractions. This
          // is Σ_Δ's seed: it MUST carry the changed triple's PREDICATE and OBJECT,
          // not just its subject, so a predicate/object-position edit (e.g.
          // retracting `p rdfs:subPropertyOf q`) pulls p (and q) into the module and
          // the splice can purge the now-stale inferred triples those axioms backed.
          const changedSignatureSet = new Set<string>();
          const SB_BNODE_PREFIX = "urn:vg:bnode:";
          const sigTermOf = (term: any): string | null => {
            if (!term) return null;
            if (term.termType === "Literal") return null;
            if (term.termType === "BlankNode") return `_:${term.value}`;
            const v = String(term.value ?? "");
            if (!v) return null;
            return v.startsWith(SB_BNODE_PREFIX) ? `_:${v.slice(SB_BNODE_PREFIX.length)}` : v;
          };
          const recordChangedSignature = (q: any): void => {
            const s = sigTermOf(q?.subject);
            if (s) changedSignatureSet.add(s);
            const p = sigTermOf(q?.predicate);
            if (p) changedSignatureSet.add(p);
            const o = sigTermOf(q?.object);
            if (o) changedSignatureSet.add(o);
          };
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
                    recordChangedSignature(q); // capture BEFORE removal
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
                  recordChangedSignature(q); // capture BEFORE removal
                  store.removeQuad(q);
                  removed += 1;
                  handled = true;
                  touchedSubjects.add(subjectTermToString(q.subject));
                }
                // BUG D (alignment with verifyRepairMatch): the lexical fallback
                // removes a literal by lexical value when the exact-term match found
                // nothing. It MUST only fire for a PLAIN literal removal (no datatype,
                // no language). When the removal specifies a datatype/language, apply
                // must match EXACTLY (s,p,o,datatype,language,graph) — the exact match
                // above already enforces that — and must NOT fall back to removing a
                // same-lexical literal of a DIFFERENT datatype/language. Otherwise
                // apply would remove a triple verifyRepairMatch (which checks
                // datatype/language exactly) would NOT consider the repaired axiom,
                // and the two would disagree.
                const remObjHasType =
                  !!(rem.object as { datatype?: unknown }).datatype ||
                  !!(rem.object as { language?: unknown }).language;
                if (!handled && rem.object.termType === "Literal" && !remObjHasType) {
                  const lexical = rem.object.value || "";
                  const allForPredicate = store.getQuads(subject, predicate, null, graphOverride) || [];
                  for (const q of allForPredicate) {
                    const objTerm = q.object;
                    if (
                      objTerm &&
                      objTerm.termType === "Literal" &&
                      String(objTerm.value || "") === lexical
                    ) {
                      recordChangedSignature(q); // capture BEFORE removal
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
            const rawAdds = (payload.adds as any[]).filter(Boolean).map((a) => deserializeQuad(a, DataFactory));
            for (const quad of skolemizeQuads(rawAdds, DataFactory)) {
              try {
                // BUG C: only count an add when store.addQuad actually changed the
                // store (it returns false for a no-op re-add of an existing quad),
                // mirroring importSerialized's `if (changed)` guard. N3's addQuad
                // returns a boolean; guard for stores that return void by treating
                // a non-false result as "changed". This makes applyBatch's `added`
                // reflect the ACTUAL store delta so revert reporting is honest.
                const changed = store.addQuad(quad);
                if (changed !== false) {
                  added += 1;
                  touchedSubjects.add(subjectTermToString(quad.subject));
                  recordChangedSignature(quad);
                }
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
            // C2: forward the full changed signature in the emission meta.
            const changedSignature = Array.from(changedSignatureSet);
            emitChange({ reason: "syncBatch", graphName, added, removed, changedSignature });
            if (shouldEmitSubjects && emissionSubjects.length > 0) {
              emitSubjects(emissionSubjects, emissionQuads, emissionSnapshot, {
                reason: "syncBatch",
                graphName,
                changedSignature,
              });
            }
          }

          result = { added, removed };
          break;
        }
        case "sparqlQuery": {
          const payload = msg.payload as RDFWorkerCommandPayloads["sparqlQuery"];
          const sparql = payload?.sparql;
          if (!sparql) throw new Error("sparqlQuery: sparql string required");
          const limit = typeof payload?.limit === "number" ? payload.limit : 200;

          if (!_cachedQueryEngine) {
            _cachedQueryEngine = new QueryEngine();
          }
          const store = getSharedStore();
          // unionDefaultGraph: true makes plain BGP patterns match quads from all named graphs
          // (urn:vg:data, urn:vg:inferred, etc.) not just the empty default graph.
          const queryResult = await _cachedQueryEngine.query(sparql, { sources: [store], unionDefaultGraph: true });

          if (queryResult.resultType === "bindings") {
            const bindingsStream = await queryResult.execute();
            const rows: Array<Record<string, string>> = [];
            for await (const binding of bindingsStream) {
              if (rows.length >= limit) break;
              const row: Record<string, string> = {};
              for (const [variable, term] of binding) {
                row[variable.value] = term.value;
              }
              rows.push(row);
            }
            result = { type: "select", rows };
          } else if (queryResult.resultType === "quads") {
            const quadStream = await queryResult.execute();
            const triples: Array<{ s: string; p: string; o: string }> = [];
            for await (const quad of quadStream) {
              if (triples.length >= limit) break;
              triples.push({ s: quad.subject.value, p: quad.predicate.value, o: quad.object.value });
            }
            result = { type: "construct", triples };
          } else if (queryResult.resultType === "void") {
            await queryResult.execute();
            // Trigger the normal subject-emission pipeline so the canvas refreshes
            const { DataFactory } = resolveN3();
            if (DataFactory) {
              const graphTerm = createGraphTerm("urn:vg:data", DataFactory);
              const graphQuads = store.getQuads(null, null, null, graphTerm) || [];
              const subjectSet = new Set<string>();
              for (const q of graphQuads) {
                try { const s = subjectTermToString(q.subject); if (s && !isBlacklistedIri(s)) subjectSet.add(s); } catch (_) { /* ignore */ }
              }
              const emission = prepareSubjectEmissionFromSet(subjectSet, store, DataFactory);
              if (emission.subjects.length > 0) {
                emitSubjects(emission.subjects, emission.quadsBySubject, emission.snapshot, { reason: "sparqlUpdate" });
              }
            }
            result = { type: "update" };
          } else if (queryResult.resultType === "boolean") {
            const answer = await queryResult.execute();
            result = { type: "ask", boolean: answer };
          } else {
            throw new Error(`Unsupported result type: ${(queryResult as { resultType?: string }).resultType ?? "unknown"}`);
          }
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
            reasonerBackend: payload.reasonerBackend,
            shaclEnabled: payload.shaclEnabled,
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
            isConsistent: outcome.isConsistent,
          };
          break;
        }
        case "runShaclValidation": {
          result = await runShaclValidation();
          break;
        }
        case "explainInconsistency": {
          const p = (msg.payload ?? {}) as { maxJustifications?: number };
          const n = typeof p.maxJustifications === "number" ? p.maxJustifications : 1;
          const konclude = getDlReasoner();
          await konclude.ready;
          const store = getSharedStore();

          // C1 + H2: preserve the SOURCE GRAPH and the full OBJECT TERM
          // (termType + datatype/language) so the apply path can target the exact
          // graph the axiom physically lives in (urn:vg:data OR urn:vg:ontologies)
          // and reconstruct a precise typed/lang literal instead of a lossy
          // lexical-only fallback. All new fields are OPTIONAL — subject/predicate/
          // object keep their existing string shape for back-compat.
          const serializeQuadAxiom = (q: N3.Quad) => {
            const obj = q.object as Quad["object"];
            const out: {
              subject: string;
              predicate: string;
              object: string;
              objectTermType?: string;
              objectDatatype?: string;
              objectLanguage?: string;
              graph?: string;
            } = {
              subject: q.subject.value,
              predicate: q.predicate.value,
              object: obj.value,
              objectTermType: obj.termType,
            };
            if (obj.termType === "Literal") {
              const lit = obj as { datatype?: { value?: string }; language?: string };
              if (lit.datatype?.value) out.objectDatatype = lit.datatype.value;
              if (lit.language) out.objectLanguage = lit.language;
            }
            const g = q.graph?.termType === "DefaultGraph" ? "" : q.graph?.value;
            if (g) out.graph = g;
            return out;
          };

          // Prefer the LACONIC path (Horridge et al. ISWC 2008): it returns the
          // SAME MIPS plus the superfluous-part-free laconic axiom PARTS and their
          // source mapping. The test node adapter may not implement it — fall back
          // to the plain MIPS-only result (laconicJustifications stays absent).
          if (typeof konclude.explainInconsistencyLaconic === "function") {
            const enriched = await konclude.explainInconsistencyLaconic(store, n);
            result = {
              count: enriched.length,
              mips: enriched.map((e) => e.justification.map(serializeQuadAxiom)),
              // NON-BREAKING: the laconic field is aligned by index with `mips`.
              // Each entry has `parts` (the precise culprit axiom parts, each with
              // its source axiom principal triple), `sharpened` (laconic dropped a
              // superfluous part), and `skipped` (the cost cap suppressed laconic).
              laconicJustifications: enriched.map((e) => e.laconic),
            };
          } else {
            const mips = await konclude.explainInconsistency(store, n);
            result = {
              count: mips.length,
              mips: mips.map((m) => m.map(serializeQuadAxiom)),
            };
          }
          break;
        }
        case "validate": {
          const konclude = getDlReasoner();
          await konclude.ready;
          const vr = await konclude.validate(getSharedStore());
          result = {
            consistent: vr.consistent,
            unsatisfiable: vr.warnings.map((w) => w.classIRI),
          };
          break;
        }
        case "verifyRepair": {
          // R1 — symbolic verification of a repair candidate.
          //
          // Build a working store COPY of the shared store with the candidate's
          // axioms removed, then run the SAME Konclude consistency oracle that
          // explainInconsistency() / validate() use. The shared urn:vg:data
          // store is never mutated.
          //
          // verifyRepair accepts an ARRAY of removals: callers verify a single
          // axiom (per-repair check) OR the full hitting set at once (the union
          // is the valid fix even when no single removal restores consistency).
          const p = (msg.payload ?? { removals: [] }) as {
            removals: {
              subject: string;
              predicate: string;
              object: string;
              objectTermType?: string;
              objectDatatype?: string;
              objectLanguage?: string;
              graph?: string;
            }[];
          };
          const { StoreCls } = resolveN3();
          if (!StoreCls) throw new Error("n3-store-unavailable");
          const konclude = getDlReasoner();
          await konclude.ready;
          const source = getSharedStore();
          const removals = p.removals ?? [];

          // BUG B: VERIFY must exclude the IDENTICAL triple that APPLY removes.
          // When a removal carries object-term metadata (objectTermType +
          // datatype/language) and/or a source graph, those must MATCH the quad —
          // so a same-lexical "42" string in a different graph or with a different
          // datatype is NOT treated as the repaired axiom (which would yield a
          // false `verifiedConsistent`). Absent metadata ⇒ legacy bare-lexical,
          // all-graph match (back-compat). The predicate is the SHARED, pure
          // `quadMatchesRemoval` so the apply and verify notions of "same triple"
          // cannot drift apart.

          // Track which requested removals actually matched a quad so the caller
          // can distinguish "removed but still inconsistent" from "nothing
          // matched" (L2). A removal that matches zero quads (e.g. a serialization
          // or graph mismatch) would otherwise leave the store unchanged and
          // report verifiedConsistent:false as if the repair had failed.
          const matchedIdx = new Set<number>();
          const copy = new (StoreCls as any)();
          const allQuads: Quad[] = source.getQuads(null, null, null, null);
          for (const q of allQuads) {
            let drop = false;
            for (let i = 0; i < removals.length; i++) {
              if (quadMatchesRemoval(q as unknown as MatchQuad, removals[i])) {
                matchedIdx.add(i);
                drop = true;
                break;
              }
            }
            if (drop) continue;
            copy.addQuad(q);
          }
          const removedCount = allQuads.length - copy.size;
          const verifiedConsistent = (await konclude.validate(copy)).consistent;
          result = {
            verifiedConsistent,
            removedCount,
            requestedCount: removals.length,
            matchedCount: matchedIdx.size,
          };
          break;
        }
        case "searchTerms": {
          // Grounding / retrieval — pure store query (no reasoner). Find existing
          // ontology terms (classes / properties / individuals) by label or IRI
          // local-name across ALL graphs (esp. urn:vg:ontologies) so agents
          // REUSE an existing IRI instead of minting a new ex: one.
          const p = (msg.payload ?? { query: "" }) as RDFWorkerCommandPayloads["searchTerms"];
          result = searchTermsInStore(getSharedStore(), p);
          break;
        }
        case "explainEntailment": {
          const p = (msg.payload ?? {
            subjectIri: "",
            predicateIri: "",
            objectIri: "",
          }) as RDFWorkerCommandPayloads["explainEntailment"];
          const n = typeof p.maxJustifications === "number" ? p.maxJustifications : 1;
          const cacheKey = `${p.subjectIri}\0${p.predicateIri}\0${p.objectIri}\0${p.objectIsLiteral}\0${n}`;
          const cached = _entailmentCache.get(cacheKey);
          if (cached) {
            result = cached;
            break;
          }
          const konclude = getDlReasoner();
          await konclude.ready;
          const objectIsClassLike = p.objectIsLiteral !== true;
          const { isEntailed, justifications, ontologyInconsistent, vacuous, reason } =
            await konclude.explainEntailment(
              getSharedStore(),
              p.subjectIri,
              p.predicateIri,
              p.objectIri,
              { objectIsClassLike, maxJustifications: n },
            );
          const termValue = (t: { value: string; termType?: string }) =>
            t.termType === "BlankNode" ? `_:${t.value}` : t.value;
          result = {
            isEntailed,
            justifications: justifications.map((j) =>
              j.map((q) => ({ subject: termValue(q.subject), predicate: q.predicate.value, object: termValue(q.object) })),
            ),
            ...(ontologyInconsistent ? { ontologyInconsistent: true } : {}),
            ...(vacuous ? { vacuous: true } : {}),
            ...(reason ? { reason } : {}),
          };
          _entailmentCache.set(cacheKey, result);
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

  // mipsToReasoningError is imported from ./reasoningDiagnostics — it now attaches
  // the full justification axiom set (see reasoningDiagnostics.ts) rather than
  // truncating to three axioms.

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

    // ── KONCLUDE PATH ──────────────────────────────────────────────────────────
    if ((msg.reasonerBackend ?? 'konclude') !== 'n3') {
      const kStore = mutateSharedStore
        ? getSharedStore()
        : (() => {
            const s = new (StoreCls as any)();
            for (const pq of msg.quads || []) {
              try { s.addQuad(deserializeQuad(pq, DataFactory)); } catch (_) { /* ignore */ }
            }
            return s;
          })();

      let kUsedReasoner = false;
      let kReasonerDuration = 0;
      let kIsConsistent: boolean | null = null;
      let kMipsErrors: ReasoningError[] = [];
      let kDelta: InferenceDelta = { added: [], removed: [] };

      try {
        const sabAvailable = typeof SharedArrayBuffer !== 'undefined';
        debugLog("[VG_REASONING_WORKER] Konclude init", { sabAvailable, crossOriginIsolated: (globalThis as any).crossOriginIsolated });
        if (!sabAvailable) {
          throw new Error("SharedArrayBuffer unavailable — page needs HTTPS + COOP/COEP headers (or localhost). Use reasonerBackend='n3' as fallback.");
        }
        const konclude = getDlReasoner();
        await konclude.ready;
        const kQuadCount = kStore.size ?? kStore.countQuads?.(null,null,null,null) ?? 0;
        debugLog("[VG_REASONING_WORKER] Konclude input quads:", kQuadCount);
        reasoningStage({ type: "reasoningStage", id: msg.id, stage: "consistency-check", meta: { backend: 'konclude' } });
        const kStart = Date.now();
        const kConsistencyResult = (await konclude.validate(kStore)).consistent;
        if (kConsistencyResult) {
          reasoningStage({ type: "reasoningStage", id: msg.id, stage: "reasoner-start", meta: { backend: 'konclude' } });
          const result = await konclude.reason(kStore);
          kDelta = result.delta;
          kReasonerDuration = Date.now() - kStart;
          kUsedReasoner = true;
          kIsConsistent = true;
          reasoningStage({ type: "reasoningStage", id: msg.id, stage: "reasoner-complete", meta: { durationMs: kReasonerDuration, backend: 'konclude' } });
        } else {
          reasoningStage({ type: "reasoningStage", id: msg.id, stage: "inconsistent-detected", meta: { durationMs: Date.now() - kStart } });
          const DEFAULT_UI_MAX_JUSTIFICATIONS = 3;
          const mips = await konclude.explainInconsistency(kStore, DEFAULT_UI_MAX_JUSTIFICATIONS);
          kReasonerDuration = Date.now() - kStart;
          kIsConsistent = false;
          kMipsErrors = mips.map(mipsToReasoningError);
          debugLog("[VG_REASONING_WORKER] Konclude inconsistency detected, MIPS count:", mips.length);
          reasoningStage({ type: "reasoningStage", id: msg.id, stage: "inconsistent", meta: { durationMs: kReasonerDuration, mipsCount: mips.length } });
        }
      } catch (err) {
        const errMsg = String((err as Error).message || err);
        console.error("[VG_REASONING_WORKER] Konclude failed:", errMsg);
        reasoningStage({ type: "reasoningStage", id: msg.id, stage: "reasoner-error", meta: { error: errMsg } });
        kMipsErrors.push({
          rule: "reasoner-error",
          severity: "error",
          message: `OWL DL reasoning could not complete: ${errMsg}`,
        });
      }

      const kAddedQuads = kUsedReasoner ? skolemizeQuads(kDelta.added, DataFactory) : [];
      const kTouchedSubjects = new Set<string>();
      for (const q of kAddedQuads) {
        const sv = subjectTermToString(q.subject, q.subject.value);
        if (sv) kTouchedSubjects.add(sv);
      }
      const kRemovedSubjects = new Set<string>();
      for (const q of kDelta.removed) {
        const sv = subjectTermToString(q.subject, q.subject.value);
        if (sv) kRemovedSubjects.add(sv);
      }

      if (mutateSharedStore) {
        if (emitChangeFlag && (kAddedQuads.length > 0 || kDelta.removed.length > 0)) {
          emitChange({ reason: "reasoning", addedCount: kAddedQuads.length, removedCount: kDelta.removed.length });
        }
        if (emitSubjectsFlag && (kAddedQuads.length > 0 || kRemovedSubjects.size > 0)) {
          const emitSet = new Set(kTouchedSubjects);
          for (const s of kRemovedSubjects) emitSet.add(s);
          const emission = prepareSubjectEmissionFromSet(emitSet, kStore, DataFactory);
          if (emission.subjects.length > 0) {
            emitSubjects(emission.subjects, emission.quadsBySubject, emission.snapshot, { reason: "reasoning", graphName: "urn:vg:inferred" });
          }
        }
      }

      const { warnings: kWarnings, errors: kShaclErrors } = collectShaclResults(kAddedQuads);

      // Run SHACL validation against urn:vg:shapes if shapes are loaded
      if (msg.shaclEnabled !== false) {
        try {
          const shaclResult = await runShaclValidation();
          if (!shaclResult.conforms) {
            for (const v of shaclResult.violations) {
              const entry = shaclViolationToEntry(v);
              if (entry.severity === "error") {
                kShaclErrors.push(entry);
              } else {
                kWarnings.push(entry);
              }
            }
          }
        } catch (shaclErr) {
          // F4: do not silently swallow — a failed validation must not look like "data conforms".
          const m = String((shaclErr as Error)?.message ?? shaclErr);
          debugLog("[VG_REASONING_WORKER] SHACL validation failed", m);
          kWarnings.push({
            rule: "shacl:engine-error",
            severity: "warning",
            message: `SHACL validation could not run (data conformance unknown): ${m}`,
          });
        }
      }

      const kErrors: ReasoningError[] = [...kMipsErrors, ...kShaclErrors];
      if (!kUsedReasoner && kIsConsistent === null) {
        kWarnings.push({
          message: "Konclude OWL DL reasoner unavailable. Requires SharedArrayBuffer (HTTPS or localhost). Switch to reasonerBackend='n3' for rule-based reasoning, or access via HTTPS.",
          rule: "konclude-unavailable",
          severity: "warning",
        } as any);
      }
      const RDF_TYPE_K = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
      const kInferences: ReasoningInference[] = kAddedQuads
        .map((quad) => {
          const subject = subjectTermToString(quad.subject, quad.subject.value);
          const predicate = termToString(quad.predicate);
          const object = termToString(quad.object);
          if (!subject || !predicate) return null;
          return predicate === RDF_TYPE_K
            ? { type: "class", subject, predicate, object, confidence: 0.95 } as ReasoningInference
            : { type: "relationship", subject, predicate, object, confidence: 0.9 } as ReasoningInference;
        })
        .filter((e): e is ReasoningInference => Boolean(e));

      const kDurationMs = Date.now() - startedAt;
      const kResult: ReasoningResultMessage = {
        type: "reasoningResult",
        id: msg.id,
        durationMs: kDurationMs,
        startedAt,
        added: includeAdded ? kAddedQuads.map((quad) => serializeQuad(quad)) : undefined,
        addedCount: kAddedQuads.length,
        warnings: kWarnings,
        errors: kErrors,
        inferences: kInferences,
        usedReasoner: kUsedReasoner,
        workerDurationMs: kReasonerDuration,
        ruleQuadCount: 0,
        isConsistent: kIsConsistent,
      };

      if (emitResultEvent) {
        const eventPayload: ReasoningResult = {
          id: msg.id,
          timestamp: startedAt,
          status: "completed",
          duration: kDurationMs,
          errors: kErrors,
          warnings: kWarnings,
          inferences: kInferences,
          meta: {
            usedReasoner: kUsedReasoner,
            workerDurationMs: kReasonerDuration,
            totalDurationMs: kDurationMs,
            addedCount: kResult.addedCount,
            ruleQuadCount: 0,
          },
        };
        post({ type: "event", event: "reasoningResult", payload: eventPayload });
      }

      reasoningStage({ type: "reasoningStage", id: msg.id, stage: "complete", meta: {
        durationMs: kDurationMs, addedCount: kResult.addedCount, usedReasoner: kUsedReasoner,
        inferenceCount: kInferences.length, ruleQuadCount: 0,
      }});

      return kResult;
    }
    // ── END KONCLUDE PATH — N3 path follows ────────────────────────────────────

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
        // repeated runs (N3 OWL-RL re-applies rules to already-inferred triples).
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
      debugLog("[VG_REASONING_WORKER] quad counts before reasoning", {
        id: msg.id,
        total: Object.values(countsBefore).reduce((acc, v) => acc + v, 0),
        counts: countsBefore,
      });
    } catch (err) {
      debugLog("[VG_REASONING_WORKER] unable to log pre-reasoning counts", err);
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
      debugLog("[VG_REASONING_WORKER] ruleset load summary", {
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
        debugLog("[VG_REASONING_WORKER] reasoner run complete", {
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

    debugLog("[VG_REASONING_WORKER] captured insertions summary", {
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
        isConsistent: null,
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
      const rawInferred: Quad[] = [];
      for (const insertion of capturedInsertions) {
        const subjectTerm = termFromReasonerValue(DataFactory, insertion.subject);
        const predicateTerm = termFromReasonerValue(DataFactory, insertion.predicate);
        const objectTerm = termFromReasonerValue(DataFactory, insertion.object);
        if (!subjectTerm || !predicateTerm || !objectTerm) continue;
        rawInferred.push(DataFactory.quad(subjectTerm, predicateTerm, objectTerm, inferredGraphTerm));
      }

      for (const inferredQuad of skolemizeQuads(rawInferred, DataFactory)) {
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

          const subjectValue = subjectTermToString(inferredQuad.subject, inferredQuad.subject.value);
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

    // Run SHACL validation against urn:vg:shapes if shapes are loaded
    if (msg.shaclEnabled !== false) {
      try {
        const shaclResult = await runShaclValidation();
        if (!shaclResult.conforms) {
          for (const v of shaclResult.violations) {
            const entry = shaclViolationToEntry(v);
            if (entry.severity === "error") {
              errors.push(entry);
            } else {
              warnings.push(entry);
            }
          }
        }
      } catch (shaclErr) {
        // F4: surface rather than swallow — see konclude path above.
        const m = String((shaclErr as Error)?.message ?? shaclErr);
        debugLog("[VG_REASONING_WORKER] SHACL validation failed", m);
        warnings.push({
          rule: "shacl:engine-error",
          severity: "warning",
          message: `SHACL validation could not run (data conformance unknown): ${m}`,
        });
      }
    }

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
      debugLog("[VG_REASONING_WORKER] quad counts after reasoning", {
        id: msg.id,
        durationMs,
        total: Object.values(countsAfter).reduce((acc, v) => acc + v, 0),
        counts: countsAfter,
        addedCount: effectiveAdded.length,
        usedReasoner,
        ruleQuadCount: ruleDiagnostics.reduce((acc, item) => acc + item.quadCount, 0),
      });
    } catch (err) {
      debugLog("[VG_REASONING_WORKER] unable to log post-reasoning counts", err);
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
      isConsistent: null,
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
      graphCounts = new Map();
      graphCountsReady = false;
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
