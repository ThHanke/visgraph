import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"
import { useAppConfigStore } from "../../stores/appConfigStore";

/* Global pointer listeners: when the user presses pointer down anywhere we add
   the 'vg-pointer-down' class to documentElement. We use this in CSS to hide
   tooltip content during pointer interactions so tooltips don't steal mousedown
   events from React Flow nodes. Guard to install listeners only once. */
if (typeof window !== "undefined" && !(window as any).__vg_tooltip_listeners_installed) {
  const onDown = () => document.documentElement.classList.add("vg-pointer-down");
  const onUp = () => document.documentElement.classList.remove("vg-pointer-down");
  window.addEventListener("pointerdown", onDown, { capture: true });
  window.addEventListener("pointerup", onUp, { capture: true });
  (window as any).__vg_tooltip_listeners_installed = true;
}

/**
 * Expose the Radix Provider so the app can opt-in to full tooltip behavior
 * in browser environments. Tests and headless environments should be safe
 * without using the Provider.
 */
export const TooltipProvider = TooltipPrimitive.Provider;

/**
 * Minimal, safe Tooltip primitives used across the app and in tests.
 *
 * These intentionally do not rely on Radix context so rendering in headless /
 * test environments (where providers are not mounted) won't throw. In a full
 * browser runtime you may still wrap the app in TooltipProvider and use real
 * Radix primitives where desired.
 */

/* Tooltip: delegates to Radix when tooltips are enabled; otherwise passthrough.
   In test environments we avoid Radix usage by default to keep tests stable -
   tests can still explicitly enable tooltips by setting the config before
   importing UI components. */
export const Tooltip: React.FC<any> = ({ children, ...props }) => {
  const isTestEnv =
    typeof process !== "undefined" &&
    ((process.env && process.env.NODE_ENV === "test") ||
      (typeof (import.meta as any) !== "undefined" && (import.meta as any).env && (import.meta as any).env.MODE === "test"));

  // Allow explicit opt-in for Radix-backed tooltips inside test runs via an env flag.
  // Set either VITEST_ALLOW_RADIX_TOOLTIPS=true or VITE_ALLOW_RADIX_TOOLTIPS=true when running tests.
  const allowRadixInTests =
    (typeof process !== "undefined" && process.env && process.env.VITEST_ALLOW_RADIX_TOOLTIPS === "true") ||
    (typeof (import.meta as any) !== "undefined" && (import.meta as any).env && (import.meta as any).env.VITE_ALLOW_RADIX_TOOLTIPS === "true");

  let tooltipEnabled = true;
  try {
    tooltipEnabled = !!useAppConfigStore.getState().config.tooltipEnabled;
  } catch (_) {
    tooltipEnabled = true;
  }

  // Ensure tooltips remain consistently available in the browser runtime to avoid
  // switching between controlled/uncontrolled tooltip usage when persisted config
  // toggles between renders. Respect test environments (headless) but in a real
  // browser prefer the richer Radix tooltip behavior.
  if (typeof window !== "undefined") {
    tooltipEnabled = true;
  }

  // Remove temporary diagnostic override: respect persisted setting again.
  // (This was temporarily forced true for debugging.)
  // tooltipEnabled = true;

  // debug logs removed

  // In test environment default to inert passthrough unless tests explicitly opt-in via env var
  if (isTestEnv && !allowRadixInTests) {
    return <>{children}</>;
  }

  if (tooltipEnabled && TooltipPrimitive && TooltipPrimitive.Root) {
    return <TooltipPrimitive.Root {...props}>{children}</TooltipPrimitive.Root>;
  }

  return <>{children}</>;
};

/* TooltipTrigger: use Radix Trigger when enabled, otherwise keep the safe passthrough.
   In test environments prefer passthrough unless explicitly enabled by tests via config. */
export const TooltipTrigger: React.FC<any> = ({ children, asChild, ...props }) => {
  const isTestEnv =
    typeof process !== "undefined" &&
    ((process.env && process.env.NODE_ENV === "test") ||
      (typeof (import.meta as any) !== "undefined" && (import.meta as any).env && (import.meta as any).env.MODE === "test"));

  const allowRadixInTests =
    (typeof process !== "undefined" && process.env && process.env.VITEST_ALLOW_RADIX_TOOLTIPS === "true") ||
    (typeof (import.meta as any) !== "undefined" && (import.meta as any).env && (import.meta as any).env.VITE_ALLOW_RADIX_TOOLTIPS === "true");

  let tooltipEnabled = true;
  try {
    tooltipEnabled = !!useAppConfigStore.getState().config.tooltipEnabled;
  } catch (_) {
    tooltipEnabled = true;
  }

  const enableRadix = tooltipEnabled && (!isTestEnv || allowRadixInTests);

  // debug logs removed

  if (enableRadix && TooltipPrimitive && TooltipPrimitive.Trigger) {
    return (
      <TooltipPrimitive.Trigger asChild={asChild} {...props}>
        {children}
      </TooltipPrimitive.Trigger>
    );
  }

  if (asChild && React.isValidElement(children)) {
    return React.cloneElement(children as any, { ...props });
  }
  return <>{children}</>;
};

/* TooltipContent: lightweight, scroll-friendly content container that stops
   wheel/touch events from bubbling to the underlying canvas. This avoids the
   Radix dependency and prevents runtime errors in tests. */
export const TooltipContent = React.forwardRef<HTMLDivElement, any>(({ className, children, sideOffset = 4, ...props }, ref) => {
  // Respect app configuration: when tooltips are globally disabled via config
  // return null so tests or users can opt-out.
  const isTestEnv =
    typeof process !== "undefined" &&
    ((process.env && process.env.NODE_ENV === "test") ||
      (typeof (import.meta as any) !== "undefined" && (import.meta as any).env && (import.meta as any).env.MODE === "test"));

  const allowRadixInTests =
    (typeof process !== "undefined" && process.env && process.env.VITEST_ALLOW_RADIX_TOOLTIPS === "true") ||
    (typeof (import.meta as any) !== "undefined" && (import.meta as any).env && (import.meta as any).env.VITE_ALLOW_RADIX_TOOLTIPS === "true");

  let tooltipEnabled = true;
  try {
    tooltipEnabled = !!useAppConfigStore.getState().config.tooltipEnabled;
  } catch (_) {
    tooltipEnabled = true;
  }

  // debug logs removed
  // (respect persisted tooltipEnabled)

  // If tests run in a test env and Radix isn't explicitly allowed, avoid Radix usage and fall back.
  if (isTestEnv && !allowRadixInTests) {
    const shouldForceRender = !!(props && (props.forceRender || props.open));
    if (!shouldForceRender) return null;
    // fall through to render the lightweight fallback DOM below
  } else {
    // If Radix is available and tooltips are enabled use Radix.Content so hover/open
    // behavior works as expected in the browser.
    if (tooltipEnabled && TooltipPrimitive && TooltipPrimitive.Content) {
      return (
        <TooltipPrimitive.Content
          sideOffset={sideOffset}
          {...props}
          ref={ref}
          className={cn(
            "vg-tooltip-content z-[9999] inline-block max-w-[90vw] rounded-md border bg-popover shadow-md outline-none",
            className,
          )}
        >
          <div
            className="pointer-events-auto touch-action-auto px-3 py-2 text-sm text-popover-foreground max-w-[32rem] max-h-64 overflow-auto whitespace-pre-wrap"
            onWheel={(e: React.WheelEvent) => {
              // Prevent wheel events from reaching the underlying canvas so tooltip can scroll independently
              e.stopPropagation();
            }}
            onTouchMove={(e: React.TouchEvent) => {
              // Allow touch scrolling inside the tooltip without bubbling to the canvas
              e.stopPropagation();
            }}
            style={{ WebkitOverflowScrolling: "touch" } as React.CSSProperties}
          >
            {children}
          </div>
        </TooltipPrimitive.Content>
      );
    }
    // Otherwise fall through to the lightweight fallback below
    const shouldForceRender = !!(props && (props.forceRender || props.open));
    if (!shouldForceRender) return null;
  }

  return (
    <div
      ref={ref}
      {...props}
      className={cn(
        "vg-tooltip-content absolute max-w-[90vw] rounded-md border bg-popover shadow-md outline-none",
        className,
      )}
      style={{ position: "absolute", marginTop: sideOffset } as React.CSSProperties}
    >
      <div
        className="pointer-events-auto touch-action-auto px-3 py-2 text-sm text-popover-foreground max-w-[32rem] max-h-64 overflow-auto whitespace-pre-wrap"
        onWheel={(e: React.WheelEvent) => {
          // Prevent wheel events from reaching the underlying canvas so tooltip can scroll independently
          e.stopPropagation();
        }}
        onTouchMove={(e: React.TouchEvent) => {
          // Allow touch scrolling inside the tooltip without bubbling to the canvas
          e.stopPropagation();
        }}
        style={{ WebkitOverflowScrolling: "touch" } as React.CSSProperties}
      >
        {children}
      </div>
    </div>
  );
});
TooltipContent.displayName = "TooltipContent";

export default Tooltip;
