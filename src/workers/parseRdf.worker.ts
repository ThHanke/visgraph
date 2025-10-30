// Full-featured parsing worker (rdf-parse bundled attempt)
// - Attempts to run rdf-parse inside the worker for full format coverage (JSON-LD, RDF/XML, Turtle, etc.)
// - If rdf-parse import or runtime mediation fails, falls back to N3.Parser for Turtle only and posts an error
//   so the main thread can fall back to its own parser when appropriate.
//
// This file is written defensively: it uses dynamic imports and defensive guards to avoid crashing the worker.
// It emits compact plain quad batches to the main thread and waits for ACKs to apply backpressure.

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
  try {
    const msg = ev.data || {};
    if (!msg || !msg.type) return;
    if (msg.type === "ack" && msg.id) {
      pendingAcks.set(String(msg.id), true);
    } else if (msg.type === "cancel" && msg.id) {
      cancelled.add(String(msg.id));
    } else if (msg.type === "parseUrl") {
      const id = String(msg.id || `p-${Date.now().toString(36).slice(2, 8)}`);
      fetchAndParseUrl(id, String(msg.url || ""), msg.timeoutMs, msg.headers || {});
    } else if (msg.type === "parseText") {
      const id = String(msg.id || `p-${Date.now().toString(36).slice(2, 8)}`);
      parseTextAndEmit(id, String(msg.text || ""), msg.mime, msg.baseIRI);
    }
  } catch (_) {
    // ignore bad messages
  }
});

function plainFromTerm(term: any): any {
  try {
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
  } catch (_) {
    return { t: "iri", v: String(term) };
  }
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

// Core parse logic: prefer rdf-parse inside worker for full parity.
// - Accepts text and optional mime/baseIRI.
// - Emits prefix/context events and batched quads, respects ACK backpressure.
// - If rdf-parse cannot be used, falls back to N3.Parser for Turtle.
async function parseTextAndEmit(id: string, text: string, mime?: string, baseIRI?: string) {
  if (!id) return;

  // Normalize content type
  let mimeToUse: string | undefined = undefined;
  try {
    if (typeof mime === "string" && mime) mimeToUse = String(mime).split(";")[0].trim() || undefined;
  } catch (_) {
    mimeToUse = undefined;
  }

  // Try rdf-parse first (full-featured). Use dynamic import so bundler can include it in worker bundle.
  try {
    const rdfPkg = await import("rdf-parse").catch(() => null);
    if (rdfPkg) {
      // Resolve parser entry flexibly
      let rdfParser: any = null;
      if (typeof (rdfPkg as any).parse === "function") rdfParser = rdfPkg;
      else if ((rdfPkg as any).rdfParser && typeof (rdfPkg as any).rdfParser.parse === "function")
        rdfParser = (rdfPkg as any).rdfParser;
      else if ((rdfPkg as any).default && typeof (rdfPkg as any).default.parse === "function")
        rdfParser = (rdfPkg as any).default;

      if (!rdfParser) {
        // Unexpected shape — continue to N3 fallback below
        // notify main for diagnostics
        try {
          (self as any).postMessage({
            type: "error",
            id,
            message: "Worker: rdf-parse import succeeded but parser entry missing - will attempt N3 fallback",
          });
        } catch (_) {}
      } else {
        // Build a Node-style Readable stream from the text for rdf-parse
        // rdf-parse expects a Node stream with .on; convert when possible, otherwise
        // fall back to the WHATWG Readable (may not support .on).
        let input: any = null;
        try {
          const streamMod = await import("stream").catch(() => null);
          const bufferMod = await import("buffer").catch(() => null);
          const Readable = streamMod && (streamMod.Readable || (streamMod.default && streamMod.default.Readable))
            ? (streamMod.Readable || (streamMod.default && streamMod.default.Readable))
            : null;
          const BufferImpl =
            (bufferMod && (bufferMod.Buffer || (bufferMod.default && bufferMod.default.Buffer)))
              ? (bufferMod.Buffer || (bufferMod.default && bufferMod.default.Buffer))
              : (globalThis as any).Buffer;
          if (Readable && BufferImpl && typeof Readable.from === "function") {
            input = Readable.from([BufferImpl.from(text, "utf8")]);
          } else {
            // last-resort: WHATWG stream (Response.body)
            input = (new Response(text)).body as any;
          }
        } catch (_) {
          input = (new Response(text)).body as any;
        }
        const opts: any = {};
        if (mimeToUse) opts.contentType = mimeToUse;
        if (typeof baseIRI === "string" && baseIRI) opts.path = baseIRI;

        try {
          const quadStream = (rdfParser as any).parse(input, opts);
          if (!quadStream || typeof quadStream.on !== "function") {
            throw new Error("rdf-parse returned non-stream value");
          }
          // Collector buffer
          const buffer: any[] = [];
          let seenPrefixes: any = {};
          let ended = false;

          quadStream.on("data", async (q: any) => {
            if (cancelled.has(id)) return;
            try {
              buffer.push(q);
              if (buffer.length >= BATCH_SIZE) {
                const batch = buffer.splice(0, BATCH_SIZE);
                const plain = batch.map((q2: any) => ({
                  s: String(q2.subject && q2.subject.value ? q2.subject.value : q2.subject),
                  p: String(q2.predicate && q2.predicate.value ? q2.predicate.value : q2.predicate),
                  o: plainFromTerm(q2.object),
                  g: q2.graph && q2.graph.value ? String(q2.graph.value) : undefined,
                })) as PlainQuad[];
                try { (self as any).postMessage({ type: "quads", id, quads: plain, final: false }); } catch (_) {}
                await waitForAck(id);
              }
            } catch (e) {
              try { (self as any).postMessage({ type: "error", id, message: String(e) }); } catch (_) {}
            }
          });

          quadStream.on("prefix", (p: string, iri: any) => {
            try {
              seenPrefixes = seenPrefixes || {};
              seenPrefixes[p] = iri;
              (self as any).postMessage({ type: "prefix", id, prefixes: { [p]: iri } });
            } catch (_) {}
          });

          quadStream.on("context", (ctx: any) => {
            try { (self as any).postMessage({ type: "context", id, context: ctx }); } catch (_) {}
          });

          quadStream.on("end", async () => {
            if (ended) return;
            ended = true;
            try {
              if (buffer.length > 0) {
                const plain = buffer.splice(0, buffer.length).map((q2: any) => ({
                  s: String(q2.subject && q2.subject.value ? q2.subject.value : q2.subject),
                  p: String(q2.predicate && q2.predicate.value ? q2.predicate.value : q2.predicate),
                  o: plainFromTerm(q2.object),
                  g: q2.graph && q2.graph.value ? String(q2.graph.value) : undefined,
                })) as PlainQuad[];
                try { (self as any).postMessage({ type: "quads", id, quads: plain, final: true }); } catch (_) {}
                await waitForAck(id);
              } else {
                try { (self as any).postMessage({ type: "end", id }); } catch (_) {}
              }
            } catch (e) {
              try { (self as any).postMessage({ type: "error", id, message: String(e) }); } catch (_) {}
            }
          });

          quadStream.on("error", (err: any) => {
            try { (self as any).postMessage({ type: "error", id, message: String(err) }); } catch (_) {}
          });

          // Successfully handed off to rdf-parse in-worker
          return;
        } catch (err) {
          // If rdf-parse runtime fails inside worker, report and fall back to N3 below
          try {
            (self as any).postMessage({
              type: "error",
              id,
              message: "Worker rdf-parse failed: " + String(err),
            });
          } catch (_) {}
          // continue to N3 fallback
        }
      }
    }
  } catch (err) {
    // dynamic import failed or other error: fall through to N3 fallback
    try {
      (self as any).postMessage({ type: "error", id, message: "Worker rdf-parse import error: " + String(err) });
    } catch (_) {}
  }

  // N3 fallback (Turtle only)
  try {
    const N3 = await import("n3").catch(() => null);
    if (!N3 || typeof N3.Parser !== "function") {
      try { (self as any).postMessage({ type: "error", id, message: "Worker: no N3 parser available" }); } catch (_) {}
      return;
    }
    const Parser = N3.Parser;
    const p = new Parser();
    const collected: any[] = [];
    let parsedPrefixes: any = null;

    p.parse(text, (err: any, quad: any, prefixes: any) => {
      if (err) {
        try { (self as any).postMessage({ type: "error", id, message: String(err) }); } catch (_) {}
        return;
      }
      if (quad) collected.push(quad);
      else if (prefixes && typeof prefixes === "object") parsedPrefixes = prefixes;
    });

    if (parsedPrefixes) {
      try { (self as any).postMessage({ type: "prefix", id, prefixes: parsedPrefixes }); } catch (_) {}
    }

    for (let i = 0; i < collected.length; i += BATCH_SIZE) {
      if (cancelled.has(id)) break;
      const batch = collected.slice(i, i + BATCH_SIZE);
      const plain = batch.map((q: any) => ({
        s: String(q.subject && q.subject.value ? q.subject.value : q.subject),
        p: String(q.predicate && q.predicate.value ? q.predicate.value : q.predicate),
        o: plainFromTerm(q.object),
        g: q.graph && q.graph.value ? String(q.graph.value) : undefined,
      })) as PlainQuad[];
      const isLast = i + BATCH_SIZE >= collected.length;
      try { (self as any).postMessage({ type: "quads", id, quads: plain, final: isLast }); } catch (_) {}
      await waitForAck(id);
    }

    try { (self as any).postMessage({ type: "end", id }); } catch (_) {}
    return;
  } catch (err) {
    try { (self as any).postMessage({ type: "error", id, message: "Worker parse failed: " + String(err) }); } catch (_) {}
    return;
  }
}

async function fetchAndParseUrl(id: string, url: string, timeoutMs?: number, headers?: any) {
  const ctrl = new AbortController();
  const to = typeof timeoutMs === "number" ? timeoutMs : 15000;
  const tH = setTimeout(() => {
    try { ctrl.abort(); } catch (_) { void 0; }
  }, to);

  try {
    const init: any = {
      signal: ctrl.signal,
      redirect: "follow",
      headers: headers || { Accept: "text/turtle, application/rdf+xml, application/ld+json, */*" },
    };
    const resp = await fetch(url, init);
    try { clearTimeout(tH); } catch (_) { void 0; }
    const contentType = resp.headers && typeof resp.headers.get === "function" ? resp.headers.get("content-type") : null;
    try { (self as any).postMessage({ type: "start", id, contentType, status: resp.status, statusText: resp.statusText }); } catch (_) {}
    const text = await resp.text();
    await parseTextAndEmit(id, text, contentType || undefined, url);
    try { (self as any).postMessage({ type: "end", id }); } catch (_) {}
  } catch (err) {
    try { clearTimeout(tH); } catch (_) { void 0; }
    try { (self as any).postMessage({ type: "error", id, message: String(err) }); } catch (_) {}
  }
}

self.addEventListener("message", (ev: MessageEvent) => {
  try {
    const msg = ev.data || {};
    if (!msg || !msg.type) return;
    if (msg.type === "parseUrl") {
      const id = String(msg.id || `p-${Date.now().toString(36).slice(2,8)}`);
      fetchAndParseUrl(id, String(msg.url || ""), msg.timeoutMs, msg.headers);
    } else if (msg.type === "parseText") {
      const id = String(msg.id || `p-${Date.now().toString(36).slice(2,8)}`);
      parseTextAndEmit(id, String(msg.text || ""), msg.mime, msg.baseIRI);
    } else if (msg.type === "cancel" && msg.id) {
      cancelled.add(String(msg.id));
    } else if (msg.type === "ack" && msg.id) {
      pendingAcks.set(String(msg.id), true);
    }
  } catch (_) {
    void 0;
  }
});
