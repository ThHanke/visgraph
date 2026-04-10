/**
 * clusteringService — bridges clustering algorithms to Reactodia's EntityGroup API.
 *
 * Public API:
 *   applyCanvasClustering(ctx, canvas, algorithm, threshold, layoutFunction, animate): Promise<void>
 *   clearCanvasClustering(model): EntityElement[]
 */

import * as Reactodia from '@reactodia/workspace';
import type { LayoutFunction } from '@reactodia/workspace';
import type { ClusterNode, ClusterEdge } from './clusterAlgorithms/types';
import { computeClustersLabelPropagation } from './clusterAlgorithms/labelPropagation';
import { computeClustersLouvainNgraph } from './clusterAlgorithms/louvainNgraph';
import { computeClustersKmeans } from './clusterAlgorithms/kmeans';

type Algorithm = 'label-propagation' | 'louvain' | 'kmeans';

/**
 * Run the chosen clustering algorithm, group clusters using Reactodia's groupEntities
 * API (handles animation, link state, and history correctly), then run a full layout
 * pass so groups are compactly positioned with no empty gaps.
 *
 * All code paths (Cluster button, algo/threshold change) use this function via
 * runClustering in ReactodiaCanvas.
 */
export async function applyCanvasClustering(
  ctx: Reactodia.WorkspaceContext,
  canvas: Reactodia.CanvasApi,
  algorithm: Algorithm,
  threshold: number,
  layoutFunction: LayoutFunction,
  animate: boolean
): Promise<void> {
  const model = ctx.model;

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

  // Build element lookup upfront — all plans computed before any groupEntities call
  // mutates the model, so references stay live throughout plan construction.
  const elementByIri = new Map<string, Reactodia.EntityElement>(
    entityElements.map(el => [el.data.id, el])
  );

  // Phase 1: build all member lists while model is still flat.
  // elementByIri is captured before any groupEntities call removes elements.
  const groupPlans: Reactodia.EntityElement[][] = [];
  const alreadyGrouped = new Set<string>();
  for (const [, clusterInfo] of clusters) {
    const members: Reactodia.EntityElement[] = [];
    for (const iri of clusterInfo.nodeIds) {
      if (alreadyGrouped.has(iri)) continue;
      const el = elementByIri.get(iri);  // reuse existing map
      if (el) members.push(el);
    }
    if (members.length < 2) continue;
    for (const m of members) alreadyGrouped.add(m.data.id);
    groupPlans.push(members);
  }

  // Phase 2: capture group centers from current layout (before any mutation).
  const groupCenters: Reactodia.Vector[] = groupPlans.map(members => {
    const box = Reactodia.getContentFittingBox(members, [], canvas.renderingState);
    return Reactodia.Rect.center(box);
  });

  // Phase 3: ONE animateGraph call — all members from all clusters converge simultaneously.
  if (animate) {
    await canvas.animateGraph(() => {
      for (let i = 0; i < groupPlans.length; i++) {
        const groupCenter = groupCenters[i];
        for (const element of groupPlans[i]) {
          const bounds = Reactodia.boundsOf(element, canvas.renderingState);
          const atCenter: Reactodia.Vector = {
            x: groupCenter.x - bounds.width / 2,
            y: groupCenter.y - bounds.height / 2,
          };
          const normal = Reactodia.Vector.normalize(
            Reactodia.Vector.subtract(element.position, groupCenter)
          );
          element.setPosition(Reactodia.Vector.add(
            atCenter,
            Reactodia.Vector.scale(normal, Math.min(bounds.width, bounds.height) / 2)
          ));
        }
      }
    });
  }

  // Phase 4: create all groups at once, then ONE syncUpdate — no per-group flicker.
  const entityGroups = groupPlans.map(members => model.group(members));
  canvas.renderingState.syncUpdate();

  // Phase 5: position all groups at their computed centers.
  for (let i = 0; i < entityGroups.length; i++) {
    const group = entityGroups[i];
    const groupCenter = groupCenters[i];
    const bounds = Reactodia.boundsOf(group, canvas.renderingState);
    group.setPosition({
      x: groupCenter.x - bounds.width / 2,
      y: groupCenter.y - bounds.height / 2,
    });
  }

  // Layout the resulting graph (groups + remaining ungrouped nodes) so groups are
  // compactly positioned — without this, groups sit at member centroids and leave
  // large empty gaps where individual nodes used to be.
  await ctx.performLayout({ layoutFunction, animate, canvas });

  console.log('[ClusteringService] Grouping complete');
}

/**
 * Remove all EntityGroups from the canvas, reverting to individual elements.
 * Returns the ungrouped EntityElement instances so the caller can apply layout.
 * RelationGroups are reverted automatically by ungroupAll.
 */
export function clearCanvasClustering(model: Reactodia.DataDiagramModel): Reactodia.EntityElement[] {
  const groups = model.elements.filter(
    (el): el is Reactodia.EntityGroup => el instanceof Reactodia.EntityGroup
  );
  if (groups.length === 0) return [];
  const ungrouped = model.ungroupAll(groups);
  console.log('[ClusteringService] Cleared', groups.length, 'groups, released', ungrouped.length, 'elements');
  return ungrouped;
}

function selectClusteringAlgorithm(
  algorithm: Algorithm,
  nodes: ClusterNode[],
  edges: ClusterEdge[],
  options: { threshold: number }
): ReturnType<typeof computeClustersLabelPropagation> {
  switch (algorithm) {
    case 'louvain':           return computeClustersLouvainNgraph(nodes, edges, options);
    case 'label-propagation': return computeClustersLabelPropagation(nodes, edges, options);
    case 'kmeans':            return computeClustersKmeans(nodes, edges, options);
    default: {
      const _exhaustive: never = algorithm;
      throw new Error(`[ClusteringService] Unknown algorithm: ${_exhaustive}`);
    }
  }
}
