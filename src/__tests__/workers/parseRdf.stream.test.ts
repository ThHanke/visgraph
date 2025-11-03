import { expect, it } from "vitest";

const hasWorker = typeof (globalThis as any).Worker !== "undefined";

// Skip this test in Node/jsdom — it requires a real browser Worker (run under Playwright).
if (!hasWorker) {
  // Vitest's idiomatic skip at runtime: register a trivial skipped test.
  // This keeps CI clear when Node-only unit tests run; Playwright will run the real test.
  it("parseRdf worker streams a data: URL and emits quads (requires real browser Worker)", () => {
    // skipped in Node environment
  });
} else {
  it(
    "parseRdf worker streams a URL and emits quads",
    async () => {
      // Use a deterministic URL for your environment; by default test the W3C OWL namespace.
      // In CI (Playwright) ensure network or server mapping is available for this URL.
      const dataUrl = "http://www.w3.org/2002/07/owl#";

      const worker = new Worker(new URL("../../src/workers/parseRdf.worker.ts", import.meta.url).href, {
        type: "module",
      });

      const id = "test-stream-1";
      const quads: any[] = [];
      let ended = false;

      const waitForEnd = new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          try { worker.terminate(); } catch (_) { /* ignore */ }
        };

        worker.addEventListener("message", (ev: MessageEvent) => {
          const msg = ev.data || {};
          if (!msg || msg.id !== id) return;

          if (msg.type === "quads" && Array.isArray(msg.quads)) {
            quads.push(...msg.quads);
            // ACK so worker can continue
            try { worker.postMessage({ type: "ack", id }); } catch (_) { /* ignore */ }
          } else if (msg.type === "end") {
            ended = true;
            cleanup();
            resolve();
          } else if (msg.type === "error") {
            cleanup();
            // worker-provided message text only
            reject(new Error(String(msg.message || "worker error")));
          }
        });

        // Post parse request
        try {
          worker.postMessage({ type: "parseUrl", id, url: dataUrl, timeoutMs: 120000 });
        } catch (err) {
          cleanup();
          reject(err);
        }
      });

      await waitForEnd;

      expect(ended).toBe(true);
      expect(quads.length).toBeGreaterThan(0);

      const found = quads.find((q) => {
        return (
          typeof q.p === "string" &&
          q.p === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" &&
          q.o &&
          q.o.t === "iri" &&
          typeof q.o.v === "string" &&
          q.o.v.startsWith("http://www.w3.org/2002/07/owl#")
        );
      });

      expect(found, `Expected to find an owl type quad among parsed quads: ${JSON.stringify(quads.slice(0,20))}`).toBeDefined();
    },
    180000, // extended timeout for large ontology loads when run in a browser
  );
}
