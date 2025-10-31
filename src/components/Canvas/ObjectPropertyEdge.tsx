import React, { memo, useState, useCallback, useRef, useEffect } from "react";
import {
  getBezierPath,
  EdgeLabelRenderer,
  EdgeProps,
  BaseEdge,
  useInternalNode,
  MarkerType,
} from "@xyflow/react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipTrigger, TooltipContent } from "../ui/tooltip";
import PropertyList from "../ui/PropertyList";
import { getEdgeParams } from "./EdgeParams";
import { resolveEdgeRenderProps } from "./core/edgeStyle";
import type { LinkData } from "../../types/canvas";

/**
 * ObjectPropertyEdge
 *
 * Renders a cubic-bezier edge split into two segments with a draggable handle (the label).
 * The handle's signed perpendicular offset from the default bezier midpoint is persisted
 * as `shift` on edge.data. Clicking selects the edge; clicking again opens the editor.
 */
const ObjectPropertyEdge = memo((props: EdgeProps) => {
  const { id, source, target, style, data, markerEnd: propMarkerEnd } = props as any;
  const dataTyped = data as LinkData;

  const hasEdgeErrors = Array.isArray((dataTyped as any).reasoningErrors) && (dataTyped as any).reasoningErrors.length > 0;
  const hasEdgeWarnings = Array.isArray((dataTyped as any).reasoningWarnings) && (dataTyped as any).reasoningWarnings.length > 0;

  // React Flow node internals
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  // Provide safe defaults for geometry so hooks can be declared unconditionally.
  let sx = 0;
  let sy = 0;
  let tx = 0;
  let ty = 0;
  let sourcePos: any = undefined;
  let targetPos: any = undefined;

  if (sourceNode && targetNode) {
    const params = getEdgeParams(sourceNode, targetNode);
    sx = params.sx;
    sy = params.sy;
    tx = params.tx;
    ty = params.ty;
    sourcePos = params.sourcePos;
    targetPos = params.targetPos;
  }

  // Hooks and refs must be declared unconditionally.
  const controlFixedRef = useRef<boolean>(Boolean(typeof (dataTyped as any).shift === "number" && (dataTyped as any).shift !== undefined));
  const defaultLabelRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const perpUnitRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const draggingRef = useRef<boolean>(false);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const pointerStartProjRef = useRef<{ x: number; y: number } | null>(null);
  const lastPointerIdRef = useRef<number | null>(null);
  // Offset between pointer down position (projected) and the control point to avoid jump on drag start
  const clickOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  // Local selection flag to track selection initiated from this component (fallback when props.selected isn't available)
  const selectionRef = useRef<boolean>(false);

  const [control, setControl] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isHovered, setIsHovered] = useState(false);
  const onHoverEnter = useCallback(() => setIsHovered(true), []);
  const onHoverLeave = useCallback(() => setIsHovered(false), []);
  // Selection state: prefer RF prop, fall back to edge data selected flag
  const isSelected = !!((props as any).selected || (dataTyped && (dataTyped as any).selected));

  // Persisted signed scalar shift (distance along perpendicular from default Bezier control)
  const persistedShift =
    dataTyped && typeof (dataTyped as any).shift === "number"
      ? Number((dataTyped as any).shift)
      : 0;

  // Recompute baseline Bezier control and perpendicular when node geometry changes.
  // This useEffect is declared unconditionally (hooks must not be called conditionally).
  useEffect(() => {
    try {
      const bez = getBezierPath({
        sourceX: sx,
        sourceY: sy,
        sourcePosition: sourcePos as any,
        targetX: tx,
        targetY: ty,
        targetPosition: targetPos as any,
        curvature: 0.25,
      });
      const baselineX = bez[1] ?? (sx + tx) / 2;
      const baselineY = bez[2] ?? (sy + ty) / 2;
      defaultLabelRef.current = { x: baselineX, y: baselineY };

      // Perp unit:
      const dx = tx - sx;
      const dy = ty - sy;
      const perp = { x: -dy, y: dx };
      const len = Math.hypot(perp.x, perp.y) || 1;
      perpUnitRef.current = { x: perp.x / len, y: perp.y / len };

      // Recompute control from baseline + persistedShift when not actively dragging.
      // This ensures node moves update the baseline and the stored shift is applied
      // relative to the new geometry instead of persisting an absolute screen position.
      if (!draggingRef.current) {
        setControl({
          x: baselineX + perpUnitRef.current.x * persistedShift,
          y: baselineY + perpUnitRef.current.y * persistedShift,
        });
      }
    } catch (_) {
      // ignore; keep previous values
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sx, sy, tx, ty, sourcePos, targetPos, (dataTyped as any)?.shift]);

  // Defensive guard: avoid rendering invalid geometry
  if (![sx, sy, tx, ty].every((v) => Number.isFinite(v))) {
    return null;
  }

  // Build a two-segment path that passes through the handle `control`.
  // We split the original cubic at t=0.5 (De Casteljau) so shift=0 reproduces original curve.
  const buildTwoSegmentCubicThroughHandle = () => {
    try {
      const bez = getBezierPath({
        sourceX: sx,
        sourceY: sy,
        sourcePosition: sourcePos as any,
        targetX: tx,
        targetY: ty,
        targetPosition: targetPos as any,
        curvature: 0.25,
      });
      const pathStr = String(bez[0] || "");

      // Try to parse cubic control points: "M sx,sy C c1x,c1y c2x,c2y tx,ty"
      const cubicMatch = pathStr.match(/C\s*([-\d.]+),([-\d.]+)\s*([-\d.]+),([-\d.]+)\s*([-\d.]+),([-\d.]+)/i);

      let c1 = { x: 0, y: 0 };
      let c2 = { x: 0, y: 0 };

      if (cubicMatch) {
        c1 = { x: Number(cubicMatch[1]), y: Number(cubicMatch[2]) };
        c2 = { x: Number(cubicMatch[3]), y: Number(cubicMatch[4]) };
      } else {
        // Fallback: approximate cubic from quadratic baseline
        const baseline = defaultLabelRef.current;
        const cqx = 2 * baseline.x - 0.5 * (sx + tx);
        const cqy = 2 * baseline.y - 0.5 * (sy + ty);
        c1 = { x: cqx, y: cqy };
        c2 = { x: cqx, y: cqy };
      }

      // De Casteljau split for cubic at t = 0.5
      const P0 = { x: sx, y: sy };
      const P1 = c1;
      const P2 = c2;
      const P3 = { x: tx, y: ty };

      const lerp = (a: { x: number; y: number }, b: { x: number; y: number }, t = 0.5) => ({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
      });

      const A = lerp(P0, P1, 0.5);
      const B = lerp(P1, P2, 0.5);
      const C = lerp(P2, P3, 0.5);

      const D = lerp(A, B, 0.5);
      const E = lerp(B, C, 0.5);

      const Pmid = lerp(D, E, 0.5); // baseline midpoint

      // Current handle position (may differ from Pmid if shifted)
      const P = { x: control.x, y: control.y };

      // Delta from baseline mid to current handle
      const delta = { x: P.x - Pmid.x, y: P.y - Pmid.y };

      // Translate the inner controls adjacent to the join by delta to move the join smoothly.
      const newL2 = { x: D.x + delta.x, y: D.y + delta.y };
      const newR1 = { x: E.x + delta.x, y: E.y + delta.y };

      // Build two cubic segments joined at P
      const leftC1 = A;
      const leftC2 = newL2;
      const rightC1 = newR1;
      const rightC2 = C;

      const path = `M ${P0.x},${P0.y} C ${leftC1.x},${leftC1.y} ${leftC2.x},${leftC2.y} ${P.x},${P.y} C ${rightC1.x},${rightC1.y} ${rightC2.x},${rightC2.y} ${P3.x},${P3.y}`;

      return { path, px: P.x, py: P.y };
    } catch (err) {
      // Fallback to quadratic if something goes wrong
      const fallbackPath = `M ${sx},${sy} Q ${control.x},${control.y} ${tx},${ty}`;
      return { path: fallbackPath, px: control.x, py: control.y };
    }
  };

  const twoSeg = buildTwoSegmentCubicThroughHandle();
  const edgePath = twoSeg.path;
  const labelX = twoSeg.px;
  const labelY = twoSeg.py;

  // Robust client -> graph projection.
  const projectClient = (clientX: number, clientY: number) => {
    try {
      const inst = (window as any).__VG_RF_INSTANCE;
      if (inst && typeof inst.project === "function") {
        return inst.project({ x: clientX, y: clientY });
      }
    } catch (_) {
      // fall through
    }

    try {
      const viewport = document.querySelector(".react-flow__viewport") as HTMLElement | null;
      const containerRect = viewport ? viewport.getBoundingClientRect() : document.body.getBoundingClientRect();
      const x = clientX - containerRect.left;
      const y = clientY - containerRect.top;

      const style = viewport ? viewport.style.transform : "";
      const match = /translate\\((-?\\d+\\.?\\d*)px,\\s*(-?\\d+\\.?\\d*)px\\) scale\\((-?\\d+\\.?\\d*)\\)/.exec(style);
      if (match) {
        const txf = Number(match[1]) || 0;
        const tyf = Number(match[2]) || 0;
        const sc = Number(match[3]) || 1;
        return { x: (x - txf) / sc, y: (y - tyf) / sc };
      }

      return { x, y };
    } catch (_) {
      return { x: clientX, y: clientY };
    }
  };

  const DRAG_THRESHOLD = 5;

  const handlePointerDown = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      lastPointerIdRef.current = e.pointerId;
      pointerStartRef.current = { x: e.clientX, y: e.clientY };

      // Ensure control is initialized from baseline synchronously to avoid jumps.
      try {
        const bez = getBezierPath({
          sourceX: sx,
          sourceY: sy,
          sourcePosition: sourcePos as any,
          targetX: tx,
          targetY: ty,
          targetPosition: targetPos as any,
          curvature: 0.25,
        });
        const baselineX = bez[1] ?? (sx + tx) / 2;
        const baselineY = bez[2] ?? (sy + ty) / 2;
        defaultLabelRef.current = { x: baselineX, y: baselineY };

        const dx = tx - sx;
        const dy = ty - sy;
        const perp = { x: -dy, y: dx };
        const len = Math.hypot(perp.x, perp.y) || 1;
        perpUnitRef.current = { x: perp.x / len, y: perp.y / len };

        if (!controlFixedRef.current) {
          // initialize control immediately so clickOffset uses correct coords
          setControl({
            x: baselineX + perpUnitRef.current.x * persistedShift,
            y: baselineY + perpUnitRef.current.y * persistedShift,
          });
        }
      } catch (_) {
        // ignore
      }

      // store projected start if possible and compute click offset
      try {
        const proj = projectClient(e.clientX, e.clientY);
        pointerStartProjRef.current = { x: proj.x, y: proj.y };
        clickOffsetRef.current = { x: control.x - proj.x, y: control.y - proj.y };
      } catch (_) {
        pointerStartProjRef.current = null;
        clickOffsetRef.current = { x: 0, y: 0 };
      }

      draggingRef.current = false;
      // Allow the initial pointerdown event to propagate so React Flow can process selection.
      // We will stop propagation/prevent default once an actual drag starts in pointermove.
    } catch (_) {
      // ignore
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    try {
      if (lastPointerIdRef.current !== e.pointerId) return;

      const startClient = pointerStartRef.current;
      const dxClient = startClient ? e.clientX - startClient.x : 0;
      const dyClient = startClient ? e.clientY - startClient.y : 0;
      const dist2Client = dxClient * dxClient + dyClient * dyClient;

      let projected = null as any;
      let dist2Proj = 0;
      try {
        projected = projectClient(e.clientX, e.clientY);
        const startProj = pointerStartProjRef.current;
        if (startProj) {
          const dxp = projected.x - startProj.x;
          const dyp = projected.y - startProj.y;
          dist2Proj = dxp * dxp + dyp * dyp;
        }
      } catch (_) {/* noop */}

      const triggered =
        (!draggingRef.current &&
          (dist2Client > DRAG_THRESHOLD * DRAG_THRESHOLD ||
            dist2Proj > (DRAG_THRESHOLD / 2) * (DRAG_THRESHOLD / 2)));

      if (triggered && !draggingRef.current) {
        draggingRef.current = true;
        try {
          // Prefer edge-level callback to notify selection; avoid global fallbacks.
          if (dataTyped && typeof (dataTyped as any).onSelectEdge === "function") {
            (dataTyped as any).onSelectEdge(id);
          }
          selectionRef.current = true;
        } catch (_) {/* noop */}
      }

      if (draggingRef.current) {
        if (!projected) projected = projectClient(e.clientX, e.clientY);
        const offset = clickOffsetRef.current || { x: 0, y: 0 };
        // prevent jump by applying offset and updating control
        setControl({ x: projected.x + offset.x, y: projected.y + offset.y });
        e.preventDefault();
        e.stopPropagation();
      }
    } catch (_) {
      // ignore
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    try {
      if (lastPointerIdRef.current === e.pointerId) {
        try {
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        } catch (_) {/* noop */}
      }
    } catch (_) {/* noop */}

    if (draggingRef.current) {
      // End drag but do not freeze the control as an absolute position. Instead,
      // persist the scalar shift and allow future node moves to recompute the baseline
      // and apply this shift so the label follows geometry changes.
      draggingRef.current = false;
      pointerStartProjRef.current = null;

      const baseline = defaultLabelRef.current;
      const perpUnit = perpUnitRef.current;
      const deltaX = control.x - baseline.x;
      const deltaY = control.y - baseline.y;
      const shift = deltaX * perpUnit.x + deltaY * perpUnit.y;

      try {
        // Persist via the edge-provided callback when available. No global fallback.
        if (dataTyped && typeof (dataTyped as any).onEdgeUpdate === "function") {
          (dataTyped as any).onEdgeUpdate({ id, shift });
        }
      } catch (err) {
        // ignore persistence failures
      }

      // mark selection so next click opens editor
      selectionRef.current = true;
    } else {
      try {
        // Prefer React Flow to manage selection. If this component detects that the edge
        // is not selected, mark a local selection intent so subsequent clicks can open the editor.
        const wasSelected = !!((props as any).selected || (dataTyped && (dataTyped as any).selected));
        if (!wasSelected) {
          selectionRef.current = true;
        }
        // Do NOT open the editor here; KnowledgeCanvas.onEdgeClickStrict implements
        // the select-first / open-second interaction and will open the editor when appropriate.
      } catch (_) {
        // ignore
      }
    }

    lastPointerIdRef.current = null;
    pointerStartRef.current = null;
  };

  // Resolve badge text
  const badgePrimary = String((dataTyped as any)?.propertyPrefixed || (props as any)?.label || "").trim();
  const badgeSecondary = (() => {
    try {
      const v = (dataTyped as any)?.label;
      if (typeof v === "undefined" || v === null) return undefined;
      const s = String(v).trim();
      return s ? s : undefined;
    } catch (_) {
      return undefined;
    }
  })();
  const badgeText = String(badgePrimary || badgeSecondary || "").trim();

  const { edgeStyle, markerEnd, markerSize } = resolveEdgeRenderProps({ id, style, data });
  const finalMarkerEnd =
    (props as any).markerEnd ??
    propMarkerEnd ??
    markerEnd ??
    { type: (MarkerType as any)?.Arrow ?? "arrow" };

  return (
    <>
      <g className={`edge-container ${isHovered ? "vg-edge--hover" : ""} ${isSelected ? "vg-edge--selected" : ""}`} onMouseEnter={onHoverEnter} onMouseLeave={onHoverLeave}>
        <BaseEdge id={id} path={edgePath} markerEnd={finalMarkerEnd} style={edgeStyle} />
      </g>

      <EdgeLabelRenderer>
        <div
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
          }}
          className="edge-label-renderer__custom-edge nodrag nopan pointer-events-auto"
        >
          {badgeText ? (
            <Tooltip delayDuration={250}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="p-0 bg-transparent border-0 pointer-events-auto"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onMouseEnter={onHoverEnter}
                  onMouseLeave={onHoverLeave}
                >
                  <Badge
                    variant={hasEdgeErrors ? "destructive" : "secondary"}
                    className={
                      (
                        hasEdgeErrors
                          ? "text-xs px-2 py-1 shadow-md border cursor-pointer border-destructive text-destructive"
                          : hasEdgeWarnings
                            ? "text-xs px-2 py-1 shadow-md border cursor-pointer bg-amber-100 text-amber-700 border-amber-300"
                            : "text-xs px-2 py-1 shadow-md border cursor-pointer"
                      ) + (isSelected ? " vg-edge--selected" : "")
                    }
                  >
                    <div className="flex flex-col items-center">
                      <div className="leading-tight break-words whitespace-pre-wrap">{badgePrimary || badgeSecondary}</div>
                      {badgeSecondary ? (
                        <div className="text-[10px] leading-tight mt-0.5 opacity-80 break-words whitespace-pre-wrap">{badgeSecondary}</div>
                      ) : null}
                    </div>
                  </Badge>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="space-y-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="text-sm font-semibold text-foreground break-words whitespace-pre-wrap">
                        {String(dataTyped.propertyPrefixed || badgePrimary || "")}
                      </div>
                      {badgeSecondary ? (
                        <div className="text-xs text-muted-foreground break-words mt-1">
                          {String(badgeSecondary)}
                        </div>
                      ) : null}
                      <div className="text-xs text-muted-foreground break-words mt-1">
                        {String(dataTyped.propertyUri || "")}
                      </div>
                    </div>
                    {dataTyped.color ? (
                      <div
                        className="w-6 h-6 rounded-full border"
                        style={{ background: String(dataTyped.color) }}
                        aria-hidden="true"
                      />
                    ) : null}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-1">Source IRI</div>
                      <div className="text-xs text-foreground break-words">{(sourceNode && sourceNode.data && sourceNode.data.iri) ? String(sourceNode.data.iri) : String(source)}</div>
                    </div>

                    <div>
                      <div className="text-xs font-medium text-muted-foreground mb-1">Target IRI</div>
                      <div className="text-xs text-foreground break-words">{(targetNode && targetNode.data && targetNode.data.iri) ? String(targetNode.data.iri) : String(target)}</div>
                    </div>
                  </div>

                  {Array.isArray(dataTyped.reasoningWarnings) && dataTyped.reasoningWarnings.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-amber-600 mb-1">Reasoning warnings</div>
                      <ul className="text-xs text-amber-700 space-y-0.5">
                        {dataTyped.reasoningWarnings.map((w: any, i: number) => (
                          <li key={i} className="break-words whitespace-pre-wrap">{String(w)}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {Array.isArray(dataTyped.reasoningErrors) && dataTyped.reasoningErrors.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-destructive mb-1">Reasoning errors</div>
                      <ul className="text-xs text-destructive space-y-0.5">
                        {dataTyped.reasoningErrors.map((e: any, i: number) => (
                          <li key={i} className="break-words whitespace-pre-wrap">{String(e)}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});

ObjectPropertyEdge.displayName = "ObjectPropertyEdge";

export default ObjectPropertyEdge;
