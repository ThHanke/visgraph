// Deprecated fetch-only worker stub.
// This worker used to fetch and forward content for parsing. The project now
// uses a single canonical parseRdf.worker.ts which performs fetch+parse inside
// the browser worker. Keep this stub so any accidental imports get a clear,
// non-destructive error rather than a silent fallback path.
//
// Behavior:
// - If main thread posts a "parseUrl" message to this worker it will immediately
//   post back a single "error" message stating the worker is deprecated.
// - This file can be safely deleted later once all callers are cleaned up.
self.addEventListener("message", (ev: MessageEvent) => {
  try {
    const msg = ev && ev.data ? ev.data : {};
    const id = msg && msg.id ? String(msg.id) : "deprecated";
    try {
      (self as any).postMessage({
        type: "error",
        id,
        message:
          "fetchOnly.worker is deprecated. Use src/workers/parseRdf.worker.ts which performs fetch+parse in a single browser worker.",
      });
    } catch (postErr) {
      try { console.error("[FETCHONLY_STUB] failed to postMessage", String(postErr)); } catch (_) {}
    }
  } catch (_) {
    try { console.error("[FETCHONLY_STUB] unexpected message handling error"); } catch (_) {}
  }
});
