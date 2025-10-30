/**
 * Centralized fetch helper for RDF/network requests.
 *
 * Exports doFetch(target, timeout, opts) which:
 *  - Uses AbortController to enforce a timeout
 *  - Sends a conservative Accept header by default (suitable for RDF endpoints)
 *  - Supports a `minimal` option to perform a truly minimal fetch() with no custom headers
 *    (useful to avoid browser CORS preflight in some environments).
 *
 * Keep this file small and dependency-free so it can be reused from both rdfManager
 * and other places where a standardized fetch behaviour is desired.
 */

export async function doFetch(target: string, timeout: number, opts?: { minimal?: boolean }): Promise<any /* Promise resolves to a Response-like object */> {
  // New implementation: delegate fetching to fetchStream.fetchText so we centralize
  // timeout and streaming behavior. We return a minimal Response-like object that
  // provides `.ok`, `.status`, `.statusText`, `.headers.get()` and `.text()`.
  // This keeps existing callers that expect a Response-compatible shape working
  // while using the unified fetch/stream helper.
  const minimal = !!(opts && opts.minimal);
  const fetchStreamModule = await import("./fetchStream").catch(() => ({ fetchText: undefined as any }));
  const fetchTextFn = fetchStreamModule && fetchStreamModule.fetchText ? fetchStreamModule.fetchText : undefined;

  if (typeof fetchTextFn !== "function") {
    // Fallback to native fetch when helper unavailable
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const init: RequestInit = {
        signal: controller.signal,
        redirect: "follow",
      };
      if (!minimal) {
        init.headers = {
          Accept: "text/turtle, application/rdf+xml, application/ld+json, */*",
        } as any;
      }
      const res = await fetch(target, init);
      return res;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Use fetchText helper which returns { text, contentType, status, statusText }
  const timeoutMs = Number(timeout || 15000);
  try {
    const result = await fetchTextFn(String(target), { timeoutMs, accept: !minimal ? undefined : "*/*" });
    const ok = typeof result.status === "number" ? result.status >= 200 && result.status < 300 : true;
    const contentType = result.contentType || null;
    // Build a minimal Response-like object
    const fakeResponse: any = {
      ok,
      status: result.status || 200,
      statusText: result.statusText || "",
      headers: {
        get: (k: string) => {
          if (!k) return null;
          if (k.toLowerCase() === "content-type") return contentType;
          return null;
        },
      },
      // provide text() for compatibility; some callers may use body.getReader but
      // responseToText will call text() when body is not available.
      text: async () => {
        return result.text || "";
      },
      // keep the raw parsed text for advanced callers (not standard Response)
      _vg_text: result.text,
    };
    return fakeResponse;
  } catch (err) {
    // Surface the error so callers can log/handle it (do not swallow).
    throw err;
  }
}
