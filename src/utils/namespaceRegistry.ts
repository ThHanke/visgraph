/**
 * namespaceRegistry helpers
 *
 * - buildRegistryFromManager: Build a canonical registry array [{prefix, namespace, color}]
 *   from an RDF manager that exposes getNamespaces().
 * - persistRegistryToStore: Persist a registry into the ontology store via its setNamespaceRegistry.
 *
 * This module centralizes the small bits of logic used in multiple places so callers
 * don't duplicate registry creation / persistence code spread across the canvas/store.
 */

import { buildPaletteMap } from "../components/Canvas/core/namespacePalette";
import { useOntologyStore } from "../stores/ontologyStore";

export type RegistryEntry = { prefix: string; namespace: string; color?: string };

/**
 * Build a palette (prefix -> color) using the project's palette builder.
 * Exposed so tests can override palette builder if needed.
 */
export type PaletteBuilder = (prefixes: string[]) => Record<string, string>;

export function defaultPaletteBuilder(prefixes: string[]) {
  try {
    return buildPaletteMap(prefixes || []);
  } catch (_) {
    // best-effort fallback: empty mapping
    return {};
  }
}

/**
 * Build a canonical namespace registry from an RDF manager object.
 * - mgr: object that may implement getNamespaces() -> { prefix: namespace }
 * - paletteBuilder: optional function to create prefix -> color mapping
 *
 * Returns an array of RegistryEntry objects sorted by prefix for determinism.
 */
export function buildRegistryFromManager(mgr?: any, paletteBuilder: PaletteBuilder = defaultPaletteBuilder): RegistryEntry[] {
  try {
    if (!mgr || typeof (mgr as any).getNamespaces !== "function") return [];
    const nsMap: Record<string, string> = (mgr as any).getNamespaces() || {};
    if (!nsMap || typeof nsMap !== "object") return [];

    const prefixes = Object.keys(nsMap || {}).filter(Boolean).sort();
    const palette = paletteBuilder(prefixes || []);
    const registry: RegistryEntry[] = (prefixes || []).map((p) => {
      try {
        const ns = String((nsMap as any)[p] || "");
        const color = palette && typeof palette === "object" ? (palette[p] || palette[p.toLowerCase()] || "") : "";
        return { prefix: String(p), namespace: String(ns), color: String(color || "") };
      } catch (_) {
        return { prefix: String(p), namespace: String((nsMap as any)[p] || ""), color: "" };
      }
    });
    return registry;
  } catch (_) {
    return [];
  }
}

/**
 * Persist the provided registry into the ontology store using the store's setter.
 * This is best-effort and will swallow errors to avoid crashing UI flows.
 */
export function persistRegistryToStore(registry: RegistryEntry[]) {
  try {
    if (!Array.isArray(registry)) return;
    try {
      if (useOntologyStore && typeof (useOntologyStore as any).getState === "function") {
        (useOntologyStore as any).getState().setNamespaceRegistry(registry);
        return;
      }
    } catch (_) {
      // fallback: try invoking the hook directly (some tests mock the hook as a function)
    }
    try {
      (useOntologyStore as any)().setNamespaceRegistry(registry);
    } catch (_) {
      // ignore persist failures
    }
  } catch (_) {
    // ignore
  }
}
