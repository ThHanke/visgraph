import mapQuadsToDiagram from '../components/Canvas/core/mappingHelpers';

self.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'map') return;
  const id = msg.id;
  try {
    const quads = Array.isArray(msg.quads) ? msg.quads : [];
    const result = mapQuadsToDiagram(quads, msg.opts || {});
    try {
      (self as any).postMessage({ id, result });
    } catch (e) {
      // best-effort: if postMessage fails, swallow to avoid worker crash
    }
  } catch (err) {
    try {
      (self as any).postMessage({ id, error: String(err) });
    } catch (_) { /* ignore */ }
  }
});
