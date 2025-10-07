import initializeEdge from "./edgeStyle";

/**
 * createEdge
 *
 * Thin wrapper kept for backward compatibility. Delegates to initializeEdge
 * which applies canonical style and marker defaults.
 */
export default function createEdge(raw: any) {
  return initializeEdge(raw);
}
