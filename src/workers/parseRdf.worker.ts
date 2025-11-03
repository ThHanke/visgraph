 // Stream-first parsing worker for browser environment.
 // Minimal, no fallbacks, no try/catch - failures surface directly.
 // Relies on bundler-provided polyfills (readable-stream, stream-browserify, buffer, process).

import './polyfills';
import { Buffer } from 'buffer';
(globalThis as any).Buffer = Buffer;
import process from 'process/browser';
(globalThis as any).process = process;
import { Readable } from 'readable-stream';

const BATCH_SIZE = 1000;

type PlainQuad = {
  s: string;
  p: string;
  o: { t: "iri" | "bnode" | "lit"; v: string; dt?: string; ln?: string };
  g?: string;
};

const pendingAcks = new Map<string, boolean>();
const cancelled = new Set<string>();

self.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data || {};
  if (!msg || !msg.type) return;
  if (msg.type === "ack" && msg.id) {
    pendingAcks.set(String(msg.id), true);
  } else if (msg.type === "cancel" && msg.id) {
    cancelled.add(String(msg.id));
  } else if (msg.type === "parseUrl") {
    const id = String(msg.id || `p-${Date.now().toString(36).slice(2, 8)}`);
    fetchAndParseUrl(id, String(msg.url || ""), msg.timeoutMs, msg.headers || {});
  }
});

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
      if (cancelled.has(key)) {
        resolve();
        return;
      }
      if (pendingAcks.get(key)) {
        pendingAcks.delete(key);
        resolve();
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
}

async function fetchAndParseUrl(id: string, url: string, timeoutMs?: number, headers?: any) {
  if (!id) return;

  // Heartbeat / ready
  (self as any).postMessage({ type: "ready", id });

  const ctrl = new AbortController();
  const to = typeof timeoutMs === "number" ? timeoutMs : 15000;
  const tH = setTimeout(() => { ctrl.abort(); }, to);

  const init: any = {
    signal: ctrl.signal,
    redirect: "follow",
    headers: headers || { Accept: "text/turtle, application/rdf+xml, application/ld+json, */*" },
  };

  const resp = await fetch(url, init);
  clearTimeout(tH);

  const contentType = resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("content-type") : null;
  (self as any).postMessage({ type: "start", id, contentType, status: resp.status, statusText: resp.statusText });

  const body = resp.body as any;

  let nodeReadable: any;
  if (body && typeof body.on === "function") {
    nodeReadable = body;
  } else {
    // Convert WHATWG ReadableStream to Node-style Readable using readable-stream polyfill
    nodeReadable = Readable.from(body as any);
  }

  // Build parse options carefully:
  // - Only pass contentType when it's a media type rdf-parse understands.
  // - Otherwise provide a `path` (filename) so rdf-parse can detect format from the filename/extension.
  const opts: any = {};
  const ctRaw = contentType ? String(contentType).split(";")[0].trim().toLowerCase() : null;
  let supportedMedia = new Set<string>([
    "text/turtle",
    "text/n3",
    "application/n-triples",
    "application/n-quads",
    "application/rdf+xml",
    "application/ld+json",
    "application/trig",
    "application/turtle",
    "application/n3"
  ]);

  if (ctRaw && supportedMedia.has(ctRaw)) {
    opts.contentType = ctRaw;
    opts.path = url;
  } else {
    // Derive a filename for rdf-parse to inspect: prefer content-disposition, then URL path segment.
    try {
      let filename: string | null = null;
      if (resp.headers && typeof resp.headers.get === "function") {
        const cd = resp.headers.get("content-disposition");
        if (cd) {
          // filename*=UTF-8''... or filename="..."
          const mStar = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(cd);
          const m = /filename\s*=\s*"?([^";]+)"?/i.exec(cd);
          if (mStar && mStar[1]) {
            try { filename = decodeURIComponent(mStar[1]); } catch (_) { filename = mStar[1]; }
          } else if (m && m[1]) {
            filename = m[1];
          }
        }
      }
      if (!filename) {
        try {
          const u = new URL(url);
          const seg = u.pathname.split("/").filter(Boolean).pop();
          if (seg && /\.[a-z0-9]{1,8}(?:[?#]|$)/i.test(seg)) filename = seg;
        } catch (_) {
          /* ignore URL parse failures */
        }
      }
      opts.path = filename || url;
    } catch (_) {
      opts.path = url;
    }
  }

  const rdfPkg: any = await import("rdf-parse");
  let rdfParser: any = null;
  if (typeof rdfPkg.parse === "function") rdfParser = rdfPkg;
  else if (rdfPkg.rdfParser && typeof rdfPkg.rdfParser.parse === "function") rdfParser = rdfPkg.rdfParser;
  else if (rdfPkg.default && typeof rdfPkg.default.parse === "function") rdfParser = rdfPkg.default;

  // Prefer to derive supported content types from rdf-parse itself when available.
  try {
    if (rdfParser && typeof rdfParser.getContentTypes === "function") {
      try {
        const types = await rdfParser.getContentTypes();
        try { console.log("[VG_RDF_WORKER] rdf-parse supported content types:", types); } catch (_) { /* ignore */ }
        if (Array.isArray(types) && types.length > 0) {
          supportedMedia = new Set(types.map((t: any) => String(t).toLowerCase()));
        }
      } catch (_) {
        /* ignore getContentTypes failures and keep static list */
      }
    }
  } catch (_) {
    /* ignore */
  }

  const quadStream = rdfParser.parse(nodeReadable, opts);

  const buffer: any[] = [];
  let ended = false;

  quadStream.on("data", async (q: any) => {
    if (cancelled.has(id)) return;
    buffer.push(q);
    if (buffer.length >= BATCH_SIZE) {
      const batch = buffer.splice(0, BATCH_SIZE);
      const plain = batch.map((q2: any) => ({
        s: String(q2.subject && q2.subject.value ? q2.subject.value : q2.subject),
        p: String(q2.predicate && q2.predicate.value ? q2.predicate.value : q2.predicate),
        o: plainFromTerm(q2.object),
        g: q2.graph && q2.graph.value ? String(q2.graph.value) : undefined,
      })) as PlainQuad[];
      (self as any).postMessage({ type: "quads", id, quads: plain, final: false });
      await waitForAck(id);
    }
  });

  quadStream.on("prefix", (p: string, iri: any) => {
    (self as any).postMessage({ type: "prefix", id, prefixes: { [p]: iri } });
  });

  quadStream.on("context", (ctx: any) => {
    (self as any).postMessage({ type: "context", id, context: ctx });
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
      (self as any).postMessage({ type: "quads", id, quads: plain, final: true });
      await waitForAck(id);
      (self as any).postMessage({ type: "end", id });
    } else {
      (self as any).postMessage({ type: "end", id });
    }
  });

  quadStream.on("error", (err: any) => {
    (self as any).postMessage({ type: "error", id, message: String(err) });
  });
}
