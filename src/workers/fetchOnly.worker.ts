// Minimal worker that performs a fetch and streams ArrayBuffer chunks back to the main thread.
// Protocol:
//  - main -> worker: { type: 'fetchUrl', id: string, url: string, timeoutMs?: number }
//  - worker -> main:
//      { type: 'start', id, contentType?: string, status?: number, statusText?: string }
//      { type: 'chunk', id, buffer: ArrayBuffer }  // transferable
//      { type: 'end', id }
//      { type: 'error', id, message }
//
// Keep the worker small and robust (no external deps).
self.addEventListener('message', async (ev: MessageEvent) => {
  const msg = ev.data || {};
  if (!msg || msg.type !== 'fetchUrl') return;
  const id = msg.id || String(Math.random()).slice(2, 8);
  const url = String(msg.url || '');
  const timeoutMs = typeof msg.timeoutMs === 'number' ? Number(msg.timeoutMs) : 15000;

    try {
      const controller = new AbortController();
      const to = setTimeout(() => {
        try { controller.abort(); } catch (_) { void 0; }
      }, timeoutMs);

    // Build fetch init with headers: prefer headers supplied by the caller message,
    // fall back to a conservative Accept header that prefers Turtle (fastest to parse).
    const defaultAccept = "text/turtle, application/rdf+xml, application/ld+json, */*";
    const msgHeaders = msg && msg.headers && typeof msg.headers === "object" ? msg.headers : undefined;
    const fetchInit: any = {
      signal: controller.signal,
      redirect: "follow",
      headers: msgHeaders || { Accept: defaultAccept },
    };

    let res: Response | null = null;
    try {
      res = await fetch(url, fetchInit);
    } finally {
      clearTimeout(to);
    }

    if (!res) {
      (self as any).postMessage({ type: 'error', id, message: 'No response' });
      return;
    }

    // Inform main thread about status/content-type quickly
    let contentType: string | null = null;
    try {
      contentType =
        res.headers && typeof res.headers.get === 'function'
          ? res.headers.get('content-type')
          : null;
    } catch (_) {
      contentType = null;
    }

    (self as any).postMessage({
      type: 'start',
      id,
      contentType,
      status: (res && (res as any).status) || 200,
      statusText: (res && (res as any).statusText) || '',
    });

    // If streaming body not available, fallback to reading as ArrayBuffer and send once.
    const body = (res as any).body;
    if (!body || typeof body.getReader !== 'function') {
      try {
        const ab = await res.arrayBuffer();
        (self as any).postMessage({ type: 'chunk', id, buffer: ab }, [ab]);
        (self as any).postMessage({ type: 'end', id });
        return;
      } catch (err) {
        (self as any).postMessage({ type: 'error', id, message: String(err) });
        return;
      }
    }

    // Read streaming chunks and transfer them to main thread as they arrive
    const reader = body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          // Ensure we send an ArrayBuffer (transferable)
          let buf: ArrayBuffer;
          if (value instanceof ArrayBuffer) {
            buf = value;
          } else if (ArrayBuffer.isView(value)) {
            // Uint8Array or similar
            buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
          } else {
            // Fallback - try to coerce
            const tmp = new Uint8Array(value);
            buf = tmp.buffer.slice(tmp.byteOffset, tmp.byteOffset + tmp.byteLength);
          }
          try {
            (self as any).postMessage({ type: 'chunk', id, buffer: buf }, [buf]);
          } catch (postErr) {
            // If transfer fails, send without transfer (less efficient)
            (self as any).postMessage({ type: 'chunk', id, buffer: buf });
          }
        }
      }
      (self as any).postMessage({ type: 'end', id });
      } catch (readErr) {
      (self as any).postMessage({ type: 'error', id, message: String(readErr) });
    } finally {
      try {
        if (reader && typeof reader.releaseLock === 'function') reader.releaseLock();
      } catch (_) { void 0; }
    }
  } catch (err) {
    (self as any).postMessage({ type: 'error', id, message: String(err) });
  }
});
