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

type LoadMessage = {
  type: "loadFromUrl";
  id: string;
  url: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
};

type AckMessage = { type: "ack"; id: string };

const pendingAcks = new Map<string, boolean>();

self.addEventListener("message", (event: MessageEvent<AckMessage | LoadMessage>) => {
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
