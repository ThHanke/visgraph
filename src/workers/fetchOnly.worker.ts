// Full-featured parsing worker (rdf-parse bundled attempt)
// - Attempts to run rdf-parse inside the worker for full format coverage (JSON-LD, RDF/XML, Turtle, etc.)
// - If rdf-parse import or runtime mediation fails, falls back to N3.Parser for Turtle only and posts an error
//   so the main thread can fall back to its own parser when appropriate.
//
// This worker removes non-informative try/catch wrappers so runtime failures are surfaced
// via postMessage({ type: "error", ... }) instead of being swallowed silently.
// Additional verbose diagnostic posts were added so runtime import/failure points are visible
// from the main thread during debugging.

const BATCH_SIZE = 1000;

/* Safe posting helper - uses postMessage when available, falls back to console.error so
   errors are still visible when worker code is inlined to the main thread. */
function safePost(msg: any, transfer?: any[]) {
  try {
    (self as any).postMessage(msg, transfer || []);
    return true;
  } catch (e) {
    try { console.error('[parse-worker-safePost-fallback]', msg, e); } catch (_) { /* noop */ }
    return false;
  }
}

/* Global error/diagnostic handlers so unhandled failures surface to the main thread quickly.
   These postMessage hooks ensure silent runtime errors are reported back for debugging. */
try {
  self.addEventListener('error', (ev: any) => {
    try {
      safePost({
        type: 'error',
        id: 'parse-worker-global',
        message: String(ev && ev.message ? ev.message : ev),
        stack: ev && ev.error && ev.error.stack ? String(ev.error.stack) : undefined,
      });
    } catch (_) { /* noop */ }
  });
  self.addEventListener('unhandledrejection', (ev: any) => {
    try {
      safePost({
        type: 'error',
        id: 'parse-worker-unhandledrejection',
        message: String(ev && (ev as any).reason ? (ev as any).reason : ev),
        stack: ev && (ev as any).reason && (ev as any).reason.stack ? String((ev as any).reason.stack) : undefined,
      });
    } catch (_) { /* noop */ }
  });
} catch (_) { /* ignore */ }

try {
  safePost({ type: "init", ts: Date.now() });
} catch (_) { /* noop */ }

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
  try {
    (self as any).postMessage({
      type: "debug",
      id: msg && msg.id ? msg.id : "parse-worker-msg",
      phase: "message-received",
      payload: { type: msg && msg.type },
      ts: Date.now(),
    });
  } catch (_) { /* noop */ }
  if (!msg || !msg.type) return;
  if (msg.type === "ack" && msg.id) {
    pendingAcks.set(String(msg.id), true);
  } else if (msg.type === "cancel" && msg.id) {
    cancelled.add(String(msg.id));
  } else if (msg.type === "parseUrl") {
    const id = String(msg.id || `p-${Date.now().toString(36).slice(2, 8)}`);
    // parseUrl is intentionally unsupported: callers must perform fetching via the fetch-only worker
    // and then call parseText or parseStream. Reject loudly so callers see the failure.
    (self as any).postMessage({
      type: "error",
      id,
      message:
        "parseUrl is not supported in parseRdf.worker. Fetch via fetchOnly.worker and call parseText or parseStream with the resulting text/stream.",
      ts: Date.now(),
    });
  } else if (msg.type === "parseText") {
    const id = String(msg.id || `p-${Date.now().toString(36).slice(2, 8)}`);
    parseTextAndEmit(id, String(msg.text || ""), msg.mime, msg.baseIRI);
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

// Core parse logic: prefer rdf-parse inside worker for full parity.
// - Accepts text and optional mime/baseIRI.
// - Emits prefix/context events and batched quads, respects ACK backpressure.
// - If rdf-parse cannot be used, falls back to N3.Parser for Turtle.
async function parseTextAndEmit(id: string, text: string, mime?: string, baseIRI?: string) {
  if (!id) return;

  // Announce worker parse start / heartbeat so main thread watchdogs see activity quickly.
  (self as any).postMessage({ type: "ready", id, ts: Date.now() });

  // Start a lightweight heartbeat so the main thread can observe liveliness during long parses.
  let __vg_hb_interval: any = null;
  __vg_hb_interval = setInterval(() => {
    try {
      (self as any).postMessage({ type: "hb", id, ts: Date.now() });
    } catch (e) {
      /* ignored */
    }
  }, 2000);

  // Normalize content type
  let mimeToUse: string | undefined = undefined;
  if (typeof mime === "string" && mime) mimeToUse = String(mime).split(";")[0].trim() || undefined;
  // Treat generic text/plain as unknown so the parser can sniff by content or use the filename/extension.
  if (mimeToUse === "text/plain") {
    try {
      (self as any).postMessage({ type: "debug", id, phase: "ignore.text_plain", ts: Date.now() });
    } catch (_) { /* noop */ }
    mimeToUse = undefined;
  }

  // Try rdf-parse first (full-featured). Use dynamic import so bundler can include it in worker bundle.
  try {
    try {
      (self as any).postMessage({ type: "debug", id, phase: "rdf-parse.import.start", ts: Date.now() });
    } catch (_) { /* noop */ }

    const rdfPkg = await import("rdf-parse");

    try {
      (self as any).postMessage({
        type: "debug",
        id,
        phase: "rdf-parse.import.done",
        ts: Date.now(),
        keys: rdfPkg && typeof rdfPkg === "object" ? Object.keys(rdfPkg).slice(0, 20) : typeof rdfPkg,
      });
    } catch (_) { /* noop */ }

    if (rdfPkg) {
      // Resolve parser entry flexibly
      let rdfParser: any = null;
      if (typeof (rdfPkg as any).parse === "function") rdfParser = rdfPkg;
      else if ((rdfPkg as any).rdfParser && typeof (rdfPkg as any).rdfParser.parse === "function")
        rdfParser = (rdfPkg as any).rdfParser;
      else if ((rdfPkg as any).default && typeof (rdfPkg as any).default.parse === "function")
        rdfParser = (rdfPkg as any).default;

      if (!rdfParser) {
        // Unexpected shape — notify main and fall back to N3
        (self as any).postMessage({
          type: "error",
          id,
          message: "Worker: rdf-parse import succeeded but parser entry missing - falling back to N3",
          ts: Date.now(),
        });
      } else {
        // Build a Node-style Readable stream from the text for rdf-parse
        let input: any = null;

        try {
          (self as any).postMessage({ type: "debug", id, phase: "import.stream.start", ts: Date.now() });
        } catch (_) { /* noop */ }

        const streamMod = await import("stream").catch((e) => {
          (self as any).postMessage({ type: "debug", id, phase: "import.stream.failed", ts: Date.now(), message: String(e), stack: e && e.stack ? String(e.stack) : undefined });
          return { Readable: undefined } as any;
        });
        const bufferMod = await import("buffer").catch((e) => {
          (self as any).postMessage({ type: "debug", id, phase: "import.buffer.failed", ts: Date.now(), message: String(e), stack: e && e.stack ? String(e.stack) : undefined });
          return { Buffer: (globalThis as any).Buffer } as any;
        });

        const Readable = streamMod && (streamMod.Readable || (streamMod.default && streamMod.default.Readable))
          ? (streamMod.Readable || (streamMod.default && streamMod.default.Readable))
          : null;
        const BufferImpl =
          (bufferMod && (bufferMod.Buffer || (bufferMod.default && bufferMod.default.Buffer)))
            ? (bufferMod.Buffer || (bufferMod.default && bufferMod.default.Buffer))
            : (globalThis as any).Buffer;

        try {
          (self as any).postMessage({ type: "debug", id, phase: "import.stream.resolved", ts: Date.now(), hasReadable: !!Readable, hasBuffer: typeof BufferImpl !== "undefined" });
        } catch (_) { /* noop */ }

        if (Readable && BufferImpl && typeof (Readable as any).from === "function") {
          try {
            input = (Readable as any).from([BufferImpl.from(text, "utf8")]);
          } catch (e) {
            (self as any).postMessage({ type: "debug", id, phase: "readable.from.failed", ts: Date.now(), message: String(e), stack: e && e.stack ? String(e.stack) : undefined });
            // Fall through to emulated-Readable creation below
          }
        }

        // If we don't have a native Node Readable (browser worker), emulate a minimal Node-style
        // Readable that emits 'data' and 'end' events synchronously after buffering the text.
        if (!input) {
          try {
            // Buffer cutoff (20 MiB) to avoid unbounded memory usage in the worker.
            const MAX_BYTES = 20 * 1024 * 1024;
            // Try to build a Uint8Array payload
            let payloadU8: Uint8Array;
            try {
              if (typeof TextEncoder !== "undefined") {
                payloadU8 = new TextEncoder().encode(String(text || ""));
              } else {
                // Fallback: simple string->UTF8 conversion
                const s = String(text || "");
                const arr: number[] = [];
                for (let i = 0; i < s.length; ++i) {
                  const code = s.charCodeAt(i);
                  arr.push(code & 0xff);
                }
                payloadU8 = new Uint8Array(arr);
              }
            } catch (e) {
              payloadU8 = new Uint8Array();
            }

            if (payloadU8.byteLength > MAX_BYTES) {
              try { (self as any).postMessage({ type: "debug", id, phase: "buffer.too_large", ts: Date.now(), size: payloadU8.byteLength }); } catch (_) { /* noop */ }
              // For very large payloads, fall back to WHATWG stream to avoid OOM.
              input = (new Response(text)).body as any;
            } else {
              // Determine chunk object to emit: prefer Buffer if available
              const chunkToEmit = (typeof BufferImpl !== "undefined" && typeof (BufferImpl as any).from === "function")
                ? (BufferImpl as any).from(payloadU8)
                : payloadU8;

              // Minimal EventEmitter-style Node Readable shim used only to satisfy rdf-parse actors.
              const listeners: Record<string, Function[]> = { data: [], end: [], error: [] };

              const emu: any = {
                readable: true,
                // Basic EventEmitter .on API
                on(event: string, cb: Function) {
                  if (!listeners[event]) listeners[event] = [];
                  listeners[event].push(cb);
                  return this;
                },
                addListener(event: string, cb: Function) {
                  return this.on(event, cb);
                },
                removeListener(event: string, cb: Function) {
                  if (!listeners[event]) return this;
                  const idx = listeners[event].indexOf(cb);
                  if (idx >= 0) listeners[event].splice(idx, 1);
                  return this;
                },
                pause() { /* noop */ },
                resume() { /* noop */ },
                pipe() { return this; },
                // Provide a legacy .readableEnded flag
                readableEnded: false,
              };

              // Emit data + end asynchronously so consumer can attach handlers first.
              setTimeout(() => {
                try {
                  const ds = listeners["data"] || [];
                  for (const cb of ds.slice()) {
                    try { cb(chunkToEmit); } catch (_) { /* noop per-listener */ }
                  }
                  emu.readableEnded = true;
                  const es = listeners["end"] || [];
                  for (const cb of es.slice()) {
                    try { cb(); } catch (_) { /* noop per-listener */ }
                  }
                } catch (errEmit) {
                  const es = listeners["error"] || [];
                  for (const cb of es.slice()) {
                    try { cb(errEmit); } catch (_) { /* noop */ }
                  }
                }
              }, 0);

              input = emu;
              try { (self as any).postMessage({ type: "debug", id, phase: "emulated.readable.created", ts: Date.now(), size: payloadU8.byteLength }); } catch (_) { /* noop */ }
            }
          } catch (e) {
            // As a last resort, return a WHATWG stream
            input = (new Response(text)).body as any;
          }
        }

        const opts: any = {};
        if (mimeToUse) opts.contentType = mimeToUse;
        if (typeof baseIRI === "string" && baseIRI) opts.path = baseIRI;

        let quadStream: any;
        try {
          quadStream = (rdfParser as any).parse(input, opts);
        } catch (e) {
          (self as any).postMessage({ type: "error", id, message: "rdf-parse.parse threw: " + String(e), stack: e && e.stack ? String(e.stack) : undefined, ts: Date.now() });
          throw e;
        }

        if (!quadStream || typeof quadStream.on !== "function") {
          throw new Error("rdf-parse returned non-stream value");
        }

        // Collector buffer
        const buffer: any[] = [];
        let seenPrefixes: any = {};
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
            try {
              (self as any).postMessage({ type: "quads", id, quads: plain, final: false });
            } catch (e) {
              // If postMessage fails capture the error and continue
              (self as any).postMessage({ type: "debug", id, phase: "post.quads.failed", ts: Date.now(), message: String(e) });
            }
            await waitForAck(id);
          }
        });

        quadStream.on("prefix", (p: string, iri: any) => {
          seenPrefixes = seenPrefixes || {};
          seenPrefixes[p] = iri;
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
          (self as any).postMessage({ type: "error", id, message: String(err), stack: err && err.stack ? String(err.stack) : undefined });
        });

        // Successfully handed off to rdf-parse in-worker
        return;
      }
    }
  } catch (err: any) {
    // dynamic import or runtime error: report and fall back to N3
    try {
      (self as any).postMessage({ type: "error", id, message: "Worker rdf-parse error: " + String(err), stack: err && err.stack ? String(err.stack) : undefined, ts: Date.now() });
    } catch (_) { /* noop */ }
  }

  // N3 fallback (Turtle only)
  try {
    try {
      (self as any).postMessage({ type: "debug", id, phase: "n3.import.start", ts: Date.now() });
    } catch (_) { /* noop */ }
    const N3 = await import("n3");
    try {
      (self as any).postMessage({ type: "debug", id, phase: "n3.import.done", ts: Date.now(), keys: N3 && typeof N3 === "object" ? Object.keys(N3).slice(0, 20) : typeof N3 });
    } catch (_) { /* noop */ }

    if (!N3 || typeof N3.Parser !== "function") {
      (self as any).postMessage({ type: "error", id, message: "Worker: no N3 parser available", ts: Date.now() });
      return;
    }
    const Parser = N3.Parser;
    const p = new Parser();
    const collected: any[] = [];
    let parsedPrefixes: any = null;

    p.parse(text, (err: any, quad: any, prefixes: any) => {
      if (err) {
        (self as any).postMessage({ type: "error", id, message: String(err), stack: err && err.stack ? String(err.stack) : undefined });
        return;
      }
      if (quad) collected.push(quad);
      else if (prefixes && typeof prefixes === "object") parsedPrefixes = prefixes;
    });

    if (parsedPrefixes) {
      (self as any).postMessage({ type: "prefix", id, prefixes: parsedPrefixes });
    }

    for (let i = 0; i < collected.length; i += BATCH_SIZE) {
      if (cancelled.has(id)) break;
      const batch = collected.slice(i, i + BATCH_SIZE);
      const isLast = i + BATCH_SIZE >= collected.length;
      const plain = batch.map((q: any) => ({
        s: String(q.subject && q.subject.value ? q.subject.value : q.subject),
        p: String(q.predicate && q.predicate.value ? q.predicate.value : q.predicate),
        o: plainFromTerm(q.object),
        g: q.graph && q.graph.value ? String(q.graph.value) : undefined,
      })) as PlainQuad[];
      (self as any).postMessage({ type: "quads", id, quads: plain, final: isLast });
      await waitForAck(id);
    }

    (self as any).postMessage({ type: "end", id });
    return;
  } catch (err: any) {
    try {
      (self as any).postMessage({ type: "error", id, message: "Worker parse failed: " + String(err), stack: err && err.stack ? String(err.stack) : undefined, ts: Date.now() });
    } catch (_) { /* noop */ }
    return;
  }
}
