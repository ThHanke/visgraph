/**
 * Palette / badge helpers for Canvas
 *
 * Small pure helpers to encapsulate namespace extraction and palette lookup logic.
 * Moving these into a helper module lets components import them without exporting
 * non-component values from the same file (avoids react-refresh warnings).
 */

/**
 * Derive a namespace prefix from available sources.
 * Priority:
 *  - infoNamespace (resolved from computeDisplayInfoMemo)
 *  - explicit nodeNamespace
 *  - if badge contains "prefix:Local", return the prefix
 *
 * Returns empty string when none found.
 */
export function deriveNamespaceFromInfo(badge?: string, infoNamespace?: string, nodeNamespace?: string): string {
  if (infoNamespace && typeof infoNamespace === 'string' && infoNamespace.length > 0) return infoNamespace;
  if (nodeNamespace && typeof nodeNamespace === 'string' && nodeNamespace.length > 0) return nodeNamespace;
  if (badge && typeof badge === 'string' && badge.includes(':')) {
    const parts = String(badge).split(':');
    if (parts && parts.length > 1) return parts[0];
  }
  return '';
}

/**
 * Lookup color from palette with a few tolerant fallbacks.
 * - Try the raw nsKey
 * - Try stripped nsKey (remove :, # and suffixes)
 * - Try a fallback empty-key in palette
 * - Return a provided fallback color if nothing matches
 */
export function getColorFromPalette(palette: Record<string,string> | undefined, nsKey?: string, fallback = '#64748b'): string {
  if (!palette || typeof palette !== 'object') return fallback;
  const key = nsKey == null ? '' : String(nsKey);

  // direct
  if (key && (palette as any)[key]) return (palette as any)[key];

  // stripped of : or # and any trailing text
  const stripped = key.replace(new RegExp('[:#].*$'), '');
  if (stripped && (palette as any)[stripped]) return (palette as any)[stripped];

  // try with trailing colon
  if (key && !key.endsWith(':') && (palette as any)[`${key}:`]) return (palette as any)[`${key}:`];

  // empty key fallback
  if ((palette as any)['']) return (palette as any)[''];

  return fallback;
}
