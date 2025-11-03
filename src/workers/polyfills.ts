// Minimal, worker-scoped polyfills inlined so production worker chunks do not rely
// on external package specifiers at runtime. Keep these intentionally small and
// browser-only (no Node APIs besides a tiny Buffer shim and process.env).
//
// The goal: guarantee worker bundles contain the shims they need without
// depending on cross-chunk resolution or build-time plugin ordering.

(function () {
  // Minimal process shim
  if (typeof (globalThis as any).process === "undefined") {
    (globalThis as any).process = {
      env: { NODE_ENV: (typeof process !== "undefined" && (process as any).env && (process as any).env.NODE_ENV) || "production" },
      browser: true,
      // minimal stubs that some libs check for
      nextTick: (fn: (...args: any[]) => void) => Promise.resolve().then(() => fn()),
      cwd: () => "/",
      // simple versions object
      versions: {},
    };
  }

  // Minimal Buffer shim based on Uint8Array.
  // This covers basic Buffer.from(string) and Buffer.from(array) uses,
  // and toString('utf8') calls that are used in this project.
  if (typeof (globalThis as any).Buffer === "undefined") {
    class BufferShim extends Uint8Array {
      static from(input: any, encoding?: string) {
        if (typeof input === "string") {
          // support only utf-8 strings which is sufficient for our needs
          const enc = new TextEncoder();
          return new BufferShim(enc.encode(input));
        } else if (Array.isArray(input) || ArrayBuffer.isView(input)) {
          return new BufferShim(input);
        } else if (input instanceof ArrayBuffer) {
          return new BufferShim(new Uint8Array(input));
        } else if (input && (input.buffer || input.length)) {
          return new BufferShim(input);
        }
        return new BufferShim([]);
      }

      static alloc(size: number) {
        return new BufferShim(new Uint8Array(size));
      }

      toString(encoding?: string) {
        // only implement utf8/utf-8 fallback
        try {
          const dec = new TextDecoder(encoding === "utf8" || encoding === "utf-8" || !encoding ? "utf-8" : encoding);
          return dec.decode(this);
        } catch (e) {
          // fallback: join bytes as latin1
          return Array.prototype.map.call(this, (b: number) => String.fromCharCode(b)).join("");
        }
      }
    }

    (globalThis as any).Buffer = BufferShim;
  }

  // Small helper: if a library expects `globalThis.process.browser` or checks process.env,
  // ensure the values exist and are minimal.
  try {
    (globalThis as any).process.browser = true;
  } catch (e) {
    // ignore
  }

  // Note: we intentionally do NOT try to implement full `readable-stream` here.
  // The worker code uses Readable.from(...) to convert WHATWG ReadableStream to a
  // Node-style stream. In many environments rdf-parse accepts async iterables or
  // the reduced Buffer + readable-like input. If further runtime errors show up
  // for stream behavior, we'll add a focused shim for Readable.from that converts
  // a WHATWG ReadableStream into a very small event-emitter compatible object.
})();
