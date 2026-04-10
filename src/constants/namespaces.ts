export const DEFAULT_NAMESPACE_PREFIX = "";
export const DEFAULT_NAMESPACE_URI = "http://example.com/";

export type NamespaceEntry = { prefix: string; uri: string };

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
