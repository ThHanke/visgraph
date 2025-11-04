/**
 * viewportUtils.ts
 *
 * Shared helpers for projecting client/page coordinates into React Flow (canvas) coordinates.
 * These implementations mirror the robust fallbacks used in ObjectPropertyEdge and KnowledgeCanvas.
 *
 * Usage:
 *  import { projectClient } from './core/viewportUtils';
 *  const p = projectClient(clientX, clientY);
 *  // p: { x: number, y: number }
 */

export function projectClient(clientX: number, clientY: number) {
  try {
    // Prefer the stored global React Flow instance if present (tests / global helpers expose this)
    const inst = (window as any).__VG_RF_INSTANCE;
    if (inst && typeof inst.project === "function") {
      try {
        const p = inst.project({ x: clientX, y: clientY } as any);
        if (p && typeof p.x === "number" && typeof p.y === "number") return p;
      } catch (_) {
        // fallthrough to other strategies
      }
    }
  } catch (_) {
    // ignore
  }

  try {
    // Heuristic fallback: use the viewport element transform when available.
    const viewport = document.querySelector(".react-flow__viewport") as HTMLElement | null;
    const containerRect = viewport ? viewport.getBoundingClientRect() : document.body.getBoundingClientRect();
    const x = clientX - containerRect.left;
    const y = clientY - containerRect.top;

    // viewport.style.transform usually looks like: "translate(tx px, ty px) scale(s)"
    const style = viewport ? viewport.style.transform : "";
    const match = /translate\\((-?\\d+\\.?\\d*)px,\\s*(-?\\d+\\.?\\d*)px\\) scale\\((-?\\d+\\.?\\d*)\\)/.exec(style);
    if (match) {
      const txf = Number(match[1]) || 0;
      const tyf = Number(match[2]) || 0;
      const sc = Number(match[3]) || 1;
      return { x: (x - txf) / sc, y: (y - tyf) / sc };
    }

    return { x, y };
  } catch (_) {
    // Last resort: return client coords as-is
    return { x: clientX, y: clientY };
  }
}
