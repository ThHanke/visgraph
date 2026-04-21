export const DEFAULT_NAMESPACE_PREFIX = "";
export const DEFAULT_NAMESPACE_URI = "http://example.com/";

export type NamespaceEntry = { prefix: string; uri: string; namespace?: string; color?: string };

export const DEFAULT_NAMESPACE_ENTRY: NamespaceEntry = {
  prefix: DEFAULT_NAMESPACE_PREFIX,
  uri: DEFAULT_NAMESPACE_URI,
};

export function ensureDefaultNamespaceMap(
  input?: Record<string, string>,
): Record<string, string> {
  if (!input || typeof input !== "object") return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") continue;
    result[String(key ?? "")] = value;
  }
  return result;
}

/** Convert a NamespaceEntry[] to a Record<string,string> for worker protocol. */
export function entriesToRecord(entries: NamespaceEntry[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const e of entries) result[e.prefix] = e.uri;
  return result;
}

/** Convert a Record<string,string> to NamespaceEntry[] */
export function recordToEntries(record: Record<string, string>): NamespaceEntry[] {
  return Object.entries(record).map(([prefix, uri]) => ({ prefix, uri }));
}

/** Normalize a raw entry, accepting either .uri or .namespace for the URI field. */
export function normalizeEntry(e: Record<string, any>): NamespaceEntry {
  const uri = String(e.uri ?? e.namespace ?? "");
  const color = typeof e.color === "string" && e.color.trim() ? e.color.trim() : undefined;
  return { prefix: String(e.prefix ?? ""), uri, namespace: uri, ...(color !== undefined ? { color } : {}) };
}

/**
 * Normalize and validate a registry array, ensuring entries have both uri and namespace fields.
 * Returns at least a default entry if the array is empty.
 */
export function ensureDefaultRegistry(entries: Array<Record<string, any> | NamespaceEntry>): NamespaceEntry[] {
  const arr = Array.isArray(entries) ? entries.map(normalizeEntry) : [];
  if (arr.length === 0) {
    return [{ ...DEFAULT_NAMESPACE_ENTRY, namespace: DEFAULT_NAMESPACE_URI }];
  }
  return arr;
}
