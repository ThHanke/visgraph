 // Rely on vite-plugin-node-polyfills for process/stream/buffer in the bundle.
 // No runtime shims here — remove local polyfills to rely on configured Vite polyfills.
 
 // Explicit runtime polyfills as a safeguard to ensure process/stream/buffer are bundled
 // in production builds (the vite plugin + aliases are the primary mechanism).
 import 'process/browser';
 import 'stream-browserify';
 import { Buffer } from 'buffer';
 
 import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import '@xyflow/react/dist/style.css';
import 'reactflow/dist/style.css';
import { initTheme } from './utils/theme'
import { rdfManager } from './utils/rdfManager';
import { useAppConfigStore } from './stores/appConfigStore';
// import { useOntologyStore } from './stores/ontologyStore';

initTheme();

// Apply persisted blacklist from app config at startup (best-effort)
{
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
}

 // Initialize global debug gate and lightweight console.* wrapper driven by app config.
 // Messages that start with a "[VG_" prefix are considered diagnostic and will only be
 // emitted when the master config.debugAll flag is enabled. Non-VG console output is left intact.
 {
   // Seed window flag from persisted config
   const cfg = (useAppConfigStore as any).getState().config;
   // Force-enable VG debug gates for diagnostics during this investigation.
   // NOTE: This is a temporary diagnostic change — revert once debugging is complete.
   try { (window as any).__VG_DEBUG__ = true; } catch (_) { void 0; }

   // Also seed common debug-related flags so older helpers read a consistent value.
   try { (window as any).__VG_LOG_RDF_WRITES = true; } catch (_) { void 0; }
   try { (window as any).__VG_DEBUG_STACKS__ = true; } catch (_) { void 0; }

   // Helper used by wrappers to determine whether VG_* messages should be emitted.
   const isVgMessage = (args: any[]) => {
     try {
       if (!args || args.length === 0) return false;
       const first = args[0];
       return typeof first === "string" && /^\[VG_[A-Z0-9_]+\]/.test(first);
     } catch (_) {
       return false;
     }
   };

   // Wrap a console method so VG_* messages are gated by config.debugAll while other messages pass through.
   const wrapConsoleMethod = (methodName: keyof Console) => {
     try {
       const orig = (console as any)[methodName] ? (console as any)[methodName].bind(console) : (..._a: any[]) => {};
       (console as any)[methodName] = (...args: any[]) => {
         try {
           // If it's a VG_* message, gate on the master debug flag; otherwise always log.
           if (isVgMessage(args)) {
             const enabled = !!((useAppConfigStore as any).getState().config?.debugAll) || !!(window as any).__VG_DEBUG__;
             if (enabled) orig(...args);
           } else {
             orig(...args);
           }
         } catch (_) {
           // swallow
         }
       };
     } catch (_) {
       // swallow wrapping errors
     }
   };

   // Wrap commonly used console methods
   ["debug", "log", "info", "warn", "error"].forEach((m) => wrapConsoleMethod(m as any));

   // Keep window.__VG_DEBUG__ and related flags in sync when the user toggles the flag at runtime.
   try {
     const unsub = (useAppConfigStore as any).subscribe((s: any) => s.config?.debugAll, (v: any) => {
       try { (window as any).__VG_DEBUG__ = Boolean(v); } catch (_) { void 0; }
       try { (window as any).__VG_LOG_RDF_WRITES = Boolean(v); } catch (_) { void 0; }
       try { (window as any).__VG_DEBUG_STACKS__ = Boolean(v); } catch (_) { void 0; }
     });
     try { (window as any).__VG_DEBUG_SUBSCRIBE_UNSUB = unsub; } catch (_) { void 0; }
   } catch (_) { /* ignore subscribe failures */ }
 }

createRoot(document.getElementById("root")!).render(<App />);
