import { MarkerType } from "@xyflow/react";

/**
 * edgeStyle helpers
 *
 * - initializeEdge(raw): returns a new edge object with canonical style and markerEnd defaults applied.
 * - resolveEdgeRenderProps({ id, style, data }): returns render-time props for renderers:
 *     { edgeStyle, safeMarkerId, markerUrl, markerSize }
 * - safeMarkerIdFromEdgeId(edgeId) and getMarkerSizeFromCss(defaultPx)
 *
 * Notes:
 * - All functions are pure and do not mutate inputs.
 * - CSS vars are authoritative: --edge-default, --edge-width, --edge-marker-size.
 * - Markers use fill="currentColor" so the per-edge svg color controls marker color.
 */

export type MarkerDef = {
  type?: string;
  width?: number;
  height?: number;
  color?: string;
  [k: string]: any;
};

export function initializeEdge(raw: any) {
  if (!raw || typeof raw !== "object") return raw;

  const style = raw.style || {};
  const data = raw.data || {};

  // Defaults intentionally use CSS vars so theming can change at runtime.
  const defaultsStyle = {
    stroke: "var(--edge-default)",
    strokeWidth: "var(--edge-width)",
  };

  const mergedStyle = { ...defaultsStyle, ...(style || {}) };

  // Marker color should follow the resolved stroke/color on the style when possible.
  const markerColor = (mergedStyle && ((mergedStyle as any).stroke || (mergedStyle as any).color)) || "var(--edge-default)";

  const defaultMarker: MarkerDef = {
    type: (MarkerType as any)?.Arrow ?? "arrow",
    width: 20,
    height: 20,
    // Keep the theme var exact (no fallbacks) for easier debugging at runtime.
    color: markerColor,
  };

  return {
    ...raw,
    style: mergedStyle,
    markerEnd: raw.markerEnd || defaultMarker,
    data: { ...(data || {}), ...(raw.data || {}) },
  };
}

export function safeMarkerIdFromEdgeId(edgeId?: string | number) {
  const id = String(edgeId || "");
  // sanitize to a safe DOM id fragment (lowercase, alnum, -, _)
  return `vg-arrow-${id.replace(/[^a-z0-9\\-_]/gi, "-")}`;
}

export function getMarkerSizeFromCss(defaultPx = 6) {
  try {
    if (typeof window !== "undefined" && typeof getComputedStyle === "function") {
      const raw = String(getComputedStyle(document.documentElement).getPropertyValue("--edge-marker-size") || "").trim();
      if (raw) {
        const pxMatch = raw.match(/^(\d+(\.\d+)?)px$/);
        const numMatch = raw.match(/^(\d+(\.\d+)?)$/);
        if (pxMatch) return Number(pxMatch[1]);
        if (numMatch) return Number(numMatch[1]);
        // Complex CSS functions (oklch/hsl) - fall back to numeric default and rely on currentColor for color fidelity.
        return defaultPx;
      }
    }
  } catch (_) {
    // ignore
  }
  return defaultPx;
}

export function resolveEdgeRenderProps(opts: { id?: string | number; style?: any; data?: any }) {
  const { id, style, data } = opts || {};
  const mergedStyle = style || {};

  const edgeStyle = {
    ...(mergedStyle || {}),
    // The actual SVG stroke attribute uses currentColor so markers using currentColor
    // inherit the same color. The color token is placed on the parent svg element.
    stroke: "currentColor",
    strokeWidth: (mergedStyle && (mergedStyle as any).strokeWidth) || (data && (data as any).thickness) || "var(--edge-width)",
    fill: "none",
    // color acts as the CSS color for the svg so currentColor resolves to this value.
    color: (mergedStyle && (mergedStyle as any).stroke) || (mergedStyle && (mergedStyle as any).color) || "var(--edge-default)",
    strokeLinecap: "round" as any,
    strokeLinejoin: "round" as any,
  };

  const safeMarkerId = safeMarkerIdFromEdgeId(id);
  const markerUrl = `url(#${safeMarkerId})`;
  const markerSize = getMarkerSizeFromCss(6);

  return { edgeStyle, safeMarkerId, markerUrl, markerSize };
}

export default initializeEdge;
