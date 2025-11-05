import { Readable } from "readable-stream";
import { Buffer } from "buffer";
(globalThis as any).Buffer = Buffer;
import rdfParsePkg from "rdf-parse";
import * as N3 from "n3";
import { Reasoner as N3ReasonerExplicit } from "n3";
import type { RDFWorkerCommand } from "../utils/rdfManager.workerProtocol";
import type { ReasoningResult } from "../utils/reasoningTypes";
import { WELL_KNOWN } from "../utils/wellKnownOntologies";

declare const self: any;

const BATCH_SIZE = 1000;

type PlainQuad = {
  s: string;
  p: string;
  o: { t: "iri" | "bnode" | "lit"; v: string; dt?: string; ln?: string };
  g?: string;
};

type LoadMessage = {
  type: "loadFromUrl";
  id: string;
  url: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
};

type AckMessage = { type: "ack"; id: string };

type ReasoningRequest = {
  type: "runReasoning";
  id: string;
  quads?: PlainQuad[];
  rulesets?: string[];
  baseUrl?: string;
  emitSubjects?: boolean;
};

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
  added?: PlainQuad[];
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

self.addEventListener("message", (event: MessageEvent<any>) => {
  const msg = event.data;
  if (!msg) return;
  if (msg.type === "command") {
    handleCommand(msg as RDFWorkerCommand);
    return;
  }
  if (msg.type === "ack") {
    pendingAcks.set(String(msg.id), true);
    return;
  }
  if (msg.type === "loadFromUrl") {
    handleLoad(msg).catch((err) => {
      post({ type: "error", id: msg.id, message: String((err as Error).message || err) });
    });
    return;
  }
  if (msg.type === "runReasoning") {
    const hasExternalQuads = Array.isArray(msg.quads) && msg.quads.length > 0;
    handleRunReasoning(msg, {
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
          id: msg.id,
          message: String((err as Error).message || err),
          stack: (err && (err as any).stack) ? String((err as any).stack) : undefined,
        };
        post(errorMessage);
      });
  }
});

function post(message: any) {
  self.postMessage(message);
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
  } catch (_) {
    /* ignore stage emission failures */
  }
}
function emitChange(meta?: Record<string, unknown> | null) {
  try {
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

function emitSubjects(subjects: string[], quadsBySubject?: Record<string, PlainQuad[]>) {
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

function plainQuadKey(pq: PlainQuad): string {
  try {
    const objSuffix = pq.o ? `${pq.o.t}:${pq.o.v}:${pq.o.dt || ""}:${pq.o.ln || ""}` : "";
    return `${pq.s}|${pq.p}|${objSuffix}|${pq.g || ""}`;
  } catch (_) {
    return Math.random().toString(36).slice(2);
  }
}

function plainToQuad(pq: PlainQuad, DataFactory: any): any | null {
  const { namedNode, blankNode, literal, quad } = DataFactory;
  const sTerm = /^_:/.test(String(pq.s || ""))
    ? blankNode(String(pq.s).replace(/^_:/, ""))
    : namedNode(String(pq.s));
  const pTerm = namedNode(String(pq.p));
  if (!pq.o) return null;
  let oTerm: any;
  if (pq.o && pq.o.t === "iri") {
    oTerm = namedNode(String(pq.o.v));
  } else if (pq.o && pq.o.t === "bnode") {
    oTerm = blankNode(String(pq.o.v));
  } else if (pq.o && pq.o.t === "lit") {
    if (pq.o.dt) {
      oTerm = literal(String(pq.o.v), namedNode(String(pq.o.dt)));
    } else if (pq.o.ln) {
      oTerm = literal(String(pq.o.v), String(pq.o.ln));
    } else {
      oTerm = literal(String(pq.o.v));
    }
  } else {
    oTerm = literal(String((pq.o && pq.o.v) || ""));
  }
  const gTerm =
    pq.g && String(pq.g).length > 0 ? namedNode(String(pq.g)) : undefined;
  return quad(sTerm as any, pTerm as any, oTerm as any, gTerm as any);
}

function plainTermToSubject(value: string, DataFactory: any) {
  const { namedNode, blankNode } = DataFactory;
  if (/^_:/.test(String(value || ""))) {
    return blankNode(String(value).replace(/^_:/, ""));
  }
  return namedNode(String(value));
}

function plainTermToObject(o: PlainQuad["o"], DataFactory: any) {
  const { namedNode, blankNode, literal } = DataFactory;
  if (!o) return null;
  if (o.t === "iri") return namedNode(String(o.v));
  if (o.t === "bnode") return blankNode(String(o.v));
  if (o.t === "lit") {
    if (o.dt) return literal(String(o.v), namedNode(String(o.dt)));
    if (o.ln) return literal(String(o.v), String(o.ln));
    return literal(String(o.v));
  }
  return literal(String(o.v || ""));
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

function collectPlainQuadsForSubject(subject: string, store: any, DataFactory: any): PlainQuad[] {
  try {
    const term =
      /^_:/i.test(String(subject))
        ? DataFactory.blankNode(String(subject).replace(/^_:/, ""))
        : DataFactory.namedNode(String(subject));
    const quads = store.getQuads(term, null, null, null) || [];
    const out: PlainQuad[] = [];
    for (const q of quads) {
      const pq = quadToPlain(q);
      if (pq) out.push(pq);
    }
    return out;
  } catch (err) {
    console.error("[rdfManager.worker] collectPlainQuadsForSubject failed", err);
    return [];
  }
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

      try {
        const wkPrefix =
          WELL_KNOWN && WELL_KNOWN.prefixes && WELL_KNOWN.prefixes[prefix];
        if (wkPrefix) candidates.add(String(wkPrefix));

        const ontologies = WELL_KNOWN && WELL_KNOWN.ontologies ? WELL_KNOWN.ontologies : {};
        for (const [ontUrl, meta] of Object.entries(ontologies)) {
          const data = meta as any;
          if (data && data.namespaces && data.namespaces[prefix]) {
            candidates.add(String(ontUrl));
            if (Array.isArray(data.aliases)) {
              for (const alias of data.aliases) {
                if (alias) candidates.add(String(alias));
              }
            }
          }
        }
      } catch (_) {
        /* ignore */
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
): { subjects: string[]; quadsBySubject: Record<string, PlainQuad[]> } {
  const subjects: string[] = [];
  const quadsBySubject: Record<string, PlainQuad[]> = {};
  for (const raw of subjectSet) {
    try {
      const subject = String(raw || "").trim();
      if (!subject) continue;
      if (isBlacklistedIri(subject)) continue;
      subjects.push(subject);
      quadsBySubject[subject] = collectPlainQuadsForSubject(subject, store, DataFactory);
    } catch (err) {
      console.error("[rdfManager.worker] prepareSubjectEmissionFromSet item failed", err);
    }
  }
  return { subjects, quadsBySubject };
}

function prepareSubjectEmissionFromQuads(
  quads: any[],
  DataFactory: any,
): { subjects: string[]; quadsBySubject: Record<string, PlainQuad[]> } {
  const map = new Map<string, PlainQuad[]>();
  for (const q of quads || []) {
    try {
      const subject = subjectTermToString(q.subject);
      if (!subject) continue;
      if (isBlacklistedIri(subject)) continue;
      const plain = quadToPlain(q);
      if (!plain) continue;
      if (!map.has(subject)) map.set(subject, []);
      map.get(subject)!.push(plain);
    } catch (err) {
      console.error("[rdfManager.worker] prepareSubjectEmissionFromQuads item failed", err);
    }
  }
  const subjects = Array.from(map.keys());
  const quadsBySubject: Record<string, PlainQuad[]> = {};
  for (const subject of subjects) {
    quadsBySubject[subject] = map.get(subject)!;
  }
  return { subjects, quadsBySubject };
}

function quadToPlain(q: any, overrideGraph?: string): PlainQuad {
  const graphValue =
    typeof overrideGraph === "string"
      ? overrideGraph
      : q.graph && q.graph.value
        ? String(q.graph.value)
        : undefined;
  const objTerm = q.object;
  let obj: PlainQuad["o"] = { t: "lit", v: "" };
  if (objTerm) {
    if (objTerm.termType === "NamedNode") {
      obj = { t: "iri", v: String(objTerm.value) };
    } else if (objTerm.termType === "BlankNode") {
      obj = { t: "bnode", v: String(objTerm.value) };
    } else if (objTerm.termType === "Literal") {
      obj = {
        t: "lit",
        v: String(objTerm.value),
        dt: objTerm.datatype && objTerm.datatype.value ? String(objTerm.datatype.value) : undefined,
        ln: objTerm.language || undefined,
      };
    } else {
      obj = { t: "lit", v: String(objTerm.value || "") };
    }
  }
  return {
    s: q.subject && q.subject.value ? String(q.subject.value) : "",
    p: q.predicate && q.predicate.value ? String(q.predicate.value) : "",
    o: obj,
    g: graphValue,
  };
}

function plainObjectToString(o: PlainQuad["o"] | undefined): string {
  if (!o) return "";
  switch (o.t) {
    case "iri":
    case "bnode":
      return String(o.v);
    case "lit":
    default:
      return String(o.v);
  }
}

function collectShaclResults(all: PlainQuad[]): { warnings: ReasoningWarning[]; errors: ReasoningError[] } {
  const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
  const SH_RESULT = "http://www.w3.org/ns/shacl#ValidationResult";
  const SH_FOCUS = "http://www.w3.org/ns/shacl#focusNode";
  const SH_MESSAGE = "http://www.w3.org/ns/shacl#resultMessage";
  const SH_SEVERITY = "http://www.w3.org/ns/shacl#resultSeverity";
  const SEVERITY_VIOLATION = "http://www.w3.org/ns/shacl#Violation";

  const bySubject = new Map<string, PlainQuad[]>();
  for (const q of all) {
    const key = `${q.g || ""}|${q.s}`;
    const existing = bySubject.get(key) || [];
    existing.push(q);
    bySubject.set(key, existing);
  }

  const warnings: ReasoningWarning[] = [];
  const errors: ReasoningError[] = [];

  for (const q of all) {
    if (q.p !== RDF_TYPE) continue;
    if (!q.o || q.o.t !== "iri" || q.o.v !== SH_RESULT) continue;
    const key = `${q.g || ""}|${q.s}`;
    const subjectQuads = bySubject.get(key) || [];
    const focus = subjectQuads.find((sq) => sq.p === SH_FOCUS);
    const message = subjectQuads.find((sq) => sq.p === SH_MESSAGE);
    const severityQuad = subjectQuads.find((sq) => sq.p === SH_SEVERITY);

    const nodeId = focus ? plainObjectToString(focus.o) : undefined;
    const messageText = message ? plainObjectToString(message.o) : "Validation issue";
    const severityUri = severityQuad ? plainObjectToString(severityQuad.o) : "";
    const severity =
      severityUri && severityUri.includes("Violation") ? "critical" : "warning";
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

  return { warnings, errors };
}

function collectGraphCountsFromStore(store: any): Record<string, number> {
  const counts: Record<string, number> = {};
  try {
    const quads = store.getQuads(null, null, null, null) || [];
    for (const q of quads) {
      try {
        const graphName =
          q && q.graph && q.graph.value ? String(q.graph.value) : "urn:vg:default";
        counts[graphName] = (counts[graphName] || 0) + 1;
      } catch (_) {
        /* ignore individual quad issues */
      }
    }
  } catch (err) {
    console.debug("[VG_REASONING_WORKER] collectGraphCountsFromStore failed", err);
  }
  return counts;
}

function plainFromTerm(term: any): PlainQuad["o"] {
  if (!term) return { t: "lit", v: "" };
  const tt = (term.termType || "").toLowerCase();
  if (tt === "namednode" || tt === "iri") return { t: "iri", v: String(term.value || term) };
  if (tt === "blanknode" || tt === "bnode") return { t: "bnode", v: String(term.value || term) };
  if (tt === "literal" || typeof term.value !== "undefined") {
    const obj: PlainQuad["o"] = { t: "lit", v: String(term.value || "") };
    if (term.datatype && term.datatype.value) obj.dt = String(term.datatype.value);
    if (term.language) obj.ln = String(term.language);
    return obj;
  }
  return { t: "iri", v: String(term) };
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

async function handleLoad(msg: LoadMessage) {
  const { id, url } = msg;
  const timeoutMs = typeof msg.timeoutMs === "number" ? msg.timeoutMs : 15000;

  post({ type: "stage", id, stage: "start", url });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: msg.headers || { Accept: "text/turtle, application/rdf+xml, application/ld+json, */*" },
    });
  } catch (err) {
    clearTimeout(timeout);
    post({ type: "error", id, message: String((err as Error).message || err) });
    return;
  }
  clearTimeout(timeout);
  post({ type: "stage", id, stage: "fetched", status: resp.status });

  const readable = await createReadable(resp.clone ? resp.clone() as Response : resp);
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
      // ignore
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
      post({ type: "stage", id, stage: "getContentTypesFailed", error: String(err) });
  }
}

  const contentTypeHeader = resp.headers?.get("content-type") || null;
  const ctRaw = contentTypeHeader ? String(contentTypeHeader).split(";")[0].trim().toLowerCase() : null;
  const parseOpts: any = {};
  if (ctRaw && supportedMedia.has(ctRaw)) {
    parseOpts.contentType = ctRaw;
    parseOpts.path = url;
    post({ type: "stage", id, stage: "parser-content-type", contentType: ctRaw });
  } else {
    let filename = url;
    try {
      const u = new URL(url);
      const seg = u.pathname.split("/").filter(Boolean).pop();
      if (seg) filename = seg;
    } catch (_) {
      // keep url
    }
    parseOpts.path = filename;
    post({ type: "stage", id, stage: "parser-filename", path: filename });
  }

  const plainQuads: PlainQuad[] = [];
  const prefixes: Record<string, string> = {};

  try {
    await new Promise<void>((resolve, reject) => {
      const opts = { ...parseOpts, baseIRI: url };
      const quadStream = parserImpl.parse(readable, opts);

      quadStream.on("data", async (q: any) => {
        const plain: PlainQuad = {
          s: q.subject && q.subject.value ? String(q.subject.value) : "",
          p: q.predicate && q.predicate.value ? String(q.predicate.value) : "",
          o: plainFromTerm(q.object),
          g: q.graph && q.graph.value ? String(q.graph.value) : undefined,
        };
        plainQuads.push(plain);
        if (plainQuads.length >= BATCH_SIZE) {
          post({ type: "quads", id, quads: plainQuads.splice(0, plainQuads.length) });
          await waitForAck(id);
        }
      });

      quadStream.on("prefix", (pfx: string, iri: any) => {
        const value = iri && typeof iri.value === "string" ? String(iri.value) : String(iri || "");
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

  if (plainQuads.length > 0) {
    post({ type: "quads", id, quads: plainQuads.splice(0, plainQuads.length) });
    await waitForAck(id);
  }

  post({ type: "end", id, prefixes });
}

async function handleCommand(msg: RDFWorkerCommand) {
  try {
    const payload = Array.isArray(msg.args) && msg.args.length > 0 ? msg.args[0] : undefined;
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
        workerNamespaces =
          payload && typeof payload === "object" && payload.namespaces && typeof payload.namespaces === "object"
            ? { ...payload.namespaces }
            : {};
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
        const graphTerm =
          graphName && graphName !== "default"
            ? DataFactory.namedNode(String(graphName))
            : DataFactory.defaultGraph();
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
              const q = plainToQuad(pq, DataFactory);
              if (!q) continue;
              store.addQuad(q);
              added += 1;
              touchedSubjects.add(subjectTermToString(q.subject, pq.s));
            } catch (err) {
              console.error("[rdfManager.worker] syncLoad add failed", err);
            }
          }
        }

        if (payload && payload.prefixes && typeof payload.prefixes === "object") {
          workerNamespaces = { ...workerNamespaces, ...(payload.prefixes as Record<string, string>) };
        }

        const { subjects, quadsBySubject } = prepareSubjectEmissionFromSet(
          touchedSubjects,
          store,
          DataFactory,
        );

        emitChange({ reason: "syncLoad", graphName, added, removed });
        if (subjects.length > 0) emitSubjects(subjects, quadsBySubject);

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
        const graphTerm =
          graphName && graphName !== "default"
            ? DataFactory.namedNode(String(graphName))
            : DataFactory.defaultGraph();
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
          const { subjects, quadsBySubject } = prepareSubjectEmissionFromSet(
            touchedSubjects,
            store,
            DataFactory,
          );
          emitChange({ reason: "removeGraph", graphName, removed });
          if (subjects.length > 0) emitSubjects(subjects, quadsBySubject);
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
        const graphTerm =
          graphName && graphName !== "default"
            ? DataFactory.namedNode(String(graphName))
            : DataFactory.defaultGraph();
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
          const { subjects, quadsBySubject } = prepareSubjectEmissionFromSet(
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
          if (subjects.length > 0) emitSubjects(subjects, quadsBySubject);
        }

        result = { removedSubjects, removedObjects };
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
        const graphTerm =
          graphName && graphName !== "default"
            ? DataFactory.namedNode(String(graphName))
            : DataFactory.defaultGraph();
        const quads = store.getQuads(null, null, null, graphTerm) || [];
        const { subjects, quadsBySubject } = prepareSubjectEmissionFromQuads(quads, DataFactory);
        if (subjects.length > 0) emitSubjects(subjects, quadsBySubject);
        result = { subjects: subjects.length };
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
          try {
            const value = String(item ?? "").trim();
            if (!value) continue;
            subjectSet.add(value);
          } catch (_) {
            /* ignore individual subject errors */
          }
        }
        const { subjects, quadsBySubject } = prepareSubjectEmissionFromSet(
          subjectSet,
          store,
          DataFactory,
        );
        if (subjects.length > 0) emitSubjects(subjects, quadsBySubject);
        result = { subjects: subjects.length };
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
        const graphTerm =
          graphName && graphName !== "default"
            ? DataFactory.namedNode(String(graphName))
            : DataFactory.defaultGraph();
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
              graph: q.graph && q.graph.value ? String(q.graph.value) : graphName,
            }))
          : slice.map((q: any) => quadToPlain(q));
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
        const graphTerm =
          graphName && graphName !== "default"
            ? DataFactory.namedNode(String(graphName))
            : graphName === null
              ? null
              : DataFactory.defaultGraph();
        const subjectTerm =
          payload && typeof payload === "object" && typeof payload.subject === "string"
            ? plainTermToSubject(payload.subject, DataFactory)
            : null;
        const predicateTerm =
          payload && typeof payload === "object" && typeof payload.predicate === "string"
            ? DataFactory.namedNode(String(payload.predicate))
            : null;
        const objectTerm =
          payload && typeof payload === "object" && payload.object
            ? plainTermToObject(payload.object, DataFactory)
            : null;
        const quads = store.getQuads(subjectTerm, predicateTerm, objectTerm, graphTerm) || [];
        result = quads.map((q: any) => quadToPlain(q));
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
        const graphTerm =
          graphName && graphName !== "default"
            ? DataFactory.namedNode(String(graphName))
            : DataFactory.defaultGraph();
        const touchedSubjects = new Set<string>();
        let added = 0;
        let removed = 0;

        if (payload && Array.isArray(payload.removes)) {
          for (const rem of payload.removes) {
            if (!rem || typeof rem.s !== "string" || typeof rem.p !== "string") continue;
            try {
              const sTerm = plainTermToSubject(rem.s, DataFactory);
              const pTerm = DataFactory.namedNode(String(rem.p));
              const gTerm =
                rem.g && typeof rem.g === "string" && rem.g.length > 0
                  ? DataFactory.namedNode(String(rem.g))
                  : graphTerm;
              if (!rem.o) {
                const matches = store.getQuads(sTerm, pTerm, null, gTerm) || [];
                for (const q of matches) {
                  store.removeQuad(q);
                  removed += 1;
                  touchedSubjects.add(subjectTermToString(q.subject, rem.s));
                }
                continue;
              }

              const oTerm = plainTermToObject(rem.o, DataFactory);
              if (!oTerm) continue;
              const matches = store.getQuads(sTerm, pTerm, oTerm, gTerm) || [];
              let handled = false;
              for (const q of matches) {
                store.removeQuad(q);
                removed += 1;
                handled = true;
                touchedSubjects.add(subjectTermToString(q.subject, rem.s));
              }
              if (!handled && rem.o && rem.o.t === "lit") {
                const lexical = String(rem.o.v || "");
                const allForPredicate = store.getQuads(sTerm, pTerm, null, gTerm) || [];
                for (const q of allForPredicate) {
                  const objTerm = q.object;
                  if (
                    objTerm &&
                    typeof objTerm.termType === "string" &&
                    objTerm.termType === "Literal" &&
                    String(objTerm.value || "") === lexical
                  ) {
                    store.removeQuad(q);
                    removed += 1;
                    touchedSubjects.add(subjectTermToString(q.subject, rem.s));
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
            if (!add || typeof add.s !== "string" || typeof add.p !== "string" || !add.o) continue;
            try {
              const pq: PlainQuad = {
                s: add.s,
                p: add.p,
                o: add.o,
                g: add.g && typeof add.g === "string" ? add.g : graphName,
              };
              const q = plainToQuad(pq, DataFactory);
              if (!q) continue;
              store.addQuad(q);
              added += 1;
              touchedSubjects.add(subjectTermToString(q.subject, add.s));
            } catch (err) {
              console.error("[rdfManager.worker] syncBatch add failed", err);
            }
          }
        }

        const shouldEmitSubjects =
          !payload?.options || payload.options.suppressSubjects !== true;
        let emissionSubjects: string[] = [];
        let emissionQuads: Record<string, PlainQuad[]> = {};
        if (shouldEmitSubjects) {
          const emission = prepareSubjectEmissionFromSet(
            touchedSubjects,
            store,
            DataFactory,
          );
          emissionSubjects = emission.subjects;
          emissionQuads = emission.quadsBySubject;
        }

        if (added > 0 || removed > 0) {
          emitChange({ reason: "syncBatch", graphName, added, removed });
          if (shouldEmitSubjects && emissionSubjects.length > 0) {
            emitSubjects(emissionSubjects, emissionQuads);
          }
        }

        result = { added, removed };
        break;
      }
      case "runReasoning": {
        const payload = msg.args && msg.args[0] ? (msg.args[0] as any) : undefined;
        const reasoningId =
          payload && typeof payload.reasoningId === "string" && payload.reasoningId.length > 0
            ? payload.reasoningId
            : `reasoning-${Date.now().toString(36)}`;
        const reasoningRequest: ReasoningRequest = {
          type: "runReasoning",
          id: reasoningId,
          rulesets: Array.isArray(payload?.rulesets)
            ? (payload!.rulesets as string[])
            : undefined,
          baseUrl:
            payload && typeof payload.baseUrl === "string" ? payload.baseUrl : undefined,
        };
        const outcome = await handleRunReasoning(reasoningRequest, {
          mutateSharedStore: true,
          includeAdded: false,
          emitSubjects: payload?.emitSubjects !== false,
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
  msg: ReasoningRequest,
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

  const workingStore = new (StoreCls as any)();
  const beforeKeys = new Set<string>();
  let sharedStoreRef: any | null = null;

  if (mutateSharedStore) {
    sharedStoreRef = getSharedStore();
    const existingQuads = sharedStoreRef.getQuads(null, null, null, null) || [];
    for (const q of existingQuads) {
      try {
        workingStore.addQuad(q);
        beforeKeys.add(quadKeyFromTerms(q));
      } catch (_) {
        /* ignore copy failures */
      }
    }
  } else {
    for (const pq of msg.quads || []) {
      try {
        const q = plainToQuad(pq, DataFactory);
        if (!q) continue;
        workingStore.addQuad(q);
        beforeKeys.add(quadKeyFromTerms(q));
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
      if (typeof self !== "undefined" && (self as any).location && (self as any).location.href) {
        const dir = new URL("./", (self as any).location.href).pathname;
        return dir.endsWith("/") ? dir : `${dir}/`;
      }
    } catch (_) {
      /* ignore */
    }
    return "";
  })();
  const origin = (() => {
    try {
      return (self as any).location && (self as any).location.origin
        ? String((self as any).location.origin)
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
  } else if (parser) {
    const defaultNames = ["best-practice.n3", "owl-rl.n3"];
    for (const name of defaultNames) {
      try {
        const text = await fetchRuleText(name);
        if (text && text.trim()) {
          const quads = parser.parse(text);
          if (Array.isArray(quads) && quads.length > 0) {
            parsedRules.push(...quads);
            ruleDiagnostics.push({ name, quadCount: quads.length });
            reasoningStage({
              type: "reasoningStage",
              id: msg.id,
              stage: "default-rules-parsed",
              meta: { name, quadCount: quads.length },
            });
          }
        }
      } catch (err) {
        reasoningStage({
          type: "reasoningStage",
          id: msg.id,
          stage: "default-rules-error",
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

  let usedReasoner = false;
  let reasonerDuration = 0;

  if (ReasonerCls) {
    try {
      const reasoner = new (ReasonerCls as any)(workingStore);
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

  const afterQuads = workingStore.getQuads(null, null, null, null) || [];
  const addedPlainAll: PlainQuad[] = [];
  const seenKeys = new Set<string>();
  for (const q of afterQuads) {
    const key = quadKeyFromTerms(q);
    if (beforeKeys.has(key)) continue;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    addedPlainAll.push(quadToPlain(q, "urn:vg:inferred"));
  }

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
  let effectiveAdded: PlainQuad[] = [];

  if (mutateSharedStore && sharedStoreRef) {
    const inserted: PlainQuad[] = [];
    for (const pq of addedPlainAll) {
      try {
        const q = plainToQuad(pq, DataFactory);
        if (!q) continue;
        const graphTerm =
          q.graph && q.graph.termType !== "DefaultGraph"
            ? q.graph
            : DataFactory.namedNode("urn:vg:inferred");
        const exists =
          typeof sharedStoreRef.countQuads === "function"
            ? sharedStoreRef.countQuads(q.subject, q.predicate, q.object, graphTerm) > 0
            : (sharedStoreRef.getQuads(q.subject, q.predicate, q.object, graphTerm) || [])
                .length > 0;
        if (exists) continue;
        sharedStoreRef.addQuad(
          DataFactory.quad(q.subject, q.predicate, q.object, graphTerm),
        );

        const subjectValue =
          q.subject && typeof q.subject.value === "string"
            ? String(q.subject.value)
            : pq.s;
        touchedSubjects.add(subjectValue);

        inserted.push({
          s: subjectValue,
          p:
            q.predicate && typeof q.predicate.value === "string"
              ? String(q.predicate.value)
              : pq.p,
          o: pq.o,
          g: graphTerm && graphTerm.value ? String(graphTerm.value) : "urn:vg:inferred",
        });
      } catch (_) {
        /* ignore insertion failure */
      }
    }
    effectiveAdded = inserted;

    if (emitChangeFlag && inserted.length > 0) {
      emitChange({ reason: "reasoning", addedCount: inserted.length });
    }
    if (emitSubjectsFlag && inserted.length > 0) {
      const emission = prepareSubjectEmissionFromSet(
        touchedSubjects,
        sharedStoreRef,
        DataFactory,
      );
      if (emission.subjects.length > 0) {
        emitSubjects(emission.subjects, emission.quadsBySubject);
      }
    }
  } else {
    effectiveAdded = addedPlainAll;
  }

  const { warnings, errors } = collectShaclResults(
    effectiveAdded.map((pq) => ({
      s: pq.s,
      p: pq.p,
      o: pq.o,
      g: pq.g ?? "urn:vg:inferred",
    })),
  );

  const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
  const inferences: ReasoningInference[] = effectiveAdded
    .map((pq) => {
      const subject = pq.s;
      const predicate = pq.p;
      const object = plainObjectToString(pq.o);
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
    added: includeAdded ? effectiveAdded : undefined,
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
