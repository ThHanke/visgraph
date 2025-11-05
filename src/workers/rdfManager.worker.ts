import { Readable } from "readable-stream";
import { Buffer } from "buffer";
(globalThis as any).Buffer = Buffer;
import rdfParsePkg from "rdf-parse";
import * as N3 from "n3";

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
  quads: PlainQuad[];
  rulesets?: string[];
  baseUrl?: string;
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
  added: PlainQuad[];
  warnings: ReasoningWarning[];
  errors: ReasoningError[];
  inferences: ReasoningInference[];
  usedReasoner: boolean;
};

type ReasoningErrorMessage = {
  type: "reasoningError";
  id: string;
  message: string;
  stack?: string;
};

const pendingAcks = new Map<string, boolean>();

self.addEventListener("message", (event: MessageEvent<AckMessage | LoadMessage | ReasoningRequest>) => {
  const msg = event.data;
  if (!msg) return;
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
    handleRunReasoning(msg).catch((err) => {
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

function plainToQuad(pq: PlainQuad, DataFactory: any): any {
  const { namedNode, blankNode, literal, quad } = DataFactory;
  const sTerm = /^_:/.test(String(pq.s || ""))
    ? blankNode(String(pq.s).replace(/^_:/, ""))
    : namedNode(String(pq.s));
  const pTerm = namedNode(String(pq.p));
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

async function handleRunReasoning(msg: ReasoningRequest) {
  const startTime = Date.now();
  reasoningStage({ type: "reasoningStage", id: msg.id, stage: "start" });

  const { DataFactory, StoreCls, ParserCls, ReasonerCls } = resolveN3();
  if (!DataFactory || !StoreCls) {
    reasoningStage({ type: "reasoningStage", id: msg.id, stage: "n3-unavailable" });
    throw new Error("n3-api-unavailable");
  }

  const store = new (StoreCls as any)();
  const beforeKeys = new Set<string>();

  try {
    for (const pq of msg.quads || []) {
      try {
        const q = plainToQuad(pq, DataFactory);
        store.addQuad(q);
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
  } catch (_) {
    // ignore top-level ingestion failures; proceed with what we have
  }

  try {
    const countsBefore = collectGraphCountsFromStore(store);
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

  const rulesets = Array.isArray(msg.rulesets) ? msg.rulesets.filter((r) => typeof r === "string" && r) : [];
  const baseUrlRaw = typeof msg.baseUrl === "string" && msg.baseUrl.length > 0 ? msg.baseUrl : "/";
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
      return (self as any).location && (self as any).location.origin ? String((self as any).location.origin) : "";
    } catch (_) {
      return "";
    }
  })();

  const fetchRuleText = async (name: string) => {
    const attemptsSet = new Set<string>();
    attemptsSet.add(`${normalizedBase}reasoning-rules/${name}`);
    attemptsSet.add(`/reasoning-rules/${name}`);
    attemptsSet.add(`reasoning-rules/${name}`);
    if (workerDir) attemptsSet.add(`${workerDir}reasoning-rules/${name}`);
    if (origin) {
      attemptsSet.add(`${origin}${normalizedBase}reasoning-rules/${name}`);
      attemptsSet.add(`${origin}/reasoning-rules/${name}`);
      if (workerDir) attemptsSet.add(`${origin}${workerDir}reasoning-rules/${name}`);
    }
    attemptsSet.add(name);
    const attempts = Array.from(attemptsSet);
    for (const url of attempts) {
      try {
        const resp = await fetch(url);
        if (resp && resp.ok) {
          const text = await resp.text();
          if (text && text.length) return text;
        }
      } catch (_) {
        // try next candidate
      }
    }
    return "";
  };

  try {
    console.debug("[VG_REASONING_WORKER] requested reasoning rulesets", {
      id: msg.id,
      requested: rulesets,
    });
  } catch (_) {
    // ignore logging errors
  }

  if (parser && rulesets.length > 0) {
    for (const name of rulesets) {
      try {
        reasoningStage({ type: "reasoningStage", id: msg.id, stage: "fetch-ruleset", meta: { name } });
        const text = await fetchRuleText(String(name));
        if (text && text.trim()) {
          const parsed = parser.parse(text);
          if (Array.isArray(parsed) && parsed.length) {
            parsedRules.push(...parsed);
            ruleDiagnostics.push({ name: String(name), quadCount: parsed.length });
            reasoningStage({
              type: "reasoningStage",
              id: msg.id,
              stage: "ruleset-parsed",
              meta: { name, quadCount: parsed.length },
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
    try {
      const defaultName = "best-practice.n3";
      reasoningStage({ type: "reasoningStage", id: msg.id, stage: "fetch-default-rules" });
      const text = await fetchRuleText(defaultName);
      if (text && text.trim()) {
        const parsed = parser.parse(text);
        if (Array.isArray(parsed) && parsed.length) {
          parsedRules.push(...parsed);
          ruleDiagnostics.push({ name: defaultName, quadCount: parsed.length });
          reasoningStage({
            type: "reasoningStage",
            id: msg.id,
            stage: "default-rules-parsed",
            meta: { quadCount: parsed.length },
          });
        }
      }
    } catch (err) {
      reasoningStage({
        type: "reasoningStage",
        id: msg.id,
        stage: "default-rules-error",
        meta: { error: String((err as Error).message || err) },
      });
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
  if (ReasonerCls) {
    try {
      const reasoner = new (ReasonerCls as any)(store);
      let rulesInput: any = undefined;
      if (parsedRules.length > 0 && StoreCls) {
        try {
          rulesInput = new (StoreCls as any)(parsedRules);
        } catch (_) {
          rulesInput = parsedRules;
        }
      }
      const totalRuleQuads = ruleDiagnostics.reduce((acc, item) => acc + item.quadCount, 0);
      reasoningStage({
        type: "reasoningStage",
        id: msg.id,
        stage: "reasoner-start",
        meta: { ruleQuadCount: totalRuleQuads },
      });
      const reasonerStart = Date.now();
      const maybePromise = reasoner.reason(rulesInput);
      if (maybePromise && typeof maybePromise.then === "function") {
        await maybePromise;
      }
      usedReasoner = true;
      const reasonerDuration = Date.now() - reasonerStart;
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

  const afterQuads = store.getQuads(null, null, null, null) || [];
  const addedPlain: PlainQuad[] = [];
  const seenKeys = new Set<string>();
  for (const q of afterQuads) {
    const key = quadKeyFromTerms(q);
    if (beforeKeys.has(key)) continue;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    addedPlain.push(quadToPlain(q, "urn:vg:inferred"));
  }

  const { warnings, errors } = collectShaclResults(
    addedPlain.map((pq) => ({
      s: pq.s,
      p: pq.p,
      o: pq.o,
      g: pq.g ?? "urn:vg:inferred",
    })),
  );
  if (!usedReasoner) {
    reasoningStage({
      type: "reasoningStage",
      id: msg.id,
      stage: "reasoner-missing",
      meta: { message: "Reasoner unavailable after execution attempt" },
    });
    throw new Error("Reasoner unavailable or failed to execute");
  }

  const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
  const inferences: ReasoningInference[] = addedPlain
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

  const durationMs = Date.now() - startTime;

  try {
    const countsAfter = collectGraphCountsFromStore(store);
    console.debug("[VG_REASONING_WORKER] quad counts after reasoning", {
      id: msg.id,
      durationMs,
      total: Object.values(countsAfter).reduce((acc, v) => acc + v, 0),
      counts: countsAfter,
      addedCount: addedPlain.length,
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
    added: addedPlain,
    warnings,
    errors,
    inferences,
    usedReasoner,
  };

  post(result);
  reasoningStage({
    type: "reasoningStage",
    id: msg.id,
    stage: "complete",
    meta: {
      durationMs,
      addedCount: addedPlain.length,
      usedReasoner,
      inferenceCount: usedReasoner ? inferences.length : 0,
      ruleQuadCount: ruleDiagnostics.reduce((acc, item) => acc + item.quadCount, 0),
    },
  });
}
