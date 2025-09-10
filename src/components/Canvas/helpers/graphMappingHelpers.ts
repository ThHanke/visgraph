/**
 * Helpers for mapping parsed graph nodes/edges to  model keys.
 */

/**
 * Resolve a reference (uri/id/individual name) to a diagram node key using the parsed graph (cg).
 * - cg: the currentGraph structure containing nodes (each node may be raw or have .data)
 * Returns the resolved node key if a matching node is found, otherwise returns the original reference.
 */
export function resolveKeyForCg(ref: string | undefined | null, cg: any): string | undefined | null {
  if (!ref) return ref;
  if (!cg || !Array.isArray(cg.nodes)) return ref;

  const found = cg.nodes.find((n: any) => {
    const nd = n && (n.data || n);
    if (!nd) return false;
    return (
      nd.uri === ref ||
      nd.iri === ref ||
      nd.id === ref ||
      n.id === ref ||
      nd.individualName === ref
    );
  });

  if (found) {
    const nd = (found.data || found);
    return (nd && (nd.uri || nd.iri || nd.id)) || found.uri || found.id || (found.key);
  }

  // fallback to the original reference if no matching node found
  return ref;
}
