export const DEFAULT_NAMESPACE_PREFIX = "";
export const DEFAULT_NAMESPACE_URI = "http://example.com/";

export type NamespaceRegistryEntry = {
  prefix: string;
  namespace: string;
  color?: string;
};

export const DEFAULT_NAMESPACE_ENTRY: NamespaceRegistryEntry = {
  prefix: DEFAULT_NAMESPACE_PREFIX,
  namespace: DEFAULT_NAMESPACE_URI,
  color: "",
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

export function ensureDefaultRegistry(
  registry?: NamespaceRegistryEntry[],
): NamespaceRegistryEntry[] {
  if (!Array.isArray(registry)) return [];
  return registry.map((entry) => ({
    prefix: String(entry?.prefix ?? ""),
    namespace: String(entry?.namespace ?? ""),
    color: entry?.color !== undefined && entry?.color !== null ? String(entry.color) : "",
  }));
}
