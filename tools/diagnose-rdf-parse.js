/**
 * Diagnostic: fetch a URL and attempt to parse it with rdf-parse in Node.
 * Prints events and errors to stdout so we can detect runtime issues (mediator, missing polyfills).
 *
 * Usage: node tools/diagnose-rdf-parse.js "<url>"
 */
(async () => {
  try {
    const url = process.argv[2] || "https://raw.githubusercontent.com/materialdigital/core-ontology/refs/heads/main/patterns/chemical%20composition/shape-data.ttl";
    console.log("Diagnostic fetch+parse starting for:", url);

    // Node global fetch should be available (Node >=18). If not, attempt dynamic import of node-fetch.
    let fetchFn = globalThis.fetch;
    if (typeof fetchFn !== "function") {
      try {
        const nf = await import("node-fetch").catch(() => null);
        fetchFn = nf && (nf.default || nf) ? (nf.default || nf) : undefined;
        if (typeof fetchFn !== "function") {
          console.error("No fetch available and node-fetch could not be imported. Install node >=18 or add node-fetch.");
          process.exit(2);
        }
      } catch (e) {
        console.error("No fetch available and node-fetch import failed. Install node >=18 or add node-fetch.", e);
        process.exit(2);
      }
    }

    const resp = await fetchFn(url);
    if (!resp || typeof resp.text !== "function") {
      console.error("Fetch did not return a valid response object");
      process.exit(3);
    }
    console.log("HTTP status:", resp.status, resp.statusText);
    const contentType = (resp.headers && typeof resp.headers.get === "function") ? resp.headers.get("content-type") : null;
    console.log("Content-Type header:", contentType);

    const text = await resp.text();
    console.log("Fetched length:", text.length);

    // Build a Node Readable stream from the text (ESM-friendly dynamic import)
    const streamMod = await import("stream").catch(() => null);
    const bufferMod = await import("buffer").catch(() => null);
    const Readable = streamMod && (streamMod.Readable || streamMod.default && streamMod.default.Readable) ? (streamMod.Readable || (streamMod.default && streamMod.default.Readable)) : undefined;
    const BufferImpl = bufferMod && (bufferMod.Buffer || (bufferMod.default && bufferMod.default.Buffer)) ? (bufferMod.Buffer || (bufferMod.default && bufferMod.default.Buffer)) : globalThis.Buffer;
    if (!Readable) {
      console.error("Readable stream constructor not available in this Node environment.");
      process.exit(3);
    }
    const stream = Readable.from([BufferImpl.from(text, "utf8")]);

    // Try to import rdf-parse using dynamic import (ESM-friendly)
    let rdfParseMod = null;
    try {
      rdfParseMod = await import("rdf-parse").catch(() => null);
      if (!rdfParseMod) {
        console.error("Failed to import rdf-parse via dynamic import. Ensure 'rdf-parse' is installed.");
        process.exit(4);
      }
    } catch (e) {
      console.error("Failed to import rdf-parse:", e);
      process.exit(4);
    }

    const rdfParser = rdfParseMod && (rdfParseMod.rdfParser || rdfParseMod.default || rdfParseMod.rdfParser) ? (rdfParseMod.rdfParser || rdfParseMod.default || rdfParseMod.rdfParser) : null;
    if (!rdfParser) {
      console.error("rdf-parse imported but rdfParser entry not found on module:", Object.keys(rdfParseMod || {}));
      process.exit(5);
    }

    console.log("Calling rdfParser.parse(...)");
    let quadStream;
    try {
      // rdfParser may be the module with parse method or a parser function; handle both shapes
      if (typeof rdfParser.parse === "function") {
        quadStream = rdfParser.parse(stream, { contentType: contentType || undefined, baseIRI: url });
      } else if (typeof rdfParser === "function") {
        quadStream = rdfParser(stream, { contentType: contentType || undefined, baseIRI: url });
      } else {
        throw new Error("rdfParser has no parse function and is not callable");
      }
    } catch (err) {
      console.error("rdfParser.parse threw synchronously:", err && err.stack ? err.stack : String(err));
      process.exit(6);
    }

    if (!quadStream || typeof quadStream.on !== "function") {
      console.error("rdfParser.parse did not return a stream-like object. value:", quadStream);
      process.exit(7);
    }

    let c = 0;
    quadStream.on("data", (q) => {
      c++;
      if (c <= 5) console.log("quad:", q && q.subject && q.subject.value ? String(q.subject.value) : q);
      if (c === 100) {
        console.log("Parsed 100 quads, stopping early.");
        try {
          if (typeof quadStream.pause === "function") quadStream.pause();
        } catch (_) {/* noop */}
      }
    });
    quadStream.on("prefix", (p, iri) => {
      console.log("prefix:", p, (iri && iri.value) || iri);
    });
    quadStream.on("context", (ctx) => {
      console.log("context event:", ctx && typeof ctx === "object" ? "(object)" : String(ctx));
    });
    quadStream.on("error", (err) => {
      console.error("quadStream error:", err && err.stack ? err.stack : String(err));
      process.exit(8);
    });
    quadStream.on("end", () => {
      console.log("quadStream end. total quads:", c);
      process.exit(0);
    });

    // Safety: timeout in case stream hangs
    setTimeout(() => {
      console.error("Diagnostic timed out after 30s");
      process.exit(9);
    }, 30000);
  } catch (err) {
    console.error("Unexpected diagnostic error:", err && err.stack ? err.stack : String(err));
    process.exit(99);
  }
})();
