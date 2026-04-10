/**
 * Store Access Helpers
 * 
 * Centralized utilities for accessing ontology store data to eliminate
 * duplicated access patterns across UI components.
 */

import { useOntologyStore } from "../stores/ontologyStore";
import type { RDFManager } from "./rdfManager";
import type { NamespaceEntry } from "../constants/namespaces";

/**
 * Get the namespace registry from the ontology store.
 * Returns an empty array if registry is not available.
 */
export function getNamespaceRegistry(): NamespaceEntry[] {
  try {
    const state = useOntologyStore.getState();
    return Array.isArray(state.namespaceRegistry) ? state.namespaceRegistry : [];
  } catch {
    return [];
  }
}

/**
 * Get the RDF manager from the ontology store with fallback handling.
 * Returns null if manager is not available.
 */
export function getRdfManager(): RDFManager | null {
  try {
    const state = useOntologyStore.getState();
    
    // Try getRdfManager() method first
    if (typeof (state as any).getRdfManager === "function") {
      try {
        const mgr = (state as any).getRdfManager();
        if (mgr) return mgr;
      } catch {
        // Continue to fallback
      }
    }
    
    // Fallback to direct rdfManager property
    if (state.rdfManager) {
      return state.rdfManager;
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Get ontology store state snapshot.
 * Useful for components that need multiple pieces of state atomically.
 */
export function getOntologyStoreSnapshot() {
  try {
    const state = useOntologyStore.getState();
    return {
      namespaceRegistry: Array.isArray(state.namespaceRegistry) ? state.namespaceRegistry : [],
      ontologiesVersion: state.ontologiesVersion ?? 0,
      rdfManager: getRdfManager(),
    };
  } catch {
    return {
      namespaceRegistry: [],
      ontologiesVersion: 0,
      rdfManager: null,
    };
  }
}
