import canonicalId from "../../../lib/canonicalId";
import { NamedNode } from "n3";
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { RDFManager } from "../../../utils/rdfManager";
import { computeTermDisplay, shortLocalName } from "../../../utils/termUtils";
import type { NodeData, LinkData } from "../../../types/canvas";

/**
 * Mapping helpers
 *
 * These helpers contain the pure logic for turning the canonical graph (used
 * across the app) into React Flow nodes + edges. The goal is to make the
 * mapping deterministic and easy to unit test.
 *
 * Functions:
 * - mapGraphToDiagram(graph, opts) => { nodes: RFNode<NodeData>[], edges: RFEdge<LinkData>[] }
 *
 * The mapping attempts to be conservative: it prefers information present on
 * the parsed canonical node (iri, rdfTypes, namespace) but will consult the
 * RDF manager (if supplied) to expand/resolve prefix forms when needed.
 *
 * Options:
 * - getRdfManager?: () => RDFManager | undefined
 * - availableClasses?: Array<{ iri: string; label?: string; namespace?: string }>
 * - getEntityIndex?: () => { mapByIri?: Map<string, any>, mapByLocalName?: Map<string, any> } | undefined
 * - viewMode?: "abox" | "tbox"  (used by callers to filter results; mapping returns all nodes/edges)
 *
 * Note: layout/position decisions are left to the caller (ReactFlowCanvas). This module
 * provides node.position when available on the canonical node, otherwise no position.
 */

/* Minimal defensive typing for the canonical graph shape used by the app */
type CanonicalNode = any;
type CanonicalEdge = any;

export interface MapOptions {
  getRdfManager?: (() => RDFManager | undefined) | undefined;
  availableClasses?: Array<{ iri: string; label?: string; namespace?: string }>;
  getEntityIndex?: (() => { mapByIri?: Map<string, any>; mapByLocalName?: Map<string, any> } | undefined) | undefined;
}

/**
 * Build a React Flow NodeData payload from a canonical node.
 * - canonicalNode: parsed/diagram node with possible fields like iri, rdfTypes, namespace, classType, label, literalProperties, annotationProperties
 * - rdfManager: optional manager used to expand/contract prefixes
 */
export function buildNodeDataFromParsedNode(
  canonicalNode: CanonicalNode,
  rdfManager?: RDFManager | undefined,
  availableClasses?: Map<string, any> | Array<{iri:string}> | undefined
): NodeData {
  const src = canonicalNode || {};
  // resolve rdf types array
  const rdfTypesArr: string[] = Array.isArray(src.rdfTypes)
    ? src.rdfTypes.map(String).filter(Boolean)
    : [];

  // Compute a friendly label
  let computedLabel = "";
  try {
    if (src.label) {
      computedLabel = String(src.label);
    } else if (src.classType) {
      computedLabel = String(src.classType);
    } else if (src.iri) {
      computedLabel = shortLocalName(String(src.iri));
    } else {
      computedLabel = shortLocalName(String(src.id || src.key || ""));
    }
  } catch (_) {
    computedLabel = String(src.iri || src.id || src.key || "");
  }

  // Determine if this is a TBox entity by inspecting types
  const isTBoxEntity = rdfTypesArr.some((type: string) =>
    String(type).includes("Class") ||
    String(type).includes("ObjectProperty") ||
    String(type).includes("AnnotationProperty") ||
    String(type).includes("DatatypeProperty")
  );

  const canonicalNodeIri = src.iri ?? src.id ?? src.key ?? "";

  const nodeData: NodeData = {
    key: canonicalId(String(src.iri || src.id || src.key || "")),
    iri: canonicalNodeIri,
    rdfTypes: rdfTypesArr,
    label: computedLabel,
    namespace: String(src.namespace || ""),
    classType: src.classType,
    literalProperties: src.literalProperties || [],
    annotationProperties: src.annotationProperties || [],
    visible: true,
    hasReasoningError: !!src.hasReasoningError,
    isTBox: !!isTBoxEntity,
  };

  return nodeData;
}

/**
 * Convert canonical nodes array to React Flow nodes (pure)
 *
 * - canonicalNodes: array of parsed nodes from the canvas/currentGraph
 * - options.getRdfManager: optional getter for RDFManager to resolve prefixes when needed
 * - options.getEntityIndex: optional function returning an index used to derive namespace keys
 *
 * The function returns an array of RFNode<NodeData>. It does not set layout/positions
 * beyond any position present on the canonical node (caller may apply layout).
 */
export function mapCanonicalToRFNodes(
  canonicalNodes: CanonicalNode[] = [],
  options?: MapOptions
): RFNode<NodeData>[] {
  const mgr = options && typeof options.getRdfManager === "function" ? options.getRdfManager() : undefined;
  const entityIndexGetter = options && typeof options.getEntityIndex === "function" ? options.getEntityIndex : undefined;
  const availableClasses = options && options.availableClasses ? options.availableClasses : undefined;

  const nodes: RFNode<NodeData>[] = [];

  for (let i = 0; i < (canonicalNodes || []).length; i++) {
    const node = canonicalNodes[i];
    const src = node && node.data ? node.data : node;

    // Build node data (pure)
    const nd = buildNodeDataFromParsedNode(src, mgr as any, availableClasses as any);

    // Resolve a namespace key for palette lookups using entity index if available
    let canonicalNs = "";
    try {
      const idx = entityIndexGetter ? entityIndexGetter() : undefined;
      const mapByIri = (idx && idx.mapByIri) ? idx.mapByIri : new Map();
      const mapByLocal = (idx && idx.mapByLocalName) ? idx.mapByLocalName : new Map();

      if (nd.iri) {
        const byIri = mapByIri.get(nd.iri);
        const byLocal = mapByLocal.get(nd.iri);
        const byShort = mapByLocal.get(shortLocalName(nd.iri));
        const ent = byIri || byLocal || byShort;
        if (ent && ent.namespace) canonicalNs = String(ent.namespace);
      }
    } catch (_) {
      canonicalNs = "";
    }

    const id = canonicalId(nd.iri || nd.key || `n-${i}`);
    const pos = (node && node.position) || (src && src.position) || undefined;

    nodes.push({
      id,
      type: "ontology",
      position: pos ? { x: pos.x, y: pos.y } : { x: 0, y: 0 },
      data: {
        ...nd,
        onSizeMeasured: (w: number, h: number) => {
          // caller will replace nodes via setNodes; provide a hook with the same shape
          // The actual update is done in ReactFlowCanvas where setNodes is available.
          try {
            if (typeof (src as any).onSizeMeasured === "function") {
              (src as any).onSizeMeasured(w, h);
            }
          } catch (_) { /* ignore */ }
        },
      } as NodeData,
      style: { ["--node-leftbar-color" as any]: `hsl(var(--ns-${(canonicalNs || src.namespace || "").replace(/[:#].*$/, "") || "default"}))` },
    });
  }

  return nodes;
}

/**
 * Convert canonical edges array to React Flow edges (pure)
 *
 * - canonicalEdges: array of parsed edges from currentGraph
 * - nodesPresent: Set of node ids that exist on the canvas (to filter edges)
 *
 * Returns: RFEdge<LinkData>[]
 */
export function mapCanonicalToRFEdges(
  canonicalEdges: CanonicalEdge[] = [],
  nodesPresent: Set<string> = new Set()
): RFEdge<LinkData>[] {
  const edges: RFEdge<LinkData>[] = [];

  for (let j = 0; j < (canonicalEdges || []).length; j++) {
    const edge = canonicalEdges[j];
    const src = edge && edge.data ? edge.data : edge;

    const from = canonicalId(String(src.source || src.from || ""));
    const to = canonicalId(String(src.target || src.to || ""));

    // Skip if endpoints missing on canvas
    if (!nodesPresent.has(String(from)) || !nodesPresent.has(String(to))) continue;

    const id = canonicalId(src.id || `e-${from}-${to}-${j}`);

    const propertyUriRaw = src.propertyUri || src.propertyType || "";

    const labelForEdge = src.label || "";

    edges.push({
      id,
      source: String(from),
      target: String(to),
      type: "floating",
      markerEnd: { type: "arrow" as any },
      data: {
        key: id,
        from: String(from),
        to: String(to),
        propertyUri: propertyUriRaw,
        propertyType: src.propertyType || "",
        label: labelForEdge,
        namespace: src.namespace || "",
        rdfType: src.rdfType || "",
      } as LinkData,
    });
  }

  return edges;
}

/**
 * Convenience: map whole graph -> { nodes, edges }
 */
export function mapGraphToDiagram(
  graph: { nodes?: CanonicalNode[]; edges?: CanonicalEdge[] } | undefined,
  options?: MapOptions
): { nodes: RFNode<NodeData>[]; edges: RFEdge<LinkData>[] } {
  const cg = graph || { nodes: [], edges: [] };
  const mappedNodes = mapCanonicalToRFNodes(cg.nodes || [], options);
  const nodeIds = new Set(mappedNodes.map((n) => n.id));
  const mappedEdges = mapCanonicalToRFEdges(cg.edges || [], nodeIds);
  return { nodes: mappedNodes, edges: mappedEdges };
}
