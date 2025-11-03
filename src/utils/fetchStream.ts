/**
 * DEPRECATED stub: fetchStream
 *
 * This file was previously used as a helper to stream fetch responses into strings
 * and to provide Node/browser Readable compatibility. The project now uses a
 * browser-worker-first parsing route and does not rely on this helper for RDF
 * URL loads.
 *
 * To keep imports safe while removing the legacy path, this stub provides a
 * minimal, non-blocking implementation that performs a plain fetch + text()
 * and emits a deprecation warning. Do not rely on streaming behavior from this
 * helper — prefer the worker-based parser route instead.
 */

export async function responseToText(
  response: Response,
  onProgress?: (bytes: number) => void,
): Promise<string> {
  if (!response) throw new Error("responseToText requires a Response");
  try {
    if (typeof console !== "undefined") {
      console.warn("[DEPRECATED] src/utils/fetchStream.responseToText used - use worker-based parsing instead");
    }
  } catch (_) {}
  // Fallback: return full text (no streaming/progress)
  const txt = await response.text();
  if (typeof onProgress === "function") {
    try { onProgress(txt.length); } catch (_) { /* ignore */ }
  }
  return txt;
}

export async function fetchText(
  url: string,
  opts?: { timeoutMs?: number; accept?: string; onProgress?: (bytes: number) => void },
): Promise<{ text: string; contentType: string | null; status: number; statusText: string }> {
  if (!url) throw new Error("fetchText requires a URL");
  try {
    if (typeof console !== "undefined") {
      console.warn("[DEPRECATED] src/utils/fetchStream.fetchText used - use worker-based parsing instead");
    }
  } catch (_) {}
  const controller = new AbortController();
  const t = typeof opts?.timeoutMs === "number" ? opts!.timeoutMs : 15000;
  const timer = setTimeout(() => controller.abort(), t);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { Accept: opts?.accept || "text/turtle, application/rdf+xml, application/ld+json, */*" } });
    if (!res) throw new Error(`No response from ${url}`);
    const contentTypeHeader = (res.headers && typeof (res.headers as any).get === "function") ? (res.headers as any).get("content-type") : null;
    const text = await res.text();
    return { text, contentType: contentTypeHeader, status: res.status, statusText: res.statusText || "" };
  } finally {
    clearTimeout(timer);
  }
}
