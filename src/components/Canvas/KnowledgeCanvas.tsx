import React from "react";
import ReactodiaCanvas from "./ReactodiaCanvas";
import { useOntologyStore } from "@/stores/ontologyStore";

/**
 * Legacy shim kept for backward compatibility with tests.
 * Delegates to ReactodiaCanvas and sets window flags used by older test suites.
 */
const KnowledgeCanvas: React.FC = (props) => {
  React.useEffect(() => {
    (window as any).__VG_INIT_APP_RAN = true;
    (window as any).__VG_KNOWLEDGE_CANVAS_READY = true;

    // Expose __VG_INIT_APP for test-driven force-init of URL param loading.
    (window as any).__VG_INIT_APP = async (_opts?: { force?: boolean }) => {
      const u = new URL(String(window.location.href));
      const startupUrl = u.searchParams.get('url') || u.searchParams.get('rdfUrl') || '';
      if (!startupUrl) return;
      const store = useOntologyStore.getState();
      if (typeof store.loadKnowledgeGraph === 'function') {
        await store.loadKnowledgeGraph(startupUrl, {});
      }
    };

    return () => {
      delete (window as any).__VG_INIT_APP;
    };
  }, []);

  return <ReactodiaCanvas {...(props as any)} />;
};

export default KnowledgeCanvas;
