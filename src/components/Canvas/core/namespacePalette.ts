import { useMemo } from 'react';
import { useOntologyStore } from '@/stores/ontologyStore';

/**
 * namespacePalette.ts
 *
 * Centralized, deterministic palette mapping for namespace prefixes/URIs.
 * - Derives colors by hashing the namespace URI (same algorithm as Reactodia
 *   uses internally for element type colors), producing perceptually uniform,
 *   visually distinct colors via the HCL (CIELCh) color space.
 * - Provides colorFromUri(uri) — the core hash-to-color function.
 * - Provides getPalette(prefixes) and buildPaletteMap(prefixes, options) for
 *   backwards-compatible palette maps.
 */

// ---------------------------------------------------------------------------
// Hash helpers (mirrors @reactodia/hashmap internals)
// ---------------------------------------------------------------------------

const COLOR_SEED = 0x0BADBEEF;

/** FNV-1a 32-bit hash */
function hashFnv32a(str: string, seed = 0x811c9dc5): number {
  let hval = seed & 0x7fffffff;
  for (let i = 0; i < str.length; i++) {
    hval ^= str.charCodeAt(i);
    hval += (hval << 1) + (hval << 4) + (hval << 7) + (hval << 8) + (hval << 24);
  }
  return hval >>> 0;
}

function chainHash(hash: number, added: number): number {
  return (Math.imul(hash, 31) + added) | 0;
}

function hashUri(uri: string): number {
  const h = hashFnv32a(uri, COLOR_SEED);
  return chainHash(COLOR_SEED | 0, h);
}

function uriToHue(uri: string): number {
  const hash = hashUri(uri);
  const MAX_INT32 = 0x7fffffff;
  return 360 * (Math.abs(hash) / MAX_INT32);
}

// ---------------------------------------------------------------------------
// HCL (CIELCh) → sRGB conversion
// Matches what d3-color's hcl(hue, chroma, luminance) produces.
// ---------------------------------------------------------------------------

function hclToHex(hDeg: number, c: number, l: number): string {
  // HCL → Lab
  const hRad = (hDeg * Math.PI) / 180;
  const a = Math.cos(hRad) * c;
  const b = Math.sin(hRad) * c;

  // Lab → XYZ (D65)
  const fy = (l + 16) / 116;
  const fx = a / 500 + fy;
  const fz = fy - b / 200;
  const delta = 6 / 29;
  const labF = (t: number) => (t > delta ? t * t * t : 3 * delta * delta * (t - 4 / 29));
  const x = 0.950489 * labF(fx);
  const y = 1.0 * labF(fy);
  const z = 1.08884 * labF(fz);

  // XYZ → linear sRGB
  const rl =  3.2406 * x - 1.5372 * y - 0.4986 * z;
  const gl = -0.9689 * x + 1.8758 * y + 0.0415 * z;
  const bl =  0.0557 * x - 0.2040 * y + 1.0570 * z;

  // Linear sRGB → gamma-compressed sRGB
  const gamma = (v: number) => {
    const c = Math.max(0, Math.min(1, v));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  };

  const r = Math.round(gamma(rl) * 255);
  const g = Math.round(gamma(gl) * 255);
  const b2 = Math.round(gamma(bl) * 255);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b2.toString(16).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Derive a perceptually-uniform, hash-stable color from a namespace URI.
 * Uses the same HCL parameters as Reactodia's internal type-color system:
 * chroma=40, luminance=75.
 */
export function colorFromUri(uri: string): string {
  const hue = uriToHue(uri);
  return hclToHex(hue, 40, 75);
}

/**
 * getPalette(prefixes)
 * - Stable deterministic assignment of hash-derived colors to prefixes.
 * - Each prefix is hashed independently — no cycling, no index dependency.
 */
export function getPalette(prefixes: string[] = []): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of prefixes) {
    map[p] = colorFromUri(p);
  }
  return map;
}

/**
 * Utility: color conversions and small helpers
 */

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const bigint = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return { r, g, b };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const rr = Math.round(r).toString(16).padStart(2, '0');
  const gg = Math.round(g).toString(16).padStart(2, '0');
  const bb = Math.round(b).toString(16).padStart(2, '0');
  return `#${rr}${gg}${bb}`.toUpperCase();
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: h * 360, s, l };
}

export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  h = ((h % 360) + 360) % 360;
  h /= 360;
  if (s === 0) {
    const v = l * 255;
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue2rgb = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const r = hue2rgb(p, q, h + 1 / 3) * 255;
  const g = hue2rgb(p, q, h) * 255;
  const b = hue2rgb(p, q, h - 1 / 3) * 255;
  return { r, g, b };
}

/**
 * colorDistanceRgbNormalized
 * - computes Euclidean distance between two RGB colors in [0,1] space.
 * - useful for "are these colors visually too close" checks.
 */
function colorDistanceRgbNormalized(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }): number {
  const dr = a.r / 255 - b.r / 255;
  const dg = a.g / 255 - b.g / 255;
  const db = a.b / 255 - b.b / 255;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * adjustColorAwayFromList
 * - Given an initial hex color, and a list of avoid-hex colors, attempts to
 *   nudge the initial color in hue/lightness until its distance to every
 *   avoid color is >= threshold.
 *
 * - Returns a (possibly) adjusted hex string. This method is intentionally
 *   conservative and only slightly perturbs colors to preserve the base palette.
 */
function adjustColorAwayFromList(hex: string, avoidHexes: string[], threshold = 0.18): string {
  if (!avoidHexes || avoidHexes.length === 0) return hex;
  const srcRgb = hexToRgb(hex);
  const avoidRgbs = avoidHexes.map(hexToRgb);
  const { h, s, l } = rgbToHsl(srcRgb.r, srcRgb.g, srcRgb.b);

  // Quick check - if already far enough, return original.
  const tooClose = avoidRgbs.some(a => colorDistanceRgbNormalized(srcRgb, a) < threshold);
  if (!tooClose) return hex;

  // Try perturbing hue in small steps, then lightness if necessary.
  const maxHueSteps = 9;
  const hueStep = 20; // degrees
  for (let i = 1; i <= maxHueSteps; i++) {
    const testH = (h + i * hueStep) % 360;
    const rgb = hslToRgb(testH, s, l);
    const distOk = avoidRgbs.every(a => colorDistanceRgbNormalized(rgb, a) >= threshold);
    if (distOk) return rgbToHex(rgb.r, rgb.g, rgb.b);
    const testH2 = (h - i * hueStep + 360) % 360;
    const rgb2 = hslToRgb(testH2, s, l);
    const distOk2 = avoidRgbs.every(a => colorDistanceRgbNormalized(rgb2, a) >= threshold);
    if (distOk2) return rgbToHex(rgb2.r, rgb2.g, rgb2.b);
  }

  // If hue shifting didn't help, nudge lightness up / down slightly.
  const lightnessDeltas = [0.06, -0.06, 0.12, -0.12];
  for (const dl of lightnessDeltas) {
    const newL = clamp01(l + dl);
    const rgb = hslToRgb(h, s, newL);
    if (avoidRgbs.every(a => colorDistanceRgbNormalized(rgb, a) >= threshold)) {
      return rgbToHex(rgb.r, rgb.g, rgb.b);
    }
  }

  // Last resort: return original hex (should be rare) to avoid overchanging palette.
  return hex;
}

/**
 * buildPaletteMap
 * - prefixes: array of prefix strings
 * - options:
 *    avoidColors?: string[]  // hex strings to avoid (e.g. theme text colors)
 *    threshold?: number      // rgb distance threshold to consider "too close"
 *
 * - Returns: Record<prefix, colorHex>
 *
 * Both legend and canvas should use this function so they share the exact mapping.
 * The legend will typically use the raw mapped color; canvas node fill can darken
 * the color further for readability (done elsewhere).
 */
export function buildPaletteMap(prefixes: string[] = [], options?: { avoidColors?: string[]; threshold?: number }): Record<string, string> {
  const base = getPalette(prefixes);
  const avoid = (options && options.avoidColors) || [];
  const threshold = (options && options.threshold) || 0.18;
  if (!avoid || avoid.length === 0) return base;

  const adjusted: Record<string, string> = {};
  for (const p of Object.keys(base)) {
    const original = base[p];
    const safe = adjustColorAwayFromList(original, avoid, threshold);
    adjusted[p] = safe;
  }
  return adjusted;
}

/**
 * Example helper used by components:
 *
 * import { buildPaletteMap } from './core/namespacePalette';
 *
 * const textColors = [
 *   getComputedStyle(document.documentElement).getPropertyValue('--node-foreground') || '#000000',
 *   getComputedStyle(document.documentElement).getPropertyValue('--primary-foreground') || '#000000'
 * ];
 *
 * const paletteMap = buildPaletteMap(prefixesArray, { avoidColors: textColors });
 *
 * The ResizableNamespaceLegend and the  canvas should consume the same
 * paletteMap so there's no mismatch or fallback behavior.
 */


/**
 * Hook: usePaletteFromRdfManager
 *
 * Small helper hook that components can call to obtain a stable prefix -> color map
 * derived from the RDF manager's registered namespaces. It is memoized on rdfManager
 * identity and ontologiesVersion so callers can synchronously use the returned map
 * during render without triggering extra work.
 */
export function usePaletteFromRdfManager() {
  // NOTE: this hook used to derive palette from the RDF manager's namespaces.
  // Per recent refactor, namespace colors are now persisted into the ontology
  // store as `namespaceRegistry`. This hook now returns a stable prefix->color
  // mapping derived from that registry, making it the single source of truth.
  const registry = useOntologyStore((s) => (Array.isArray(s.namespaceRegistry) ? s.namespaceRegistry : []));
  // Recompute palette when registry changes.
  return useMemo(() => {
    try {
      const map: Record<string,string> = {};
      (registry || []).forEach((entry: any) => {
        try {
          if (!entry || entry.prefix === undefined || entry.prefix === null) return;
          const p = String(entry.prefix);
          const colorValue = entry && entry.color !== undefined && entry.color !== null ? String(entry.color) : "";
          map[p] = colorValue;
        } catch (_) { void 0; }
      });
      return map;
    } catch (_) {
      return {};
    }
  }, [registry]);
}
