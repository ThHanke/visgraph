import React from "react";

/**
 * ModalStatus
 *
 * Simplified bottom status container for the ReasoningIndicator.
 * Progress notifications are now handled by the Sonner toast system,
 * so this component only needs to position the reasoning indicator.
 *
 * The outer container is pointer-events-none so it doesn't block canvas interaction;
 * inner elements use pointer-events-auto to remain interactive.
 */

const ModalStatus: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  return (
    // Fixed container positioned at bottom-right for reasoning indicator
    <div
      className="fixed bottom-0 right-0 z-[9998] pointer-events-none"
    >
      <div className="px-4 py-2 pointer-events-auto">
        {children}
      </div>
    </div>
  );
};

export default ModalStatus;
