import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import './reactflow-controls.css';
import '@xyflow/react/dist/style.css';
import 'reactflow/dist/style.css';
import { initTheme } from './utils/theme'
import { rdfManager } from './utils/rdfManager';
import { useAppConfigStore } from './stores/appConfigStore';
// import { useOntologyStore } from './stores/ontologyStore';

initTheme();

// Apply persisted blacklist from app config at startup (best-effort)
try {
  const cfg = (useAppConfigStore as any).getState().config;
  if (cfg) {
    const prefixes = Array.isArray(cfg.blacklistedPrefixes) ? cfg.blacklistedPrefixes : [];
    const uris = Array.isArray(cfg.blacklistedUris) ? cfg.blacklistedUris : [];
    if (cfg.blacklistEnabled === false) {
      rdfManager.setBlacklist([], []);
    } else {
      rdfManager.setBlacklist(prefixes, uris);
    }
  }
} catch (_) {
  /* ignore startup blacklist application failures */
}

createRoot(document.getElementById("root")!).render(<App />);
