/**
 * Store Access Helpers
 * 
 * Centralized utilities for accessing ontology store data to eliminate
 * duplicated access patterns across UI components.
 */

import { useOntologyStore } from "../stores/ontologyStore";
import type { RDFManager } from "./rdfManager";

/**
 * Get the namespace registry from the ontology store.
 * Returns an empty array if registry is not available.
 */
export function getNamespaceRegistry(): Array<{ prefix: string; namespace: string; color?: string }> {
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
 * Get available properties from the fat-map.
 * Returns an empty array if not available.
 */
export function getAvailableProperties(): any[] {
  try {
    const state = useOntologyStore.getState();
    return Array.isArray(state.availableProperties) ? state.availableProperties : [];
  } catch {
    return [];
  }
}

/**
 * Get available classes from the fat-map.
 * Returns an empty array if not available.
 */
export function getAvailableClasses(): any[] {
  try {
    const state = useOntologyStore.getState();
    return Array.isArray(state.availableClasses) ? state.availableClasses : [];
  } catch {
    return [];
  }
}

/**
 * Get ontology store state snapshot with fat-map data.
 * Useful for components that need multiple pieces of state atomically.
 */
export function getOntologyStoreSnapshot() {
  try {
    const state = useOntologyStore.getState();
    return {
      namespaceRegistry: Array.isArray(state.namespaceRegistry) ? state.namespaceRegistry : [],
      availableProperties: Array.isArray(state.availableProperties) ? state.availableProperties : [],
      availableClasses: Array.isArray(state.availableClasses) ? state.availableClasses : [],
      ontologiesVersion: state.ontologiesVersion ?? 0,
      rdfManager: getRdfManager(),
    };
  } catch {
    return {
      namespaceRegistry: [],
      availableProperties: [],
      availableClasses: [],
      ontologiesVersion: 0,
      rdfManager: null,
    };
  }
}

/**
 * Convert fat-map entries to entity format for autocomplete components.
 * Handles both properties and classes with consistent shape.
 */
export function fatMapToEntities(entries: any[]): Array<{ iri: string; label?: string; prefixed?: string }> {
  if (!Array.isArray(entries)) return [];
  
  return entries.map((entry: any) => ({
    iri: String(entry.iri || entry.key || entry || ''),
    label: entry.label,
    prefixed: entry.prefixed,
  })).filter(e => e.iri.length > 0);
}
