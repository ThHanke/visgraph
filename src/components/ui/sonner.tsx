/* eslint-disable react-refresh/only-export-components */
import { useTheme } from "next-themes"
import { Toaster as Sonner } from "sonner"
import { toast } from "./helpers/sonnerHelpers"

type ToasterProps = React.ComponentProps<typeof Sonner>

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

    return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      // Move to bottom-right and ensure pointer events are enabled for interactions.
      // Use a high z-index to avoid being occluded by other UI layers.
      className="toaster group fixed bottom-4 right-4 z-[9999] pointer-events-auto"
      toastOptions={{
        // Keep visual theming via classNames and increase default visibility time.
        duration: 8000,
        // Provide a small default action button styling surface and a visible close button.
        classNames: {
          // align vertical gap and min height to match ReasoningIndicator / run button
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg px-3 py-2 min-h-[40px] flex items-center gap-3",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground px-2 py-1 rounded",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground px-2 py-1 rounded",
        },
      }}
      {...props}
    />
  )
}

export { Toaster, toast }
