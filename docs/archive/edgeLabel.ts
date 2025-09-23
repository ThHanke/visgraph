import { computeTermDisplay, shortLocalName } from "../../../utils/termUtils";

/**
 * getPredicateDisplay
 *
 * Centralized helper to produce a user-facing label for an edge predicate.
 * Resolution priority:
 *  1) availableProperties[].label (if available)
 *  2) computeTermDisplay(predicateUri, rdfMgr) -> prefixed || short
 *  3) shortLocalName(predicateUri)
 *
 * This ensures new edges and mapped (persisted) edges use the same formatting logic.
 */
export function getPredicateDisplay(
  predicateUri: string | null | undefined,
  opts?: {
    rdfMgr?: any;
    availableProperties?: Array<{ iri?: string; value?: string; label?: string }>;
  }
): string {
  const uri = String(predicateUri || "").trim();
  if (!uri) return "";

  const available = opts && opts.availableProperties ? opts.availableProperties : [];

  try {
    const found =
      available.find((p: any) => String(p && (p.iri || p.value || "")).trim() === uri) ||
      null;
    if (found && found.label) return String(found.label);
  } catch (_) {
    // ignore availableProperties lookup failures
  }

  const mgr = opts && opts.rdfMgr ? opts.rdfMgr : undefined;
  if (mgr) {
    try {
      const td = computeTermDisplay(String(uri), mgr as any);
      if (td) return String(td.prefixed || td.short || "");
    } catch (_) {
      // fall through to local name fallback
    }
  }

  return shortLocalName(String(uri));
}
