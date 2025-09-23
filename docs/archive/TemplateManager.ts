import { useOntologyStore } from "../../../stores/ontologyStore";
import { computeTermDisplay, shortLocalName } from "../../../utils/termUtils";

/**
 * Minimal TemplateManager compatibility shim.
 *
 * Tests and a few modules import TemplateManager and call its private
 * computeDisplayType method. The original implementation provided a richer
 * feature set; for the purposes of the test-suite and incremental cleanup
 * we provide a small, well-documented implementation that:
 * - Chooses a candidate type from displayType/type/classType/rdfTypes/types
 * - Filters out owl:NamedIndividual entries
 * - Resolves a prefixed/short label using computeTermDisplay when an rdfManager
 *   is available from the ontology store
 *
 * This file intentionally keeps the surface area small to avoid coupling to the
 * larger TemplateManager behaviour. If further behaviour is required by tests
 * we can extend this class later.
 */
export class TemplateManager {
  constructor() {
    // No initialization required for the shim.
  }

  /**
   * Compute a display-friendly type string for a node-like data object.
   * This mirrors the minimal behaviour expected by the tests:
   *  - prefer displayType, then type/classType, then entries from rdfTypes/types arrays
   *  - skip values that match NamedIndividual
   *  - return an empty string when no suitable type found
   *  - when possible, use computeTermDisplay to return a prefixed form like "ex:Person"
   */
  computeDisplayType(data: any): string {
    if (!data) return "";

    // Access ontology store to find rdfManager / namespaces if available.
    const storeState: any = (useOntologyStore as any).getState ? (useOntologyStore as any).getState() : (useOntologyStore as any);
    const mgr = typeof storeState?.getRdfManager === "function" ? storeState.getRdfManager() : (storeState && storeState.rdfManager) ? storeState.rdfManager : undefined;

    const normalizeCandidate = (v: any): string | null => {
      if (!v && v !== 0) return null;
      if (Array.isArray(v)) return v.length > 0 ? String(v[0]) : null;
      return String(v);
    };

    // Candidate priority: displayType -> type -> classType -> rdfTypes/types array
    const prioritized: string[] = [];

    const firstPref = normalizeCandidate(data?.displayType) || normalizeCandidate(data?.type) || normalizeCandidate(data?.classType);
    if (firstPref) prioritized.push(firstPref);

    // Push any array candidates (maintain order)
    const arrCandidates = Array.isArray(data?.rdfTypes) ? data.rdfTypes.slice() : Array.isArray(data?.types) ? data.types.slice() : [];
    for (const a of arrCandidates) {
      try {
        if (a) prioritized.push(String(a));
      } catch (_) { /* ignore per-item */ }
    }

    // Find first non-NamedIndividual candidate
    let chosen: string | null = null;
    for (const c of prioritized) {
      if (!c) continue;
      if (/NamedIndividual/i.test(c)) continue;
      chosen = c;
      break;
    }

    if (!chosen) return "";

    // Attempt to compute a prefixed display using computeTermDisplay
    try {
      const td = computeTermDisplay(String(chosen), mgr);
      if (td && (td.prefixed || td.short)) return String(td.prefixed || td.short);
      return shortLocalName(String(chosen));
    } catch (_) {
      // Fallbacks: if it's already a prefixed form return it; otherwise return short local name
      try {
        if (String(chosen).includes(":") && !String(chosen).includes("://")) return String(chosen);
      } catch (_) { /* ignore */ }
      try {
        return shortLocalName(String(chosen));
      } catch (_) {
        return String(chosen || "");
      }
    }
  }
}
