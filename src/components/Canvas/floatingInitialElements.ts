import { debug } from '../../utils/startupDebug';

export function initialElements() {
  // Example placeholder used by the docs example's App.tsx.
  // This repository doesn't use the demo initialElements at runtime,
  // so return empty arrays to avoid affecting the app.
  return {
    nodes: [],
    edges: [],
  };
}

/**
 * getEdgeParams
 * Compute simple anchor coordinates and suggested handle positions for two internal nodes.
 *
 * The docs example expects nodes with:
 *  - node.internals.positionAbsolute.x / .y  (position in canvas coordinates)
 *  - node.measured.width / .height
 *
 * We compute the center point for each node and pick source/target handle positions
 * based on the primary axis between the nodes (left/right when wider than tall).
 */
export function getEdgeParams(sourceNode: any, targetNode: any) {
  const sPos = (sourceNode && (sourceNode.internals?.positionAbsolute || sourceNode.position)) || { x: 0, y: 0 };
  const tPos = (targetNode && (targetNode.internals?.positionAbsolute || targetNode.position)) || { x: 0, y: 0 };

  const sMeasured = (sourceNode && sourceNode.measured) || { width: 0, height: 0 };
  const tMeasured = (targetNode && targetNode.measured) || { width: 0, height: 0 };

  const sx = (typeof sPos.x === 'number' ? sPos.x : 0) + (typeof sMeasured.width === 'number' ? sMeasured.width : 0) / 2;
  const sy = (typeof sPos.y === 'number' ? sPos.y : 0) + (typeof sMeasured.height === 'number' ? sMeasured.height : 0) / 2;
  const tx = (typeof tPos.x === 'number' ? tPos.x : 0) + (typeof tMeasured.width === 'number' ? tMeasured.width : 0) / 2;
  const ty = (typeof tPos.y === 'number' ? tPos.y : 0) + (typeof tMeasured.height === 'number' ? tMeasured.height : 0) / 2;

  const dx = tx - sx;
  const dy = ty - sy;

  // Choose handle positions based on dominant axis
  const horizontal = Math.abs(dx) > Math.abs(dy);

  const sourcePos = horizontal ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'bottom' : 'top');
  const targetPos = horizontal ? (dx > 0 ? 'left' : 'right') : (dy > 0 ? 'top' : 'bottom');

  debug('edge.params', { sPos, tPos, sMeasured, tMeasured, sx, sy, tx, ty, sourcePos, targetPos });

  return {
    sx,
    sy,
    tx,
    ty,
    sourcePos,
    targetPos,
  };
}
