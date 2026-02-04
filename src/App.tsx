import { useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { toast } from "sonner";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
import { useAppConfigStore } from "./stores/appConfigStore";
import { setTheme } from "./utils/theme";
import { loadWorkflowCatalog } from "./utils/workflowCatalogLoader";

const queryClient = new QueryClient();

const App = () => {
  const config = useAppConfigStore((s) => s.config);

  // Apply canvas theme when the stored preference changes.
  useEffect(() => {
    const theme = config.canvasTheme === "auto" ? "system" : config.canvasTheme;
    // setTheme accepts 'light' | 'dark' | 'system'
    setTheme(theme as "light" | "dark" | "system");
  }, [config.canvasTheme]);

  // Load workflow catalog on startup
  useEffect(() => {
    const loadCatalog = async () => {
      // Defensive check: ensure workflowCatalogUrls exists before accessing
      if (!config?.workflowCatalogUrls || typeof config.workflowCatalogUrls !== 'object') {
        console.warn('[App] Invalid workflowCatalogUrls configuration, skipping catalog load');
        return;
      }
      
      if (!config.loadWorkflowCatalogOnStartup || !config.workflowCatalogEnabled) {
        return;
      }

      try {
        const result = await loadWorkflowCatalog(config);
        
        if (result.success) {
          console.log('[App] Workflow catalog loaded successfully:', result.loadedFiles);
          toast.success('Workflow catalog loaded', {
            description: `${result.loadedFiles?.length || 0} files loaded from PyodideSemanticWorkflow`,
          });
        } else if (result.reason !== 'disabled') {
          console.warn('[App] Workflow catalog failed to load:', result.error);
          toast.warning('Failed to load workflow catalog', {
            description: 'Check network connection. Catalog can be loaded manually from settings.',
            duration: 5000,
          });
        }
      } catch (error) {
        console.error('[App] Unexpected error loading workflow catalog:', error);
      }
    };

    // Load after a short delay to not block initial render
    const timeoutId = setTimeout(loadCatalog, 1500);
    return () => clearTimeout(timeoutId);
  }, []); // Run once on mount

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
