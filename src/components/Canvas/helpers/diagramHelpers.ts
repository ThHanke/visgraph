/**
 * Pure helpers that operate on a  Diagram instance.
 * These are deliberately free of React imports so they can be used
 * from components without exporting non-component values from the same file.
 */

export function filterNodesByViewMode(diagram: any, viewMode: 'abox' | 'tbox') {
  try {
    if (!diagram) return;
    diagram.startTransaction('update view mode');
    diagram.nodes.each((node: any) => {
      const data = node.data;
      const isTBoxEntity = data.rdfTypes && data.rdfTypes.some((type: string) =>
        type.includes('Class') ||
        type.includes('ObjectProperty') ||
        type.includes('AnnotationProperty') ||
        type.includes('DatatypeProperty')
      );
      const shouldShow = viewMode === 'tbox' ? isTBoxEntity : !isTBoxEntity;
      diagram.model.setDataProperty(data, 'visible', shouldShow);
    });
    diagram.commitTransaction('update view mode');
  } catch {
    // non-fatal
  }
}

/**
 * Apply a palette to all nodes in a diagram.
 * Parameters:
 * - diagram: go.Diagram instance
 * - mgr: RDF manager (optional)
 * - availableClasses: ontology classes array
 * - buildPaletteForRdfManager: function(mgr) => palette object
 * - computeDisplayInfoMemo: function(canonical, mgr, availableClasses)
 * - computeBadgeText: function(canonical, mgr, availableClasses)
 *
 * This mirrors the logic previously embedded in Canvas but keeps it
 * in a pure function so it can be tested and referenced without React side-effects.
 */
export function applyPaletteToModelForDiagram(
  diagram: any,
  mgr: any,
  availableClasses: any[],
  buildPaletteForRdfManager: (mgr?: any) => Record<string, string>,
  computeDisplayInfoMemo: (canonical: any, mgr?: any, classes?: any[]) => any,
  computeBadgeText: (canonical: any, mgr?: any, classes?: any[]) => string | undefined
) {
  try {
    if (!diagram) return;
    const palette = buildPaletteForRdfManager(mgr);
    if (!palette || Object.keys(palette).length === 0) return;

    diagram.startTransaction('apply palette to model');
    const nodes = diagram.model.nodeDataArray || [];
    for (const nd of nodes) {
      try {
        const canonical = {
          rdfTypes: Array.isArray(nd?.rdfTypes) ? nd.rdfTypes.map(String).filter(Boolean) : [],
         iri: nd?.iri || nd?.iri || nd?.key || nd?.id || ''
        };
        const info = computeDisplayInfoMemo(canonical, mgr, availableClasses);
        const badge = computeBadgeText(canonical, mgr, availableClasses) || info?.prefixed || '';
        let ns = (info && typeof info.namespace === 'string' && info.namespace) ? info.namespace : (nd && nd.namespace) || '';
        if (!ns && badge && badge.includes(':')) {
          const parts = String(badge).split(':');
          if (parts && parts.length > 1) ns = parts[0];
        }
        const color = palette[ns] || palette[(ns || '').replace(new RegExp('[:#].*$'), '')] || undefined;
        if (color) {
          diagram.model.setDataProperty(nd, 'color', color);
        }
      } catch {
        // ignore per-node failures
      }
    }
    diagram.commitTransaction('apply palette to model');
  } catch {
    // non-fatal
  }
}
