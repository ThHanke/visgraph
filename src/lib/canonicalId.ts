/**
 * canonicalId.ts
 *
 * Small helper utilities to produce a stable, deterministic identifier for nodes/edges
 * used across React Flow and the RDF store. Aim:
 * - Prefer full HTTP(S) URIs (keep them unchanged so RDF lookups remain straightforward)
 * - For non-URI identifiers (keys, local ids), produce a safe, deterministic string
 *   that can be used as React Flow node.id and edge endpoints.
 *
 * Notes:
 * - This intentionally returns the full URI when provided so persistence to the RDF store
 *   can use the original URI. For UI ids we reuse the same string.
 * - The safeId() function replaces characters that are unsafe in HTML ids or React Flow ids
 *   with underscores. It preserves readability while ensuring stability.
 */

export function isHttpUri(v: string): boolean {
  return /^https?:\/\/.+/i.test(v);
}

/**
 * canonicalId
 * Prefer a full HTTP(S) URI if present, otherwise return a safe string derived from the input.
 * Always returns a non-empty string (falling back to an encoded timestamp when input is missing).
 */
export function canonicalId(value?: string | null): string {
  if (!value) {
    // fallback deterministic-ish id (should rarely be used)
    return `id_${Date.now()}`;
  }
  const s = String(value).trim();
  if (s.length === 0) return `id_${Date.now()}`;
  if (isHttpUri(s)) return s;
  return safeId(s);
}

/**
 * safeId
 * Replace any characters outside [A-Za-z0-9_-] with underscores.
 * Collapse repeated underscores and trim leading/trailing underscores.
 */
export function safeId(value: string): string {
  const replaced = value.replace(/[^A-Za-z0-9_-]/g, '_');
  // collapse repeated underscores
  const collapsed = replaced.replace(/_+/g, '_');
  return collapsed.replace(/^_+|_+$/g, '') || `id_${Date.now()}`;
}

export default canonicalId;
