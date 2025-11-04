// Deterministic RDF parsing worker
// - Always convert response WHATWG stream to a Node-style Readable (using readable-stream + buffer).
// - Fail fast if Node-style Readable cannot be created (no WHATWG fallback).
// - Use rdf-parse to parse streams. Parser selection is deterministic:
//     1) If response content-type is in rdf-parse.getContentTypes() -> use that contentType.
//     2) Otherwise provide a path (filename) so rdf-parse can detect by extension.
// - Emit clear stage debug messages so dev and prod behave identically.
//
// Messages posted to main:
// - { type: "stage", id, stage, info?: any }  // debug stages
// - { type: "quads", id, quads: PlainQuad[], final: boolean }
// - { type: "prefix", id, prefixes }
// - { type: "context", id, context }
// - { type: "end", id }
// - { type: "error", id, message, details? }
//
// Keep this file straightforward and linear (minimal nested try/catch).
import { Readable } from "readable-stream";
import { Buffer } from "buffer";
(globalThis as any).Buffer = Buffer;
import rdfParsePkg from "rdf-parse";

declare const self: any;

const BATCH_SIZE = 1000;

type PlainQuad = {
  s: string;
  p: string;
  o: { t: "iri" | "bnode" | "lit"; v: string; dt?: string; ln?: string };
  g?: string;
};

function plainFromTerm(term: any): any {
  if (!term) return null;
  const tt = (term && term.termType ? String(term.termType) : "").toLowerCase();
  if (tt === "namednode" || tt === "iri") return { t: "iri", v: String(term.value || term) };
  if (tt === "blanknode" || tt === "bnode") return { t: "bnode", v: String(term.value || term) };
  if (tt === "literal" || typeof (term && term.value) !== "undefined") {
    const obj: any = { t: "lit", v: String(term.value || "") };
    if (term.datatype && term.datatype.value) obj.dt = String(term.datatype.value);
    if (term.language) obj.ln = String(term.language);
    return obj;
  }
  return { t: "iri", v: String(term) };
}

function waitForAck(id: string) {
  return new Promise<void>((resolve) => {
    const key = String(id);
    const check = () => {
      if (typeof cancelledSet !== "undefined" && (cancelledSet as Set<string>).has(key)) {
        resolve();
        return;
      }
      // In this worker we rely on main thread to post ack messages.
      // If no ack arrives, we'll poll.
      if ((pendingAcks as Map<string, boolean>).get(key)) {
        (pendingAcks as Map<string, boolean>).delete(key);
        resolve();
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

// Local small maps used for ack/cancel signalling by manager.
// Manager uses postMessage to send { type: "ack", id } and { type: "cancel", id }.
const pendingAcks = new Map<string, boolean>();
const cancelledSet = new Set<string>();
self.addEventListener("message", (ev: MessageEvent) => {
  const m = ev && ev.data ? ev.data : {};
  if (!m || !m.type) return;
  if (m.type === "ack" && m.id) pendingAcks.set(String(m.id), true);
  if (m.type === "cancel" && m.id) cancelledSet.add(String(m.id));
});

// Create a Node-style Readable from a Response in a deterministic way.
// Returns { readable, method } or null. Uses Readable (readable-stream) + Buffer.
async function createNodeReadableFromResponse(resp: any): Promise<{ readable: any; method: string } | null> {
  if (!resp || !resp.body) return null;

  // Prefer Readable.fromWeb if available on our imported Readable
  if (typeof (Readable as any).fromWeb === "function") {
    try {
      const r = (Readable as any).fromWeb(resp.body);
      return { readable: r, method: "readable-stream.fromWeb" };
    } catch (e) {
      // fall through to reader-based fallback
      // intentionally not silent in main logs — worker will emit stage when created or fail later
    }
  }

  // Reader-based fallback: consume WHATWG stream into a Uint8Array buffer and create Readable.from([Buffer])
  if (resp.body && typeof (resp.body as any).getReader === "function" && typeof (Readable as any).from === "function") {
    const reader = (resp.body as any).getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      // read loop
      // eslint-disable-next-line no-await-in-loop
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
    if (BufferImpl) {
      const nodeReadable = (Readable as any).from([BufferImpl.from(buf)]);
      return { readable: nodeReadable, method: "readable-stream.from+buffer" };
    }
  }

  // Last resort: attempt to read full arrayBuffer and create Readable.from
  try {
    const arr = await resp.arrayBuffer();
    const BufferImpl2 = (globalThis as any).Buffer || Buffer;
    if (typeof (Readable as any).from === "function" && BufferImpl2) {
      const nodeReadable = (Readable as any).from([BufferImpl2.from(new Uint8Array(arr))]);
      return { readable: nodeReadable, method: "arrayBuffer->buffer->from" };
    }
  } catch (_) {
    // nothing else to do
  }

  return null;
}

// Normalize rdf-parse export shape
function resolveRdfParser(pkg: any) {
  if (!pkg) return null;
  if (typeof pkg.parse === "function") return pkg;
  if (pkg.rdfParser && typeof pkg.rdfParser.parse === "function") return pkg.rdfParser;
  if (pkg.default && typeof pkg.default.parse === "function") return pkg.default;
  return null;
}

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev && ev.data ? ev.data : {};
  if (!msg || !msg.type || msg.type !== "parseUrl") return;

  const id = String(msg.id || `p-${Date.now().toString(36).slice(2,8)}`);
  const url = String(msg.url || "");
  const timeoutMs = typeof msg.timeoutMs === "number" ? Number(msg.timeoutMs) : 15000;

  // Stage: start
  try { self.postMessage({ type: "stage", id, stage: "start", url }); } catch (_) {}

  if (!url) {
    try { self.postMessage({ type: "error", id, message: "no url provided" }); } catch (_) {}
    return;
  }

  const ctrl = new AbortController();
  const to = timeoutMs;
  const tH = setTimeout(() => ctrl.abort(), to);

  // Fetch
  let resp: any;
  try {
    resp = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: msg.headers || {} });
    clearTimeout(tH);
    self.postMessage({ type: "stage", id, stage: "fetched", status: resp.status, statusText: resp.statusText });
  } catch (err: any) {
    clearTimeout(tH);
    try { self.postMessage({ type: "stage", id, stage: "fetch-failed", message: String(err && err.message ? err.message : err) }); } catch (_) {}
    try { self.postMessage({ type: "error", id, message: "fetch-failed", details: String(err) }); } catch (_) {}
    return;
  }

  // Always require Node-style Readable (deterministic)
  const nodeReadableResult = await createNodeReadableFromResponse(resp.clone ? resp.clone() : resp);
  if (!nodeReadableResult || !nodeReadableResult.readable) {
    try { self.postMessage({ type: "stage", id, stage: "node-readable-failed" }); } catch (_) {}
    try { self.postMessage({ type: "error", id, message: "node-readable-creation-failed", details: "readable-stream conversion unavailable" }); } catch (_) {}
    return;
  }
  // Stage: node-readable
  try { self.postMessage({ type: "stage", id, stage: "node-readable-created", method: nodeReadableResult.method }); } catch (_) {}

  // Resolve parser and supported media
  const rdfPkgAny: any = rdfParsePkg;
  let rdfParser = resolveRdfParser(rdfPkgAny);

  // If static import didn't yield a usable parser (some bundlers/proxies change shape),
  // try a dynamic import at runtime as a fallback and surface diagnostics.
  if (!rdfParser) {
    try {
      const ks = rdfPkgAny && typeof rdfPkgAny === "object" ? Object.keys(rdfPkgAny) : typeof rdfPkgAny;
      try { self.postMessage({ type: "stage", id, stage: "rdf-parse-shape", keys: ks }); } catch (_) {}
      const dyn: any = await import("rdf-parse").catch(() => null);
      if (dyn) {
        rdfParser = resolveRdfParser(dyn);
        try { self.postMessage({ type: "stage", id, stage: "rdf-parse-dynamic-import", available: Boolean(rdfParser) }); } catch (_) {}
      }
    } catch (e) {
      try { self.postMessage({ type: "stage", id, stage: "rdf-parse-dynamic-import-failed", message: String(e) }); } catch (_) {}
    }
  }

  const supportedMedia = new Set<string>();
  if (rdfParser && typeof rdfParser.getContentTypes === "function") {
    try {
      const types = await rdfParser.getContentTypes();
      if (Array.isArray(types)) {
        types.forEach((t: any) => {
          if (t) supportedMedia.add(String(t).split(";")[0].trim().toLowerCase());
        });
      }
    } catch (e) {
      try { self.postMessage({ type: "stage", id, stage: "rdf-parse-getContentTypes-failed", message: String(e) }); } catch (_) {}
    }
  }

  // Determine contentType / path per your requested deterministic logic
  const contentTypeHeader = resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("content-type") : null;
  const ctRaw = contentTypeHeader ? String(contentTypeHeader).split(";")[0].trim().toLowerCase() : null;
  const opts: any = {};
  let parserReason = "";
  if (ctRaw && supportedMedia.has(ctRaw)) {
    opts.contentType = ctRaw;
    opts.path = url;
    parserReason = "content-type";
  } else {
    // filename route
    try {
      const u = new URL(url);
      const seg = u.pathname.split("/").filter(Boolean).pop();
      opts.path = seg && /\.[a-z0-9]{1,8}(?:[?#]|$)/i.test(seg) ? seg : url;
      parserReason = "filename";
    } catch (_) {
      opts.path = url;
      parserReason = "filename";
    }
  }

  // Stage: parser-chosen
  try { self.postMessage({ type: "stage", id, stage: "parser-chosen", parser: rdfParser ? "rdf-parse" : "none", reason: parserReason, opts }); } catch (_) {}

  // Start parsing using Node Readable
  const inputReadable = nodeReadableResult.readable;

  if (!rdfParser || typeof rdfParser.parse !== "function") {
    try { self.postMessage({ type: "stage", id, stage: "no-parser", message: "rdf-parse not available" }); } catch (_) {}
    try { self.postMessage({ type: "error", id, message: "parser-unavailable" }); } catch (_) {}
    return;
  }

  // parse stage
  try { self.postMessage({ type: "stage", id, stage: "parsing-started" }); } catch (_) {}

  const quadStream = rdfParser.parse(inputReadable, opts);

  // Buffer and emit batched quads
  const buffer: any[] = [];
  let ended = false;

  quadStream.on("data", async (q: any) => {
    buffer.push(q);
    if (buffer.length >= BATCH_SIZE) {
      const batch = buffer.splice(0, BATCH_SIZE);
      const plain = batch.map((q2: any) => ({
        s: String(q2.subject && q2.subject.value ? q2.subject.value : q2.subject),
        p: String(q2.predicate && q2.predicate.value ? q2.predicate.value : q2.predicate),
        o: plainFromTerm(q2.object),
        g: q2.graph && q2.graph.value ? String(q2.graph.value) : undefined,
      })) as PlainQuad[];
      self.postMessage({ type: "quads", id, quads: plain, final: false });
      self.postMessage({ type: "stage", id, stage: "quads-batch", size: plain.length });
      await waitForAck(id);
    }
  });

  quadStream.on("prefix", (p: string, iri: any) => {
    self.postMessage({ type: "prefix", id, prefixes: { [p]: iri } });
    self.postMessage({ type: "stage", id, stage: "prefix", prefix: p, iri });
  });

  quadStream.on("context", (ctx: any) => {
    self.postMessage({ type: "context", id, context: ctx });
    self.postMessage({ type: "stage", id, stage: "context" });
  });

  quadStream.on("end", async () => {
    if (ended) return;
    ended = true;
    if (buffer.length > 0) {
      const plain = buffer.splice(0, buffer.length).map((q2: any) => ({
        s: String(q2.subject && q2.subject.value ? q2.subject.value : q2.subject),
        p: String(q2.predicate && q2.predicate.value ? q2.predicate.value : q2.predicate),
        o: plainFromTerm(q2.object),
        g: q2.graph && q2.graph.value ? String(q2.graph.value) : undefined,
      })) as PlainQuad[];
      self.postMessage({ type: "quads", id, quads: plain, final: true });
      self.postMessage({ type: "stage", id, stage: "quads-batch-final", size: plain.length });
      await waitForAck(id);
    }
    self.postMessage({ type: "stage", id, stage: "parsing-ended" });
    self.postMessage({ type: "end", id });
  });

  quadStream.on("error", (err: any) => {
    self.postMessage({ type: "stage", id, stage: "parsing-error", message: String(err) });
    self.postMessage({ type: "error", id, message: String(err) });
  });
};
