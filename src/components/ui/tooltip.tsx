import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

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

const TooltipProvider = TooltipPrimitive.Provider

const Tooltip = TooltipPrimitive.Root

const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, children, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      "vg-tooltip-content z-50 inline-block pointer-events-none max-w-[90vw] rounded-md border bg-popover shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
      className
    )}
    {...props}
  >
    <div className="pointer-events-none px-3 py-1.5 text-sm text-popover-foreground">
      {children}
    </div>
  </TooltipPrimitive.Content>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
