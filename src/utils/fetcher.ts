/**
 * doFetch - main-thread fetch wrapper with timeout and sensible Accept header.
 *
 * Signature:
 *   doFetch(target, timeout, opts?)
 *
 * opts.corsProxyUrl — if provided and the direct fetch fails, retries the request
 *   through the proxy. The proxy URL is prepended to the encoded target URL, e.g.:
 *     https://corsproxy.io/?url=https%3A%2F%2Fpurl.org%2Fnet%2Fp-plan
 *   This is the standard format used by corsproxy.io and most self-hosted CORS proxies.
 *   Users configure this in app settings; no server-side code is required from us.
 */
export async function doFetch(
  target: string,
  timeout: number,
  opts?: { minimal?: boolean; useWorker?: boolean; corsProxyUrl?: string },
): Promise<any> {
  if (!target) throw new Error("doFetch requires a target URL");

  const timeoutMs = typeof timeout === "number" ? timeout : 15000;
  const minimal = !!(opts && opts.minimal);
  const corsProxyUrl = opts?.corsProxyUrl ?? "";

  const fetchFn = typeof fetch === "function" ? fetch : (globalThis as any).fetch;
  if (typeof fetchFn !== "function") {
    throw new Error("Global fetch is not available in this runtime");
  }

  const headers = minimal
    ? { Accept: "*/*" }
    : { Accept: "text/turtle, application/rdf+xml, application/ld+json, */*" };

  const withTimeout = async (url: string): Promise<any> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchFn(url, { signal: controller.signal, redirect: "follow", headers });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    return await withTimeout(target);
  } catch (err) {
    // On failure (typically CORS or a redirect whose destination lacks CORS headers),
    // retry through the user-configured proxy if one is set.
    if (corsProxyUrl) {
      const proxied = corsProxyUrl + encodeURIComponent(target);
      return await withTimeout(proxied);
    }
    throw err;
  }
}
