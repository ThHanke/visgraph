import { Node, Position, MarkerType, XYPosition, InternalNode } from '@xyflow/react';

// this helper function returns the intersection point
// of the line between the center of the intersectionNode and the target node
function getNodeIntersection(intersectionNode: InternalNode, targetNode: InternalNode) {
  // Safe guard: ensure measured and position information exists; otherwise return a sensible fallback.
  const measured = intersectionNode.measured;
  const intersectionPos = intersectionNode.internals?.positionAbsolute;
  const targetPos = targetNode.internals?.positionAbsolute;

  if (!measured || !intersectionPos || !targetPos || !measured.width || !measured.height) {
    // Return the intersection node center as a fallback
    return {
      x: (intersectionPos?.x ?? 0) + ((measured?.width ?? 0) / 2),
      y: (intersectionPos?.y ?? 0) + ((measured?.height ?? 0) / 2),
    };
  }

  const intersectionNodeWidth = measured.width;
  const intersectionNodeHeight = measured.height;
  const intersectionNodePosition = intersectionPos;
  const targetPosition = targetPos;

  const w = intersectionNodeWidth / 2;
  const h = intersectionNodeHeight / 2;

  const x2 = intersectionNodePosition.x + w;
  const y2 = intersectionNodePosition.y + h;
  const x1 = targetPosition.x + w;
  const y1 = targetPosition.y + h;

  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  const xx3 = a * xx1;
  const yy3 = a * yy1;
  const x = w * (xx3 + yy3) + x2;
  const y = h * (-xx3 + yy3) + y2;
  return { x, y };
}

// returns the position (top,right,bottom or right) passed node compared to the intersection point
function getEdgePosition(node: InternalNode, intersectionPoint: XYPosition) {
  // Normalize node position shape and avoid non-null assertions.
  const pos = node.internals?.positionAbsolute ?? { x: 0, y: 0 };
  const measured = node.measured ?? { width: 0, height: 0 };
  const nx = Math.round(pos.x ?? 0);
  const ny = Math.round(pos.y ?? 0);
  const px = Math.round(intersectionPoint.x ?? 0);
  const py = Math.round(intersectionPoint.y ?? 0);
  const width = measured.width ?? 0;
  const height = measured.height ?? 0;

  if (px <= nx + 1) {
    return Position.Left;
  }
  if (px >= nx + width - 1) {
    return Position.Right;
  }
  if (py <= ny + 1) {
    return Position.Top;
  }
  if (py >= ny + height - 1) {
    return Position.Bottom;
  }

  return Position.Top;
}

// returns the parameters (sx, sy, tx, ty, sourcePos, targetPos) you need to create an edge
export function getEdgeParams(source: InternalNode, target: InternalNode) {
  const sourceIntersectionPoint = getNodeIntersection(source, target);
  const targetIntersectionPoint = getNodeIntersection(target, source);

  const sourcePos = getEdgePosition(source, sourceIntersectionPoint);
  const targetPos = getEdgePosition(target, targetIntersectionPoint);

  return {
    sx: sourceIntersectionPoint.x,
    sy: sourceIntersectionPoint.y,
    tx: targetIntersectionPoint.x,
    ty: targetIntersectionPoint.y,
    sourcePos,
    targetPos,
  };
}

export function createNodesAndEdges() {
  const nodes = [];
  const edges = [];
  const center = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

  nodes.push({ id: 'target', data: { label: 'Target' }, position: center });

  for (let i = 0; i < 8; i++) {
    const degrees = i * (360 / 8);
    const radians = degrees * (Math.PI / 180);
    const x = 250 * Math.cos(radians) + center.x;
    const y = 250 * Math.sin(radians) + center.y;

    nodes.push({ id: `${i}`, data: { label: 'Source' }, position: { x, y } });

    edges.push({
      id: `edge-${i}`,
      target: 'target',
      source: `${i}`,
      type: 'floating',
      markerEnd: {
        type: MarkerType.Arrow,
      },
    });
  }

  return { nodes, edges };
}
