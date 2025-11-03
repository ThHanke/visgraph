import React from "react";
import { useCanvasState } from "../../hooks/useCanvasState";

/**
 * ModalStatus
 *
 * Responsive bottom status area that aligns with the global Toaster and the
 * ReasoningIndicator. On desktop it's presented inline (row) with the other
 * widgets; on mobile it's stacked vertically: Toaster -> Progress -> Reasoning.
 *
 * The outer container is pointer-events-none so it doesn't block canvas interaction;
 * inner elements use pointer-events-auto to remain interactive.
 */

const ModalStatus: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const { state } = useCanvasState();
  const isLoading = !!(state && state.isLoading);
  const loadingMessage = (state && state.loadingMessage) || "";
  const loadingProgress =
    typeof (state && (state as any).loadingProgress) === "number"
      ? (state as any).loadingProgress
      : null;

  // Always render the status row so the three-column layout (left/center/right)
  // remains stable. Only show the progress widget when loading; the right column
  // (reasoning indicator) is rendered as a child and should always be present.

  return (
    // Full-width fixed container so Toaster (global) and our widgets share alignment.
    <div
      className="fixed bottom-0  left-0 right-0 z-[9998] pointer-events-none"
      aria-hidden={!isLoading}
    >
      <div className="mx-auto px-4 py-2">
        {/* Responsive stack: column on small screens, row on medium+ */}
        <div className="flex flex-col sm:flex-col md:flex-row items-center md:justify-between justify-center gap-3 pointer-events-auto">
          {/* Toaster placeholder will be rendered by global toaster; keep a spacer slot so visual alignment matches */}
          {/* Mobile order: toaster (top), progress, reasoning
              Desktop order: progress (left), toaster (center), reasoning (right) */}
          <div className="order-1 md:order-2 w-full md:w-1/3 px-0 flex justify-center md:justify-center pointer-events-auto">
            {/* Intentionally empty: Sonner/Toaster is global; this slot preserves alignment/spacing */}
          </div>

          {/* Progress widget (left on desktop, middle on mobile) */}
          <div className="order-2 md:order-1 w-full md:w-1/3 flex justify-start md:justify-start pointer-events-auto">
            {isLoading ? (
              <div className="bg-card/95 text-foreground px-1 py-1 rounded-lg shadow-lg flex items-center gap-2 max-w-full w-full overflow-hidden">
                <div className="w-3 h-3 border-2 border-t-2 border-t-primary rounded-full animate-spin shrink-0" />
                <div className="flex flex-col min-w-0 overflow-hidden">
                  <div className="text-sm font-medium truncate">
                    {loadingMessage || "Working..."}
                  </div>
                  {loadingProgress !== null ? (
                    <div className="text-xs text-muted-foreground truncate">
                      {loadingProgress}%
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              // Preserve the column footprint when not loading so center/right remain aligned
              <div className="w-full h-0" aria-hidden />
            )}
          </div>

          {/* Reasoning indicator slot (right on desktop, bottom on mobile) */}
          <div className="order-3 md:order-3 w-full md:w-1/3 flex justify-center md:justify-end pointer-events-auto">
            <div className="h-full flex items-center">
              {children ? (
                children
              ) : (
                <div className="hidden md:inline-block w-0" aria-hidden />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModalStatus;
