import { DataFactory, NamedNode } from "n3";
const { namedNode } = DataFactory;
import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import type { RDFManager } from "../../../utils/rdfManager";
import { computeTermDisplay, shortLocalName } from "../../../utils/termUtils";
import { getPredicateDisplay } from "./edgeLabel";
import { generateEdgeId } from "./edgeHelpers";
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

/* Minimal defensive typing for the graph node/edge shapes used by the app */
type NodeShape = any;
type EdgeShape = any;

export interface MapOptions {
  getRdfManager?: (() => RDFManager | undefined) | undefined;
  availableClasses?: Array<{ iri: string; label?: string; namespace?: string }>;
  availableProperties?: Array<any> | undefined;
  getEntityIndex?: (() => { mapByIri?: Map<string, any>; mapByLocalName?: Map<string, any> } | undefined) | undefined;
}

/**
 * Build a React Flow NodeData payload from a canonical node.
 * - canonicalNode: parsed/diagram node with possible fields like iri, rdfTypes, namespace, classType, label, literalProperties, annotationProperties
 * - rdfManager: optional manager used to expand/contract prefixes
 */
export function buildNodeDataFromParsedNode(
  canonicalNode: NodeShape,
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

  // Expand/normalize candidates into full IRIs where possible, but keep raw values as fallback.
  // Purpose: preserve type information even when rdfManager cannot expand a prefixed form.
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
            // Expansion returned something non-IRI or failed to produce an IRI:
            // fall through to keep the raw candidate below as a fallback.
          } catch (_) {
            // expansion failed — fall through to keep raw candidate
          }
        }
        // Fallback: keep the raw candidate (prefixed name or local name) so we don't lose information.
        rdfTypesArr.push(ts);
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

  // Prefer explicit iri, but do not treat absence as fatal — node.id is authoritative when present.
  const nodeIri = src.iri ?? src.id ?? src.key ?? "";

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
      iri: nodeIri,
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
export function mapNodesToRFNodes(
  nodesForMapping: NodeShape[] = [],
  options?: MapOptions
): RFNode<NodeData>[] {
  const mgr = options && typeof options.getRdfManager === "function" ? options.getRdfManager() : undefined;
  const entityIndexGetter = options && typeof options.getEntityIndex === "function" ? options.getEntityIndex : undefined;
  const availableClasses = options && options.availableClasses ? options.availableClasses : undefined;

  const nodes: RFNode<NodeData>[] = [];

  for (let i = 0; i < (nodesForMapping || []).length; i++) {
    const node = nodesForMapping[i];
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

    // Enforce strict IRI-first node id policy:
    // - Prefer node.id when it is an absolute IRI (http/https) or a blank node (_:)
    // - Otherwise prefer the parsed node iri (nd.iri) when it is an absolute IRI or blank node
    // - Otherwise skip the node and emit a lightweight diagnostic (do not fabricate ids)
    let id = "";
    const rawNodeId = node && node.id ? String(node.id) : "";
    const parsedIri = nd && nd.iri ? String(nd.iri) : "";
    const isIriOrBNode = (s: string) => !!s && (/^https?:\/\//i.test(s) || s.startsWith("_:"));
    try {
      if (isIriOrBNode(rawNodeId)) {
        id = rawNodeId;
      } else if (isIriOrBNode(parsedIri)) {
        id = parsedIri;
      } else {
        // Emit a lightweight diagnostic so producers of non-IRI ids can be found.
        try {
          if (typeof console !== "undefined" && typeof console.debug === "function") {
            console.debug("[VG_WARN] mapNodesToRFNodes skipping node without IRI id", {
              nodePreview: { id: rawNodeId || undefined, iri: parsedIri || undefined, label: nd && (nd as any).label },
            });
          }
        } catch (_) { /* ignore logging failures */ }
        continue;
      }
    } catch (_) {
      continue;
    }
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
export function mapEdgesToRFEdges(
  edgesForMapping: EdgeShape[] = [],
  nodesPresent: Set<string> = new Set(),
  options?: MapOptions
): RFEdge<LinkData>[] {
  const mgrLocal = options && typeof options.getRdfManager === "function" ? options.getRdfManager() : undefined;
  const edges: RFEdge<LinkData>[] = [];

  for (let j = 0; j < (edgesForMapping || []).length; j++) {
    const edge = edgesForMapping[j];
    const src = edge && edge.data ? edge.data : edge;

    const from = String(src.source || src.from || "");
    const to = String(src.target || src.to || "");

    // Skip if endpoints missing on canvas
    if (!nodesPresent.has(String(from)) || !nodesPresent.has(String(to))) continue;

    const propertyUriRaw = src.propertyUri || src.propertyType || "";
    const availableProperties = options && options.availableProperties ? options.availableProperties : [];
    const foundProp = (availableProperties || []).find((p: any) => String(p.iri) === String(propertyUriRaw));
    const id = String(src.id || generateEdgeId(from, to, propertyUriRaw || ""));


    // Strict label resolution:
    // Prefer computeTermDisplay when a predicate IRI and RDF manager are available.
    // Otherwise fall back to any explicit label present on the source object or the foundProp label.
    let labelForEdge = "";
    try {
      const rdfMgr = mgrLocal || ((typeof (globalThis as any).__VG_RDF_MANAGER === "function")
        ? (globalThis as any).__VG_RDF_MANAGER()
        : undefined);
      if (propertyUriRaw && rdfMgr) {
        try {
          const td = computeTermDisplay(String(propertyUriRaw), rdfMgr as any);
          labelForEdge = String(td.prefixed || td.short || "");
        } catch (_) {
          labelForEdge = src && src.label ? String(src.label) : (foundProp && (foundProp.label || foundProp.name) ? String(foundProp.label || foundProp.name) : "");
        }
      } else if (src && src.label) {
        labelForEdge = String(src.label);
      } else if (foundProp && (foundProp.label || foundProp.name)) {
        labelForEdge = String(foundProp.label || foundProp.name);
      } else {
        labelForEdge = "";
      }
    } catch (_) {
      labelForEdge = src && src.label ? String(src.label) : "";
    }

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
  graph: { nodes?: NodeShape[]; edges?: EdgeShape[] } | undefined,
  options?: MapOptions
): { nodes: RFNode<NodeData>[]; edges: RFEdge<LinkData>[]; meta?: { requestLayoutOnNextMap?: boolean; requestFitOnNextMap?: boolean } } {
  const cg = graph || { nodes: [], edges: [] };
  const mgr = options && typeof options.getRdfManager === "function" ? options.getRdfManager() : undefined;

  // Build indexes for resolving edge endpoints:
  // - nodeKeyToIri: map canonical node key -> iri (when iri exists)
  // - nodeIds: set of canonical node ids (primary identifiers; expected to be IRIs)
  // - iriToNodeId: reverse map iri -> node.id for quick lookups
  const nodeKeyToIri = new Map<string, string>();
  const cgNodeIds = new Set<string>();
  const iriToNodeId = new Map<string, string>();
  try {
    (cg.nodes || []).forEach((n: any) => {
      const src = n && n.data ? n.data : n;
      const iri = (src && (src.iri || (src.data && src.data.iri))) || src.iri || "";
      // Only register node keys if they are valid IRIs or blank nodes; do not index fabricated or local keys.
      const key = (n && n.id && (typeof n.id === "string") && ((/^https?:\/\//i.test(n.id)) || n.id.startsWith("_:"))) ? String(n.id) : (iri && ((/^https?:\/\//i.test(iri)) || iri.startsWith("_:")) ? String(iri) : "");
      if (key) {
        nodeKeyToIri.set(String(key), String(iri || ""));
        cgNodeIds.add(String(key));
        if (iri && ((/^https?:\/\//i.test(iri)) || iri.startsWith("_:"))) {
          iriToNodeId.set(String(iri), String(key));
        }
      }
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
  const mappedNodes = mapNodesToRFNodes(cg.nodes || [], options);
  const mappedNodeIds = new Set(mappedNodes.map((n) => n.id));

  // Resolve edges to use node IRIs (not legacy/canonical numeric keys).
  // Build mappedEdges by resolving each canonical edge's raw endpoint refs to the node IRI
  // using the nodeKeyToIri index built above. This restores the invariant that React Flow
  // node ids are IRIs and edges use those IRIs as source/target.
  const mappedEdges: RFEdge<LinkData>[] = [];
  try {
    for (let j = 0; j < (cg.edges || []).length; j++) {
      const edge = cg.edges[j];
      const src = edge && edge.data ? edge.data : edge;

      // Raw refs may be under different properties depending on producer.
      // Some edges place endpoint refs on the top-level (edge.source/edge.target) while others
      // put them inside edge.data. Check both places and normalize to a consistent string.
      const edgeObj = edge || {};
      const dataObj = (edgeObj && edgeObj.data) ? edgeObj.data : {};
      const rawFromRef = String(
        (dataObj && (dataObj.source || dataObj.from || dataObj.s || dataObj.subj || dataObj.subject)) ||
        edgeObj.source ||
        edgeObj.from ||
        edgeObj.subj ||
        edgeObj.subject ||
        ""
      );
      const rawToRef = String(
        (dataObj && (dataObj.target || dataObj.to || dataObj.o || dataObj.obj || dataObj.object)) ||
        edgeObj.target ||
        edgeObj.to ||
        edgeObj.obj ||
        edgeObj.object ||
        ""
      );

    // Resolve raw refs strictly to existing mapped node ids (IRI or blank node).
    // No scheme-insensitive or fuzzy matching allowed here; require exact id equality or iri -> nodeId mapping.
    let resolvedFrom = "";
    let resolvedTo = "";

    // 1) Direct match: raw ref equals a mapped node id
    if (mappedNodeIds.has(String(rawFromRef))) {
      resolvedFrom = String(rawFromRef);
    } else {
      // 2) If rawRef is an IRI that maps to a node id via iriToNodeId, use that
      if (iriToNodeId.has(String(rawFromRef))) {
        resolvedFrom = iriToNodeId.get(String(rawFromRef)) || "";
      } else {
        // 3) If rawRef is a key that indexes to an iri which then maps to a node id, use that (rare)
        const iri = nodeKeyToIri.get(String(rawFromRef)) || "";
        if (iri && iriToNodeId.has(iri)) resolvedFrom = iriToNodeId.get(iri) || "";
      }
    }

    if (mappedNodeIds.has(String(rawToRef))) {
      resolvedTo = String(rawToRef);
    } else {
      if (iriToNodeId.has(String(rawToRef))) {
        resolvedTo = iriToNodeId.get(String(rawToRef)) || "";
      } else {
        const iriT = nodeKeyToIri.get(String(rawToRef)) || "";
        if (iriT && iriToNodeId.has(iriT)) resolvedTo = iriToNodeId.get(iriT) || "";
      }
    }

    // If either endpoint could not be resolved exactly, skip the edge and emit a diagnostic.
    if (!resolvedFrom || !resolvedTo) {
      try {
        if (typeof console !== "undefined" && typeof console.debug === "function") {
          // Serialize key helper structures into lightweight samples to avoid huge logs.
          const mappedNodeIdsArr = Array.from(mappedNodeIds || []).slice(0, 200);
          const nodeKeyToIriKeys = Array.from((nodeKeyToIri && nodeKeyToIri.keys && typeof nodeKeyToIri.keys === "function") ? nodeKeyToIri.keys() : []).slice(0, 200);
          const nodeKeyToIriSample: Record<string,string> = {};
          try {
            for (const k of nodeKeyToIriKeys) {
              try {
                nodeKeyToIriSample[String(k)] = String(nodeKeyToIri.get ? nodeKeyToIri.get(k) : "");
              } catch (_) { nodeKeyToIriSample[String(k)] = ""; }
            }
          } catch (_) { /* ignore sample building errors */ }

          const diagPayload = {
            edgePreview: { id: src && src.id, rawFromRef, rawToRef, resolvedFrom, resolvedTo },
            diagnostics: {
              mappedNodeIdsCount: (mappedNodeIds && typeof mappedNodeIds.size === "number") ? mappedNodeIds.size : mappedNodeIdsArr.length,
              mappedNodeIdsSample: mappedNodeIdsArr,
              nodeKeyToIriSample,
            },
          };

          // Human-readable object for interactive consoles
          console.debug("[VG_WARN] mapGraphToDiagram skipping edge due to unresolved endpoints", diagPayload);

          // JSON-stringified version so logs captured to text files contain the full payload
          try {
            console.debug("[VG_WARN_JSON] mapGraphToDiagram", JSON.stringify(diagPayload));
          } catch (_) {
            // If stringify fails for any reason, fall back to the raw object (best-effort)
            try { console.debug("[VG_WARN_JSON] mapGraphToDiagram (stringify failed)", diagPayload); } catch (_) { /* ignore */ }
          }
        }
      } catch (_) { /* ignore logging failures */ }
      continue;
    }

    // Ensure resolved ids are present in mappedNodeIds (sanity)
    if (!mappedNodeIds.has(String(resolvedFrom)) || !mappedNodeIds.has(String(resolvedTo))) {
      try {
        if (typeof console !== "undefined" && typeof console.debug === "function") {
          console.debug("[VG_WARN] mapGraphToDiagram resolved endpoints not present in mappedNodeIds", {
            edgePreview: { id: src && src.id, resolvedFrom, resolvedTo, mappedNodeCount: mappedNodeIds.size },
          });
        }
      } catch (_) { /* ignore */ }
      continue;
    }

      const propertyUriRaw = src.propertyUri || src.propertyType || "";
      const availableProperties = options && options.availableProperties ? options.availableProperties : [];
      const foundProp = (availableProperties || []).find((p: any) => String(p.iri) === String(propertyUriRaw));
      const id = String(src.id || generateEdgeId(resolvedFrom, resolvedTo, propertyUriRaw || ""));

      // Strict label resolution: prefer computeTermDisplay when predicate IRI + rdf manager present.
      let labelForEdge = "";
      try {
        if (mgr && propertyUriRaw) {
          try {
            const td = computeTermDisplay(String(propertyUriRaw), mgr as any);
            labelForEdge = String(td.prefixed || td.short || "");
          } catch (_) {
            // if computeTermDisplay fails, fall back to explicit src.label if present
            labelForEdge = src && src.label ? String(src.label) : "";
          }
        } else if (src && src.label) {
          labelForEdge = String(src.label);
        } else {
          labelForEdge = "";
        }
      } catch (_) {
        labelForEdge = src && src.label ? String(src.label) : "";
      }

      mappedEdges.push({
        id,
        source: String(resolvedFrom),
        target: String(resolvedTo),
        type: "floating",
        markerEnd: { type: "arrow" as any },
        data: {
          key: id,
          from: String(resolvedFrom),
          to: String(resolvedTo),
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

  // Decide layout/fit meta flags for the caller. Mapping is authoritative about which IRIs are visible
  // in the data graph; expose small signals the consumer (ReactFlowCanvas) can use to apply layout/fit
  // at the right time (i.e., after mapping has produced the final diagram.nodes/edges).
  let requestLayoutOnNextMap = false;
  let requestFitOnNextMap = false;
  try {
    if (typeof window !== "undefined") {
      try {
        requestLayoutOnNextMap = !!(window as any).__VG_REQUEST_LAYOUT_ON_NEXT_MAP;
      } catch (_) { requestLayoutOnNextMap = false; }
      try {
        requestFitOnNextMap = !!(window as any).__VG_REQUEST_FIT_ON_NEXT_MAP;
      } catch (_) { requestFitOnNextMap = false; }
    }
  } catch (_) { /* ignore */ }

  try {
    // If there are visible IRIs and mapped nodes include at least one visible node, suggest a fit.
    const visibleCount = (visibleIris && typeof visibleIris.size === "number") ? visibleIris.size : Array.from(visibleIris || []).length;
    const mappedVisibleNodesCount = (mappedNodes || []).filter(n => {
      try { return !!(n.data && (n.data as any).visible); } catch { return false; }
    }).length;
    if (visibleCount > 0 && mappedVisibleNodesCount > 0) {
      requestFitOnNextMap = true;
    }
  } catch (_) {
    /* ignore */
  }

  const meta = { requestLayoutOnNextMap, requestFitOnNextMap };

  return { nodes: mappedNodes, edges: mappedEdges, meta };
}
