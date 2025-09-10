import { useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
import { useAppConfigStore } from "./stores/appConfigStore";
import { setTheme } from "./utils/theme";

const queryClient = new QueryClient();

const App = () => {
  const config = useAppConfigStore((s) => s.config);

  // Apply canvas theme when the stored preference changes.
  useEffect(() => {
    const theme = config.canvasTheme === "auto" ? "system" : config.canvasTheme;
    // setTheme accepts 'light' | 'dark' | 'system'
    setTheme(theme as "light" | "dark" | "system");
  }, [config.canvasTheme]);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <BrowserRouter basename={import.meta.env.PROD ? '/visgraph' : '/'}>
          <Routes>
            <Route path="/" element={<Index />} />
            {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
