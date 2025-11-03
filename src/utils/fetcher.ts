/**
 * doFetch - main-thread fetch wrapper with timeout and sensible Accept header.
 *
 * Replaces the previous worker-first implementation with a simple window.fetch-based
 * implementation to avoid bundling/worker resolution issues in production preview.
 *
 * Signature:
 *   doFetch(target: string, timeout: number, opts?: { minimal?: boolean, useWorker?: boolean })
 *
 * Returns a WHATWG Response (or a compatible object) so callers that consume
 * response.body / response.text() continue to work unchanged.
 *
 * Behavior:
 * - Uses global fetch if available.
 * - Uses AbortController to enforce timeout.
 * - Honors opts.minimal to reduce Accept header when requested.
 * - On network failure in development, attempts a dev-server proxy fallback at /__external?url=...
 *   so the dev server can proxy remote resources and avoid CORS issues.
 */
export async function doFetch(target: string, timeout: number, opts?: { minimal?: boolean; useWorker?: boolean }): Promise<any> {
  if (!target) throw new Error("doFetch requires a target URL");

  const timeoutMs = typeof timeout === "number" ? timeout : 15000;
  const minimal = !!(opts && opts.minimal);

  // Prefer global fetch (browser or node-with-global-fetch)
  const fetchFn = typeof fetch === "function" ? fetch : (globalThis as any).fetch;

  if (typeof fetchFn !== "function") {
    throw new Error("Global fetch is not available in this runtime");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    try {
      const res = await fetchFn(target, {
        signal: controller.signal,
        redirect: "follow",
        headers: minimal
          ? { Accept: "*/*" }
          : { Accept: "text/turtle, application/rdf+xml, application/ld+json, */*" },
      });
      return res;
    } catch (err) {
      // If fetch failed and we're in a development browser session, try the dev proxy endpoint.
      // This helps with CORS or dev-server proxy/transit issues.
      try {
        const isBrowser = typeof window !== "undefined";
        const isDev =
          (typeof (import.meta as any) !== "undefined" &&
            !!((import.meta as any).env && (import.meta as any).env.DEV)) ||
          (isBrowser && (window as any).__VITE_DEV_SERVER !== undefined) ||
          (process && process.env && process.env.NODE_ENV === "development");

        if (isBrowser && isDev) {
          try {
            // Clear previous timeout and create a fresh controller for the proxy attempt.
            clearTimeout(timer);
            const proxyController = new AbortController();
            const proxyTimer = setTimeout(() => proxyController.abort(), timeoutMs);

            // Build proxy URL relative to current origin so dev server handles it.
            const proxyUrl = `/__external?url=${encodeURIComponent(String(target))}`;

            try {
              const pres = await fetchFn(proxyUrl, {
                signal: proxyController.signal,
                redirect: "follow",
                headers: minimal
                  ? { Accept: "*/*" }
                  : { Accept: "text/turtle, application/rdf+xml, application/ld+json, */*" },
              });
              clearTimeout(proxyTimer);
              return pres;
            } finally {
              clearTimeout(proxyTimer);
            }
          } catch (proxyErr) {
            // swallow and rethrow original error below
          }
        }
      } catch (_) {
        // ignore detection errors
      }
      // rethrow original fetch error
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}
