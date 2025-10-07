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
      className="toaster group fixed bottom-4 left-1/2 transform -translate-x-1/2 z-50"
      toastOptions={{
        classNames: {
          // align vertical gap and min height to match ReasoningIndicator / run button
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg px-3 py-0 min-h-[36px] flex items-center",
          description: "group-[.toast]:text-muted-foreground",
          actionButton:
            "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  )
}

export { Toaster, toast }
