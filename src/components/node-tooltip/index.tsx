import React from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";

/**
 * NodeTooltip
 *
 * Small local implementation that follows the React Flow NodeTooltip pattern:
 * - NodeTooltip is a simple wrapper.
 * - NodeTooltipTrigger should wrap the node UI (use asChild to avoid extra DOM).
 * - NodeTooltipContent renders the hover tooltip content.
 *
 * This component uses the app's Tooltip primitive (Radix wrapper) so it behaves
 * like the React Flow UI tooltip (hover-triggered) and won't block underlying pointer
 * events for dragging.
 *
 * Usage:
 *  <NodeTooltip>
 *    <NodeTooltipContent>...tooltip body...</NodeTooltipContent>
 *    <NodeTooltipTrigger asChild>
 *      <div>node body</div>
 *    </NodeTooltipTrigger>
 *  </NodeTooltip>
 *
 * We intentionally keep naming compatible with the docs so migration is straightforward.
 */

export const NodeTooltip: React.FC<React.PropsWithChildren<Record<string, unknown>>> = ({ children }) => {
  // Wrap children in the app Tooltip Root and set a small hover delay so the
  // tooltip doesn't open immediately on mousedown/quick hover and interfere with drag.
  // We use 250ms which is long enough to avoid accidental opens during drag starts
  // but still provides responsive hover tooltips.
  return <Tooltip delayDuration={250}>{children}</Tooltip>;
};

/**
 * NodeTooltipTrigger
 *
 * Wraps the Radix TooltipTrigger but forces asChild so the passed child element
 * is used as the trigger (no extra wrapper DOM). This avoids creating an extra
 * element that could intercept pointer events and block React Flow's native drag.
 */
export const NodeTooltipTrigger: React.FC<any> = ({ children, ...props }) => {
  return (
    <TooltipTrigger asChild {...props}>
      {children}
    </TooltipTrigger>
  );
};

export const NodeTooltipContent = TooltipContent;

export default NodeTooltip;
