/**
 * @fileoverview Canvas state management hook (global store)
 *
 * This implementation provides a tiny shared store so multiple components
 * can observe the same canvas state (e.g. KnowledgeCanvas, ModalStatus, Toolbar).
 *
 * It exposes:
 * - useCanvasState(): React hook returning { state, actions }
 * - getCanvasState(): read-only snapshot accessor for imperative callers/tests
 *
 * The implementation uses a simple module-level state object and a subscriber
 * list. When actions update the state we notify subscribers so hooks re-render.
 *
 * This is intentionally small and dependency-free (no external store lib).
 */

import { useEffect, useState, useCallback } from "react";
import { CanvasState, CanvasActions } from "../types/canvas";

/* Module-level shared state */
let internalState: CanvasState = {
  viewMode: "abox",
  showLegend: false,
  isLoading: false,
  loadingProgress: 0,
  loadingMessage: "",
  showReasoningReport: false,
};

/* Subscribers notified on state change */
const subscribers = new Set<() => void>();

/* Notify helper */
function notifySubscribers() {
  for (const cb of Array.from(subscribers)) {
    try {
      cb();
    } catch (_) {
      // ignore subscriber errors
    }
  }
}

/* State mutators (actions) that update internalState and notify */
const actionsImpl: CanvasActions = {
  setViewMode: (m: "abox" | "tbox") => {
    internalState = { ...internalState, viewMode: m };
    notifySubscribers();
  },
  toggleLegend: () => {
    internalState = { ...internalState, showLegend: !internalState.showLegend };
    notifySubscribers();
  },
  setLoading: (loading: boolean, progress = 0, message = "") => {
    try {
      // Lightweight debug output so runtime can confirm callers are toggling the shared loading state.
      // This should be safe in production but is gated by console.debug availability.
      if (typeof console !== "undefined" && typeof console.debug === "function") {
        console.debug("[VG_DEBUG] useCanvasState.setLoading", {
          loading: Boolean(loading),
          progress: Number(progress) || 0,
          message: String(message || ""),
          ts: Date.now(),
        });
      }
      // Also expose a global last-loading snapshot for inspection via devtools.
      try {
        (globalThis as any).__VG_LAST_CANVAS_LOADING = {
          loading: Boolean(loading),
          progress: Number(progress) || 0,
          message: String(message || ""),
          ts: Date.now(),
        };
      } catch (_) {
        // ignore globals failing in some environments
      }
    } catch (_) {
      // ignore logging failures
    }

    internalState = {
      ...internalState,
      isLoading: Boolean(loading),
      loadingProgress: Number(progress) || 0,
      loadingMessage: String(message || ""),
    };
    notifySubscribers();
  },
  toggleReasoningReport: (show: boolean) => {
    internalState = { ...internalState, showReasoningReport: Boolean(show) };
    notifySubscribers();
  },
};

/* Exported hook used by components to read state + dispatch actions */
export const useCanvasState = (): { state: CanvasState; actions: CanvasActions } => {
  // Local state only used to trigger re-render when the shared store changes.
  const [, setTick] = useState(0);

  useEffect(() => {
    const subscriber = () => setTick((t) => t + 1);
    subscribers.add(subscriber);
    // Ensure the subscriber is removed on unmount.
    return () => {
      subscribers.delete(subscriber);
    };
  }, []);

  // Return the live snapshot and actions.
  // Use useCallback to provide stable reference for actions (helps memoization consumers).
  const stableActions = useCallback(() => actionsImpl, [])() as CanvasActions;
  return { state: internalState, actions: stableActions };
};

/* Imperative accessor for tests or non-react code */
export const getCanvasState = (): CanvasState => {
  return internalState;
};

export type UseCanvasStateReturn = ReturnType<typeof useCanvasState>;
