/**
 * Simple fetch + response streaming helpers.
 *
 * - responseToText(response, onProgress?) streams a WHATWG Response.body to a string,
 *   invoking onProgress(cumulativeBytes) as data arrives. Throws on non-OK responses.
 * - fetchText(url, opts) convenience wrapper that performs a fetch with timeout and Accept header,
 *   then streams the response to text using responseToText.
 *
 * Keep implementation minimal and surface errors (do not swallow).
 */

export async function responseToText(
  response: Response,
  onProgress?: (bytes: number) => void,
): Promise<string> {
  if (!response) throw new Error("responseToText requires a Response");
  if (!response.body || typeof response.body.getReader !== "function") {
    // Fallback: use text() if stream not available
    return await response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let result = "";
  let done = false;
  let total = 0;

  try {
    while (!done) {
      const { value, done: d } = await reader.read();
      done = !!d;
      if (value && value.length) {
        total += value.length;
        result += decoder.decode(value, { stream: !done });
        if (typeof onProgress === "function") {
          try {
            onProgress(total);
          } catch (e) {
            // ignore onProgress failures
          }
        }
      }
    }
    // Final decode (some decoders require explicit final call)
    try {
      result += decoder.decode();
    } catch (_) {
      // ignore
    }
    return result;
  } finally {
    try {
      // close reader if possible
      if (reader && typeof reader.releaseLock === "function") reader.releaseLock();
    } catch (_) {
      // ignore
    }
  }
}

export async function fetchText(
  url: string,
  opts?: { timeoutMs?: number; accept?: string; onProgress?: (bytes: number) => void },
): Promise<{ text: string; contentType: string | null; status: number; statusText: string }> {
  if (!url) throw new Error("fetchText requires a URL");

  const timeoutMs = typeof opts?.timeoutMs === "number" ? opts!.timeoutMs : 15000;
  const acceptHeader = typeof opts?.accept === "string" ? opts!.accept : "text/turtle, application/rdf+xml, application/ld+json, */*";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: acceptHeader },
    });

    if (!res) throw new Error(`No response from ${url}`);
    if (!res.ok) {
      const status = res.status;
      const statusText = res.statusText || "";
      // Try to read body for better error diagnostics, but do not swallow if that fails.
      let bodySnippet = "";
      try {
        // Read small amount by streaming; fallback to text() when streaming unavailable.
        const txt = await responseToText(res, opts?.onProgress);
        bodySnippet = txt ? txt.slice(0, 2000) : "";
      } catch (err) {
        // ignore snippet read failures
      }
      throw new Error(`HTTP ${status} ${statusText} for ${url}${bodySnippet ? ` - ${bodySnippet.slice(0,200)}` : ""}`);
    }

    const contentTypeHeader = (res.headers && typeof res.headers.get === "function") ? res.headers.get("content-type") : null;
    const text = await responseToText(res, opts?.onProgress);
    return { text, contentType: contentTypeHeader, status: res.status, statusText: res.statusText || "" };
  } finally {
    clearTimeout(timer);
  }
}
