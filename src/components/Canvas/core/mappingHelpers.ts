import { DataFactory, NamedNode } from "n3";
const { namedNode } = DataFactory;
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
  // Resolve rdf types conservatively and strictly (produce only full IRIs).
  // - Start from parsed node rdfTypes if present.
  // - If none present, query the RDF store for rdf:type triples.
  // - From the collected candidates, only keep absolute IRIs or prefixed forms that
  //   can be expanded by rdfManager.expandPrefix. Do NOT accept bare local names.
  let rdfTypesCandidates: string[] = Array.isArray(src.rdfTypes)
    ? src.rdfTypes.map(String).filter(Boolean)
    : [];

  try {
    // If no parsed candidates, probe the store for rdf:type triples
    if ((!rdfTypesCandidates || rdfTypesCandidates.length === 0) && rdfManager && typeof rdfManager.getStore === "function") {
      try {
        const store = rdfManager.getStore();
        const subjectUri = String(src.iri || src.id || src.key || "");
        if (subjectUri && store && typeof store.getQuads === "function") {
          const rdfTypePredicate =
            typeof (rdfManager as any).expandPrefix === "function"
              ? String((rdfManager as any).expandPrefix("rdf:type"))
              : "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

          let typeQuads = store.getQuads(namedNode(subjectUri), namedNode(rdfTypePredicate), null, null) || [];

          // Try common http/https variants if direct lookup returned nothing
          if ((!typeQuads || typeQuads.length === 0) && subjectUri) {
            const altSubjects = [`http:${subjectUri}`, `https:${subjectUri}`];
            for (const s of altSubjects) {
              try {
                const found = store.getQuads(namedNode(s), namedNode(rdfTypePredicate), null, null) || [];
                if (found && found.length > 0) {
                  typeQuads = found;
                  break;
                }
              } catch (_) { /* ignore */ }
            }
          }

          if (typeQuads && typeQuads.length > 0) {
            rdfTypesCandidates = Array.from(
              new Set(typeQuads.map((q: any) => (q.object && q.object.value) || "").filter(Boolean)),
            );
          }
        }
      } catch (_) {
        /* ignore store lookup failures */
      }
    }
  } catch (_) {
    /* ignore outer failures */
  }

  // Expand/normalize candidates into strict full IRIs.
  const rdfTypesArr: string[] = [];
  try {
    for (const t of rdfTypesCandidates) {
      try {
        const ts = String(t || "");
        if (!ts) continue;
        // Already an absolute IRI — keep it.
        if (/^https?:\/\//i.test(ts)) {
          rdfTypesArr.push(ts);
          continue;
        }
        // If looks like a prefixed name and rdfManager can expand, try expansion.
        if (ts.includes(":") && rdfManager && typeof (rdfManager as any).expandPrefix === "function") {
          try {
            const expanded = (rdfManager as any).expandPrefix(ts);
            if (expanded && /^https?:\/\//i.test(String(expanded))) {
              rdfTypesArr.push(String(expanded));
              continue;
            }
          } catch (_) {
            // expansion failed — skip this candidate (do not synthesize)
          }
        }
        // Bare local names: intentionally ignored here (strict policy)
      } catch (_) {
        /* ignore per-candidate */
      }
    }
  } catch (_) {
    /* ignore normalization failures */
  }

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
  // Keep TBox detection conservative: only types that look like class/property constructs.
  const isTBoxEntity = Array.isArray(rdfTypesArr) && rdfTypesArr.some((type: string) =>
    String(type).includes("Class") ||
    String(type).includes("ObjectProperty") ||
    String(type).includes("AnnotationProperty") ||
    String(type).includes("DatatypeProperty")
  );

  const canonicalNodeIri = src.iri ?? src.id ?? src.key ?? "";

  // Compute display classType/namespace from resolved rdfTypes when available.
  // Prefer a prefixed form from computeTermDisplay (e.g., 'owl:Class') for display.
  // Special rule: for ABox (instance) nodes, prefer the first rdf:type that is NOT owl:NamedIndividual.
  let displayClassType = src.classType;
  let displayNamespace = String(src.namespace || "");
  try {
    if (Array.isArray(rdfTypesArr) && rdfTypesArr.length > 0) {
      try {
        // Choose which rdf:type IRI to use for display.
        // Default to the first available type.
        let selectedTypeIri: string | undefined = rdfTypesArr[0];

        // If this node is an ABox node (not TBox), prefer the first rdf:type that is not owl:NamedIndividual.
        // This restores previous behavior where instances show their meaningful class instead of NamedIndividual.
        try {
          if (!isTBoxEntity) {
            const namedIndividualIri = "http://www.w3.org/2002/07/owl#NamedIndividual";
            const nonNamed = rdfTypesArr.find((t: string) => {
              try {
                return String(t).trim() !== String(namedIndividualIri);
              } catch (_) {
                return false;
              }
            });
            if (nonNamed) selectedTypeIri = nonNamed;
          }
        } catch (_) {
          // ignore selection errors and fall back to first type
        }

        if (selectedTypeIri && rdfManager) {
          try {
            const td = computeTermDisplay(String(selectedTypeIri), rdfManager as any);
            if (td) {
              displayClassType = td.prefixed || td.short || displayClassType;
              displayNamespace = td.namespace !== undefined ? String(td.namespace) : displayNamespace;
            }
          } catch (_) {
            // keep existing displayClassType/namespace if computeTermDisplay fails
          }
        }
      } catch (_) {
        /* ignore */
      }
    }
  } catch (_) { /* ignore */ }

  const nodeData: NodeData = {
    key: String(src.iri || src.id || src.key || ""),
    iri: canonicalNodeIri,
    rdfTypes: rdfTypesArr,
    label: computedLabel,
    namespace: displayNamespace,
    classType: displayClassType,
    literalProperties: src.literalProperties || [],
    annotationProperties: src.annotationProperties || [],
    // default visible true; mapping layer may override based on data-graph membership
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

    if (!nd.iri) {
      // Skip nodes that do not expose a full IRI — nodes must have an IRI.
      continue;
    }
    const id = String(nd.iri);
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
      style: undefined,
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

    const from = String(src.source || src.from || "");
    const to = String(src.target || src.to || "");

    // Skip if endpoints missing on canvas
    if (!nodesPresent.has(String(from)) || !nodesPresent.has(String(to))) continue;

    const id = String(src.id || `e-${from}-${to}-${j}`);

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
  const mgr = options && typeof options.getRdfManager === "function" ? options.getRdfManager() : undefined;

  // Build a quick map of node key -> iri from the canonical graph so we can
  // resolve edge endpoints to IRIs for data-graph visibility computation.
  const nodeKeyToIri = new Map<string, string>();
  try {
    (cg.nodes || []).forEach((n: any) => {
      const src = n && n.data ? n.data : n;
      const iri = (src && (src.iri || (src.data && src.data.iri))) || src.iri || src.id || "";
      const key = n.id || String(iri || "");
      if (key) nodeKeyToIri.set(String(key), String(iri || ""));
    });
  } catch (_) {
    /* ignore index build failures */
  }

  // Compute the set of subject IRIs present in the data graph (urn:vg:data)
  const dataSubjectsSet = new Set<string>();
  try {
    if (mgr && typeof mgr.getStore === "function") {
      const store = mgr.getStore();
      if (store && typeof store.getQuads === "function") {
        try {
          const g = namedNode("urn:vg:data");
          const dq = store.getQuads(null, null, null, g) || [];
          dq.forEach((q: any) => {
            try {
              if (q && q.subject && q.subject.value) dataSubjectsSet.add(String(q.subject.value));
            } catch (_) { /* ignore */ }
          });
        } catch (_) { /* ignore store read errors */ }
      }
    }
  } catch (_) {
    /* ignore rdfManager errors */
  }

  // Compute visible IRIs: subjects in data graph plus targets of edges whose source is a data-subject.
  const visibleIris = new Set<string>();
  try {
    // Add direct subjects
    for (const s of Array.from(dataSubjectsSet)) visibleIris.add(s);

    // For each edge, if its source resolves to an IRI in dataSubjectsSet, add the target IRI.
    (cg.edges || []).forEach((e: any) => {
      try {
        const edgeSrcKey = e.source || (e.data && e.data.source) || "";
        const edgeTgtKey = e.target || (e.data && e.data.target) || "";
        const srcIri = nodeKeyToIri.get(String(edgeSrcKey)) || "";
        const tgtIri = nodeKeyToIri.get(String(edgeTgtKey)) || "";
        if (srcIri && dataSubjectsSet.has(String(srcIri))) {
          if (tgtIri) visibleIris.add(String(tgtIri));
        }
      } catch (_) { /* ignore per-edge */ }
    });
  } catch (_) {
    /* ignore visibility computation errors */
  }

  // Map nodes using existing helper (this will consult RDF manager for missing rdfTypes)
  const mappedNodes = mapCanonicalToRFNodes(cg.nodes || [], options);
  const nodeIds = new Set(mappedNodes.map((n) => n.id));

  // Resolve edges to use node IRIs (not legacy/canonical numeric keys).
  // Build mappedEdges by resolving each canonical edge's raw endpoint refs to the node IRI
  // using the nodeKeyToIri index built above. This restores the invariant that React Flow
  // node ids are IRIs and edges use those IRIs as source/target.
  const mappedEdges: RFEdge<LinkData>[] = [];
  try {
    for (let j = 0; j < (cg.edges || []).length; j++) {
      const edge = cg.edges[j];
      const src = edge && edge.data ? edge.data : edge;

      // Raw refs may be under different properties depending on producer
      const rawFromRef = String(src.source || src.from || (src.data && src.data.source) || "");
      const rawToRef = String(src.target || src.to || (src.data && src.data.target) || "");

      // Resolve raw refs to IRIs using the canonical graph index (nodeKeyToIri).
      // If no mapping exists, fall back to the raw ref (preserves previous behavior).
      const resolvedFromIri = nodeKeyToIri.get(rawFromRef) || rawFromIriOrFallback(rawFromRef);
      const resolvedToIri = nodeKeyToIri.get(rawToRef) || rawFromIriOrFallback(rawToRef);

      // Skip if endpoints missing on canvas (nodeIds contains mappedNodes' ids which are IRIs)
      if (!nodeIds.has(String(resolvedFromIri)) || !nodeIds.has(String(resolvedToIri))) continue;

      const id = String(src.id || `e-${resolvedFromIri}-${resolvedToIri}-${j}`);
      const propertyUriRaw = src.propertyUri || src.propertyType || "";
      const labelForEdge = src.label || "";

      mappedEdges.push({
        id,
        source: String(resolvedFromIri),
        target: String(resolvedToIri),
        type: "floating",
        markerEnd: { type: "arrow" as any },
        data: {
          key: id,
          from: String(resolvedFromIri),
          to: String(resolvedToIri),
          propertyUri: propertyUriRaw,
          propertyType: src.propertyType || "",
          label: labelForEdge,
          namespace: src.namespace || "",
          rdfType: src.rdfType || "",
        } as LinkData,
      });
    }
  } catch (_) {
    /* ignore edge mapping failures */
  }

  // Helper: attempt to coerce a raw reference to a plausible IRI when no explicit mapping found.
  // Keep this conservative: do not mutate canonical graph, just try simple http/https prefix variants.
  function rawFromIriOrFallback(ref: string) {
    try {
      if (!ref) return ref;
      if (/^https?:\/\//i.test(ref)) return ref;
      // try adding common scheme if it looks like an absolute authority path missing scheme
      if (ref.startsWith("//")) return "https:" + ref;
      // otherwise, return the original ref unchanged (do not modify canonical data)
      return ref;
    } catch (_) {
      return ref;
    }
  }

  // Apply computed visibility to node data where possible (prefer explicit visible flag if set)
  try {
    mappedNodes.forEach((n) => {
      try {
        const iri = n.data && (n.data as any).iri ? String((n.data as any).iri) : "";
        if (iri) {
          n.data = { ...(n.data as any), visible: visibleIris.has(iri) };
        } else {
          // if no IRI, preserve existing visibility
          n.data = { ...(n.data as any) };
        }
      } catch (_) {
        /* ignore per-node */
      }
    });
  } catch (_) {
    /* ignore */
  }

  // Emit a console-friendly debug sample to assist with runtime diagnosis (kept lightweight)
  try {
    if (typeof console !== "undefined" && typeof console.debug === "function") {
      try {
        // stringify lightweight samples to avoid JSHandle/remote object representations in puppeteer logs
        const visibleSample = Array.isArray(Array.from(visibleIris || [])) ? Array.from(visibleIris).slice(0, 20).join(",") : "";
        const nodesSampleStr = Array.isArray(mappedNodes)
          ? mappedNodes.slice(0, 20).map((n: any) => `${n.id}|${(n.data && (n.data as any).iri) || ""}|visible=${Boolean(n.data && (n.data as any).visible)}`).join(";")
          : "";
        const edgesSampleStr = Array.isArray(mappedEdges)
          ? mappedEdges.slice(0, 20).map((e: any) => `${e.id}:${e.source}->${e.target}`).join(";")
          : "";

        console.debug("[VG_DEBUG] mapGraphToDiagram", {
          visibleIrisCount: (visibleIris && typeof (visibleIris.size) === "number") ? visibleIris.size : undefined,
          visibleIrisSample: visibleSample,
          mappedNodesCount: Array.isArray(mappedNodes) ? mappedNodes.length : 0,
          mappedNodesSample: nodesSampleStr,
          mappedEdgesCount: Array.isArray(mappedEdges) ? mappedEdges.length : 0,
          mappedEdgesSample: edgesSampleStr,
        });
      } catch (_) {
        /* ignore logging failures */
      }
    }
  } catch (_) {
    /* ignore */
  }

  return { nodes: mappedNodes, edges: mappedEdges };
}
