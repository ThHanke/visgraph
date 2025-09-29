/**
 * Lightweight runtime debug helper injected in development.
 * - Logs the React Flow instance nodes (window.__VG_RF_INSTANCE.getNodes())
 * - Logs ontology store snapshots (availableProperties, availableClasses, entity index)
 * - Exposes window.__VG_DEBUG_DUMP() to re-run the dump from the browser console
 *
 * This file is intentionally minimal and guarded so it won't crash production.
 */
import { useEffect } from "react";
import { useOntologyStore } from "../stores/ontologyStore";

function safeLog(...args: any[]) {
  try {
    // Prefer console.debug for consistency with existing logs
    if (typeof console !== "undefined" && typeof console.debug === "function") {
      console.debug(...args);
    } else if (typeof console !== "undefined" && typeof console.log === "function") {
      console.log(...args);
    }
  } catch (_) { /* ignore logging errors */ }
}

function dumpRuntimeState() {
  try {
    const inst = (window as any).__VG_RF_INSTANCE;
    const rfNodes = inst && typeof inst.getNodes === "function" ? inst.getNodes() : null;
    safeLog("[VG_DEBUG] runtime.dump rfInstanceNodes", rfNodes);
  } catch (e) {
    safeLog("[VG_DEBUG] runtime.dump rfInstanceNodes failed", e);
  }
  try {
    // Zustand store snapshot access (fat-map / entity index)
    const os = (useOntologyStore as any);
    const state = os && typeof os.getState === "function" ? os.getState() : null;
    const availableProperties = state && state.availableProperties ? state.availableProperties : null;
    const availableClasses = state && state.availableClasses ? state.availableClasses : null;
    const entityIndex = state && typeof state.getEntityIndex === "function" ? state.getEntityIndex() : null;
    safeLog("[VG_DEBUG] runtime.dump availableProperties.length", Array.isArray(availableProperties) ? availableProperties.length : availableProperties);
    safeLog("[VG_DEBUG] runtime.dump availableClasses.length", Array.isArray(availableClasses) ? availableClasses.length : availableClasses);
    safeLog("[VG_DEBUG] runtime.dump entityIndex", entityIndex);
  } catch (e) {
    safeLog("[VG_DEBUG] runtime.dump ontologyStore failed", e);
  }
}

// Install a global debug function and run an initial dump shortly after load to allow bootstrapping to complete.
try {
  (window as any).__VG_DEBUG_DUMP = () => {
    try { dumpRuntimeState(); } catch (_) { /* ignore */ }
  };
  // Defer initial dump so module imports and HMR settle
  setTimeout(() => {
    try { dumpRuntimeState(); } catch (_) { /* ignore */ }
  }, 1000);
} catch (_) {
  /* ignore */
}

// Export a no-op to make this file import-friendly in ESM
export default {};
