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

export async function doFetch(target: string, timeout: number, opts?: { minimal?: boolean }): Promise<Response | null> {
  const minimal = !!(opts && opts.minimal);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const init: RequestInit = {
      signal: controller.signal,
      redirect: "follow",
    };

    if (!minimal) {
      init.headers = {
        // Conservative Accept header that covers Turtle, RDF/XML, JSON-LD and fallbacks.
        Accept: "text/turtle, application/rdf+xml, application/ld+json, */*",
      } as any;
    }

    const res = await fetch(target, init);
    return res;
  } finally {
    clearTimeout(timeoutId);
  }
}
