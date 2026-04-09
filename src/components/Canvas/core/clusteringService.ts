/**
 * clusteringService — bridges clustering algorithms to Reactodia's EntityGroup API.
 *
 * Public API:
 *   applyCanvasClustering(model, algorithm, threshold)
 *   clearCanvasClustering(model)
 */

import * as Reactodia from '@reactodia/workspace';
import type { ClusterNode, ClusterEdge } from './clusterAlgorithms/types';
import { computeClustersLabelPropagation } from './clusterAlgorithms/labelPropagation';
import { computeClustersLouvainNgraph } from './clusterAlgorithms/louvainNgraph';
import { computeClustersKmeans } from './clusterAlgorithms/kmeans';

type Algorithm = 'label-propagation' | 'louvain' | 'kmeans';

/**
 * Run the chosen clustering algorithm over the current canvas elements and group
 * the results using Reactodia's native EntityGroup / RelationGroup API.
 *
 * Call this after a full-refresh load (emitAllSubjects) once layout is complete.
 */
export function applyCanvasClustering(
  model: Reactodia.DataDiagramModel,
  algorithm: Algorithm,
  threshold: number
): void {
  // Collect individual entities (skip any pre-existing groups)
  const entityElements = model.elements.filter(
    (el): el is Reactodia.EntityElement => el instanceof Reactodia.EntityElement
  );
  const relationLinks = model.links.filter(
    (lk): lk is Reactodia.RelationLink => lk instanceof Reactodia.RelationLink
  );

  if (entityElements.length < 2) {
    console.log('[ClusteringService] Too few elements to cluster:', entityElements.length);
    return;
  }

  // Build connectivity map: IRI → incident link count
  const connectivity = new Map<string, number>();
  for (const el of entityElements) connectivity.set(el.data.id, 0);
  for (const lk of relationLinks) {
    connectivity.set(lk.data.sourceId, (connectivity.get(lk.data.sourceId) ?? 0) + 1);
    connectivity.set(lk.data.targetId, (connectivity.get(lk.data.targetId) ?? 0) + 1);
  }

  const clusterNodes: ClusterNode[] = entityElements.map(el => ({
    id: el.data.id,
    connectivity: connectivity.get(el.data.id) ?? 0,
    position: { x: el.position.x, y: el.position.y },
  }));

  const clusterEdges: ClusterEdge[] = relationLinks.map(lk => ({
    id: lk.id,
    source: lk.data.sourceId,
    target: lk.data.targetId,
  }));

  const { clusters } = selectClusteringAlgorithm(algorithm, clusterNodes, clusterEdges, { threshold });

  console.log('[ClusteringService] Clusters computed:', {
    algorithm,
    clusterCount: clusters.size,
    elementCount: entityElements.length,
  });

  if (clusters.size === 0) {
    console.log('[ClusteringService] No clusters produced — skipping group creation');
    return;
  }

  // Build IRI → EntityElement lookup
  const elementByIri = new Map<string, Reactodia.EntityElement>(
    entityElements.map(el => [el.data.id, el])
  );

  // Create one EntityGroup per cluster
  for (const [, clusterInfo] of clusters) {
    const members: Reactodia.EntityElement[] = [];
    for (const iri of clusterInfo.nodeIds) {
      const el = elementByIri.get(iri);
      if (el) members.push(el);
    }
    if (members.length < 2) continue;
    model.group(members);
  }

  // Regroup links so that cross-group links become RelationGroups
  model.regroupLinks(model.links);

  console.log('[ClusteringService] Grouping complete');
}

/**
 * Remove all EntityGroups from the canvas, reverting to individual elements.
 * RelationGroups are reverted automatically by ungroupAll.
 */
export function clearCanvasClustering(model: Reactodia.DataDiagramModel): void {
  const groups = model.elements.filter(
    (el): el is Reactodia.EntityGroup => el instanceof Reactodia.EntityGroup
  );
  if (groups.length === 0) return;
  model.ungroupAll(groups);
  console.log('[ClusteringService] Cleared', groups.length, 'groups');
}

function selectClusteringAlgorithm(
  algorithm: Algorithm,
  nodes: ClusterNode[],
  edges: ClusterEdge[],
  options: { threshold: number }
) {
  switch (algorithm) {
    case 'louvain':          return computeClustersLouvainNgraph(nodes, edges, options);
    case 'label-propagation': return computeClustersLabelPropagation(nodes, edges, options);
    case 'kmeans':            return computeClustersKmeans(nodes, edges, options);
  }
}
