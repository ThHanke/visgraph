import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import { generateEdgeId } from "./edgeHelpers";
import { shortLocalName, toPrefixed, getNodeColor } from "../../../utils/termUtils";
import type { NodeData, LinkData } from "../../../types/canvas";

/**
 * Lightweight, pure mapping helpers
 *
 * Centralized mapper that converts quads or subject lists into React Flow nodes/edges.
 *
 * Exported functions:
 * - mapQuadsToDiagram(quads) -> { nodes, edges }        // pure, no store lookup
 * - mapDiagramToQuads(nodes, edges) -> QuadLike[]      // pure, synthesise triple-like POJOs
 *
 * This file intentionally keeps the functionality minimal and pure (no store lookups).
 */

/* Minimal defensive shapes */
type QuadLike = {
  subject?: { value: string };
  predicate?: { value: string };
  object?: { value: string; termType?: string; datatype?: { value: string } };
} | any;

type PredicateKind = "annotation" | "object" | "datatype" | "unknown";

/**
 * Convert an array of quads (QuadLike[]) into React Flow nodes/edges.
 * - quads: array of N3 Quad objects or plain POJOs with subject/predicate/object.value
 *
 * Behavior:
 * - Groups triples by subject IRI.
 * - For each subject:
 *   - rdf:type triples are collected into rdfTypes (order preserved, no dedupe).
 *   - rdfs:label literal sets node label (last-wins).
 *   - literal objects become literalProperties entries.
 *   - object IRIs / blank nodes produce an edge and ensure node exists for object
 *     only when they represent ABox entities; ontology-like IRIs and unreferenced
 *     blank nodes are recorded as annotationProperties on the subject.
 * - Edges are created with id = generateEdgeId(subject, object, predicate).
 * - No calls to any store API by default; callers may provide a predicateKind classifier
 *   that lets the mapper make semantic decisions (e.g., treat owl:AnnotationProperty
 *   predicates as annotations even when the object is an IRI).
 */
export function mapQuadsToDiagram(
  quads: QuadLike[] = [],
  options?: {
    predicateKind?: (predIri: string) => PredicateKind;
    availableProperties?: any[];
    availableClasses?: any[];
    registry?: any;
    getRdfManager?: () => any;
    palette?: Record<string,string> | undefined;
  }
) {
  // Small helpers to detect term kinds robustly across N3 and POJO shapes.
  const isNamedOrBlank = (obj: any) => {
    try {
      if (!obj) return false;
      if (obj.termType === "NamedNode" || obj.termType === "BlankNode") return true;
      const v = obj && obj.value ? String(obj.value) : "";
      if (!v) return false;
      return /^https?:\/\//i.test(v) || v.startsWith("_:");
    } catch (_) {
      return false;
    }
  };

  const isLiteral = (obj: any) => {
    try {
      if (!obj) return false;
      if (obj.termType === "Literal") return true;
      const v = obj && obj.value ? String(obj.value) : "";
      if (!v) return false;
      return !(/^https?:\/\//i.test(v) || v.startsWith("_:"));
    } catch (_) {
      return false;
    }
  };

  // Collection structures
  const nodeMap = new Map<
    string,
    {
      iri: string;
      rdfTypes: string[];
      literalProperties: Array<{ key: string; value: string; type: string }>;
      annotationProperties: Array<{ property: string; value: string }>;
      label?: string | undefined;
    }
  >();

  const rfEdges: RFEdge<LinkData>[] = [];

  const ensureNode = (iri: string) => {
    if (!iri) return;
    if (!nodeMap.has(iri)) {
      nodeMap.set(iri, {
        iri,
        rdfTypes: [],
        literalProperties: [],
        annotationProperties: [],
        label: undefined,
      });
    }
  };

  const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
  const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
  const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
  const OWL_NAMED_INDIVIDUAL = "http://www.w3.org/2002/07/owl#NamedIndividual";

  // small local cache for classifier results to avoid repeated work per-predicate
  const predicateKindCache = new Map<string, PredicateKind>();

  // Initialize cache from provided fat-map snapshot (availableProperties) if present.
  try {
    const avail =
      options && Array.isArray((options as any).availableProperties)
        ? (options as any).availableProperties
        : [];
    for (const p of avail) {
      try {
        const iri = p && (p.iri || p.key || p) ? String(p.iri || p.key || p) : "";
        if (iri) {
          // Treat presence in availableProperties as an object property (authoritative fat-map)
          predicateKindCache.set(iri, "object");
        }
      } catch (_) {
        /* ignore per-entry */
      }
    }
  } catch (_) {
    /* ignore init errors */
  }

  // Heuristic: syntactic check whether an IRI looks like an ontology / vocabulary identifier.
  // Deterministic, heuristic-based (no store lookups). Matches hosts/namespaces commonly used
  // for ontologies and vocabulary IRIs, URN ontologies, and path patterns like '/ontology/' or trailing '#'.
  const isOntologyLikeIri = (iri?: string | null) => {
    try {
      if (!iri) return false;
      const s = String(iri).trim();
      if (!s) return false;
      // URN-based ontology graphs
      if (s.includes("urn:vg:ontologies")) return true;
      return false;
    } catch (_) {
      return false;
    }
  };

  // Helper: determine whether a blank node id (e.g. '_:b0') appears as a subject
  // elsewhere in the incoming quad batch. If so, treat the blank node as an ABox entity.
  const isBlankNodeReferenced = (bn?: string | null) => {
    try {
      if (!bn) return false;
      const id = String(bn);
      if (!id.startsWith("_:")) return false;
      if (!Array.isArray(quads) || quads.length === 0) return false;
      return quads.some((qq: any) => {
        try { return qq && qq.subject && String(qq.subject.value) === id; } catch (_) { return false; }
      });
    } catch (_) {
      return false;
    }
  };

  for (const q of quads || []) {
    try {
      // Small defensive normalization for quad.graph values
      const graphVal =
        q && q.graph
          ? (q.graph.value || q.graph.id || (typeof q.graph === "string" ? q.graph : undefined))
          : undefined;

      // Map ONLY triples that were explicitly written into urn:vg:data.
      // This prevents ontology/TBox graphs from creating canvas nodes.
      // If graph is absent or not the data graph, skip.
      try {
        if (typeof graphVal === "undefined" || graphVal === null) continue;
        const gstr = String(graphVal || "");
        if (!gstr.includes("urn:vg:data")) continue;
      } catch (_) {
        continue;
      }

      const subj = q && q.subject ? q.subject : null;
      const pred = q && q.predicate ? q.predicate : null;
      const obj = q && q.object ? q.object : null;

      const subjectIri = subj && subj.value ? String(subj.value) : "";
      const predIri = pred && pred.value ? String(pred.value) : "";
      if (!subjectIri || !predIri) continue;

      ensureNode(subjectIri);
      const entry = nodeMap.get(subjectIri)!;

      // Compute predicate kind using authoritative fat-map (availableProperties) when available,
      // or an optional caller-provided classifier. Default policy: fold into subject (annotation).
      let predicateKindLocal: PredicateKind = "annotation";
      try {
        if (predicateKindCache.has(predIri)) {
          predicateKindLocal = predicateKindCache.get(predIri)!;
        } else if (options && typeof options.predicateKind === "function") {
          try {
            const k = options.predicateKind(String(predIri));
            predicateKindLocal = k || "annotation";
          } catch (_) {
            predicateKindLocal = "annotation";
          }
          try { predicateKindCache.set(predIri, predicateKindLocal); } catch (_) { /* ignore cache errors */ }
        } else {
          // keep default "annotation" when no classifier and not present in availableProperties
          predicateKindLocal = "annotation";
        }
      } catch (_) {
        predicateKindLocal = "annotation";
      }

      // rdf:type
      if (predIri === RDF_TYPE) {
        const val = obj && obj.value ? String(obj.value) : "";
        if (val) entry.rdfTypes.push(val);
        continue;
      }

      // rdfs:label as node label (literal preferred)
      if (predIri === RDFS_LABEL && isLiteral(obj)) {
        entry.label = obj && obj.value ? String(obj.value) : entry.label;
        continue;
      }

      // If the predicate is classified as an AnnotationProperty treat it as an annotation
      // regardless of whether the object is a literal or an IRI/blank node.
      if (predicateKindLocal === "annotation") {
        try {
          const val = obj && obj.value ? String(obj.value) : "";
          entry.annotationProperties.push({ property: predIri, value: val });
        } catch (_) {
          // ignore per-annotation failures
        }
        continue;
      }

      // literal -> annotationProperties
      // Per requested policy, treat predicates pointing to literals as annotation properties
      // on the subject node rather than as separate literalProperties entries.
      if (isLiteral(obj)) {
        try {
          const litVal = obj && obj.value ? String(obj.value) : "";
          entry.annotationProperties.push({ property: predIri, value: litVal });
        } catch (_) {
          /* ignore per-literal failures */
        }
        continue;
      }

      // Handle blank nodes: create node/edge only when blank node is referenced as a subject elsewhere in this batch.
      if (obj && (obj.termType === "BlankNode" || (obj.value && String(obj.value).startsWith("_:")))) {
        const bn = obj.value ? String(obj.value) : "";
        if (isBlankNodeReferenced(bn)) {
          ensureNode(bn);
          const edgeId = String(generateEdgeId(subjectIri, bn, predIri || ""));
          rfEdges.push({
            id: edgeId,
            source: subjectIri,
            target: bn,
            type: "floating",
            markerEnd: { type: "arrow" as any },
            data: {
              key: edgeId,
              from: subjectIri,
              to: bn,
              propertyUri: predIri,
              propertyType: "",
              label: predIri || "",
              namespace: "",
              rdfType: "",
            } as LinkData,
          });
        } else {
          // Treat unreferenced blank nodes as annotation metadata
          try {
            entry.annotationProperties.push({ property: predIri, value: bn });
          } catch (_) { /* ignore */ }
        }
        continue;
      }

      // object is NamedNode (IRI)
      if (obj && (obj.termType === "NamedNode" || (obj.value && /^https?:\/\//i.test(String(obj.value))))) {
        const objectIri = obj && obj.value ? String(obj.value) : "";
        if (!objectIri) continue;

        // Create an edge only when predicate is classified as an object property.
        // Per policy: do NOT create/ensure a UI node for the object here.
        if (predicateKindLocal === "object") {
          const edgeId = String(generateEdgeId(subjectIri, objectIri, predIri || ""));
          const labelForEdge = predIri || "";
          rfEdges.push({
            id: edgeId,
            source: subjectIri,
            target: objectIri,
            type: "floating",
            markerEnd: { type: "arrow" as any },
            data: {
              key: edgeId,
              from: subjectIri,
              to: objectIri,
              propertyUri: predIri,
              propertyType: "",
              label: labelForEdge,
              namespace: "",
              rdfType: "",
            } as LinkData,
          });
        } else {
          // Fold non-object predicates (even with IRI objects) into the subject as annotation metadata.
          try {
            entry.annotationProperties.push({ property: predIri, value: objectIri });
          } catch (_) { /* ignore */ }
        }
        continue;
      }

      // fallback -> annotationProperties
      try {
        entry.annotationProperties.push({
          property: predIri,
          value: obj && obj.value ? String(obj.value) : "",
        });
      } catch (_) {
        /* ignore */
      }
    } catch (_) {
      // ignore per-quad failures
    }
  }

  // Build RF nodes — filter out pure TBox entities (classes / properties) so they do not appear as canvas nodes.
  const allNodeEntries = Array.from(nodeMap.entries()).map(([iri, info]) => {
    // Compute a lightweight classType/displayType from first rdf:type if available.
    // Preserve the full rdf:type IRI as the primary type.
    let primaryTypeIri: string | undefined = undefined;
    if (Array.isArray(info.rdfTypes) && info.rdfTypes.length > 0) {
      primaryTypeIri = String(info.rdfTypes[0]);
    }
    // For backward compatibility compute a short classType display from primaryTypeIri.
    // Special-case: when a node is an ABox instance (has owl:NamedIndividual among rdfTypes),
    // prefer the next non-NamedIndividual rdf:type as the classType so UI shows the entity's
    // effective class rather than the generic NamedIndividual marker.
    let classType: string | undefined = undefined;
    const typesArr = Array.isArray(info.rdfTypes) ? info.rdfTypes.map(String) : [];
    if (typesArr.length > 0) {
      // primaryTypeIri already computed above as the first type (if present)
      try {
        if (typesArr.includes(OWL_NAMED_INDIVIDUAL)) {
          // find the first type that is not the NamedIndividual marker
          const other = typesArr.find((t: string) => String(t) !== OWL_NAMED_INDIVIDUAL);
          classType = other || primaryTypeIri;
        } else {
          classType = primaryTypeIri;
        }
      } catch (_) {
        classType = primaryTypeIri;
      }
    } else {
      classType = undefined;
    }
    
    // Coarse namespace extraction from IRI (prefix before last / or #)
    let namespace = "";
    try {
      const m = String(iri || "").match(/^(.*[/#])/);
      namespace = m && m[1] ? String(m[1]) : "";
    } catch (_) {
      namespace = "";
    }

    // Determine TBox/ABox:
    // - If rdfTypes exist and include owl:NamedIndividual -> ABox (isTBox = false)
    // - If rdfTypes exist and do NOT include owl:NamedIndividual -> TBox (isTBox = true)
    // - If no rdfTypes -> ABox (isTBox = false)
    let isTBox = false;
    if (Array.isArray(info.rdfTypes) && info.rdfTypes.length > 0) {
      try {
        const types = info.rdfTypes.map((t: any) => String(t || ""));
        if (types.includes(OWL_NAMED_INDIVIDUAL)) {
          isTBox = false;
        } else {
          isTBox = true;
        }
      } catch (_) {
        isTBox = false;
      }
    } else {
      isTBox = false;
    }

      // compute node color using classType (preferred) or the node iri as fallback
      const nodeColor = getNodeColor(
        (classType || iri) as string,
        (options as any).registry,
        (options as any).palette
      );

      const nodeData: NodeData & any = {
      key: iri,
      iri,
      // authoritative full IRI title (same as iri) available to renderers
      titleIri: iri,
      // primaryTypeIri preserves the full rdf:type IRI so renderers can shorten it later
      primaryTypeIri,
      rdfTypes: Array.isArray(info.rdfTypes) ? info.rdfTypes.map(String) : [],
      // keep label field for backward compatibility: prefer rdfs:label, otherwise short local name
      label: info.label || shortLocalName(iri),
      // Presentation hints (compute prefixed form / palette color when a registry/palette is provided in options)
      displayPrefixed: toPrefixed(
        iri,
        options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
        options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
        (options as any).registry
      ),
      // displayShort: short/local name (always available)
      displayShort: shortLocalName(iri),
      // displayClassType: prefixed form for the classType (computed here so UI can use it directly)
      displayClassType: (classType
        ? (() => {
            try {
              // Prefer an explicit registry passed via options.
              let reg = (options as any)?.registry;
              // If no registry supplied, try to derive one from a provided RDF manager accessor.
              if (!reg && typeof (options as any)?.getRdfManager === "function") {
                try {
                  const mgr = (options as any).getRdfManager();
                  if (mgr && typeof mgr.getNamespaces === "function") {
                    reg = mgr.getNamespaces();
                  }
                } catch (_) {
                  reg = undefined;
                }
              }
              // Compute prefixed form using the best registry we have (may be undefined).
              const pref = toPrefixed(
                String(classType),
                options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
                options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
                reg
              );
              // If the result is still a full IRI (no registry found), fall back to the short local name.
              if (typeof pref === "string" && pref.includes("://")) return shortLocalName(String(classType));
              return pref;
            } catch (_) {
              return shortLocalName(String(classType));
            }
          })()
        : undefined),
      // paletteColor: computed when registry/palette provided; otherwise undefined (consumer should fallback)
      namespace,
      classType,
      paletteColor: nodeColor || undefined,
      color: nodeColor || undefined,
      literalProperties: info.literalProperties || [],
      annotationProperties: info.annotationProperties || [],
      visible: true,
      hasReasoningError: false,
      isTBox: !!isTBox,
    };

    const rfNode: RFNode<NodeData> = {
      id: iri,
      type: "ontology",
      data: {
        ...nodeData,
        onSizeMeasured: (_w: number, _h: number) => { /* no-op */ },
      } as NodeData,
    } as RFNode<NodeData>;

    return { iri, isTBox, rfNode };
  });

  // Include all nodes (ABox + TBox) in the mapper output. UI consumers should
  // use the node.data.isTBox flag to hide/show TBox entries according to view mode.
  const rfNodes: RFNode<NodeData>[] = allNodeEntries.map((e) => e.rfNode);

  // Build set of node IDs that will be rendered for edge filtering
  const renderedNodeIds = new Set<string>((rfNodes || []).map((n) => String(n.id)));

  // Filter edges to only include those whose source is rendered (allow edges to external/non-rendered objects).
  // Policy: we create edges for object properties even when we do not create an object node; keep those edges visible.
  const rfEdgesFiltered = (rfEdges || []).filter((edge) => {
    try {
      const s = String(edge.source);
      return renderedNodeIds.has(s);
    } catch (_) { return false; }
  });

  return { nodes: rfNodes, edges: rfEdgesFiltered };
}

/**
 * Convert a diagram (nodes + edges) into an array of QuadLike POJOs.
 *
 * This is the pure inverse of mapQuadsToDiagram: it synthesises simple triple-like
 * objects from NodeData / LinkData shapes. It deliberately does not perform any
 * prefix expansion or store operations — it only returns POJOs representing triples.
 *
 * Returned object format aligns with the QuadLike shape used by mapQuadsToDiagram:
 * { subject: { value }, predicate: { value }, object: { value, termType?, datatype? } }
 */
export function mapDiagramToQuads(
  nodes: Array<NodeData | any> = [],
  edges: Array<LinkData | any> = []
): QuadLike[] {
  const quads: QuadLike[] = [];
  const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
  const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
  const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";

  try {
    for (const n of nodes || []) {
      try {
        const src = n && n.data ? n.data : n;
        const subj = src && (src.iri || src.key || src.id) ? String(src.iri || src.key || src.id) : "";
        if (!subj) continue;

        // rdfTypes -> rdf:type triples
        const rdfTypes = Array.isArray(src.rdfTypes) ? src.rdfTypes : src.rdfTypes ? [src.rdfTypes] : [];
        for (const t of rdfTypes) {
          try {
            if (!t) continue;
            quads.push({
              subject: { value: subj },
              predicate: { value: RDF_TYPE },
              object: { value: String(t), termType: "NamedNode" },
            });
          } catch (_) { /* ignore per-type */ }
        }

        // rdfs:label from label if present
        if (src.label) {
          try {
            quads.push({
              subject: { value: subj },
              predicate: { value: RDFS_LABEL },
              object: { value: String(src.label), termType: "Literal", datatype: { value: XSD_STRING } },
            });
          } catch (_) { /* ignore */ }
        }

        // literalProperties -> literal triples
        if (Array.isArray(src.literalProperties)) {
          for (const lp of src.literalProperties) {
            try {
              const key = lp && (lp.key || lp.property || lp.propertyUri) ? String(lp.key || lp.property || lp.propertyUri) : "";
              const v = lp && lp.value !== undefined && lp.value !== null ? String(lp.value) : "";
              const dt = lp && (lp.type || lp.datatype) ? String(lp.type || lp.datatype) : XSD_STRING;
              if (key && v !== "") {
                quads.push({
                  subject: { value: subj },
                  predicate: { value: key },
                  object: { value: v, termType: "Literal", datatype: { value: dt } },
                });
              }
            } catch (_) { /* ignore per-literal */ }
          }
        }

        // annotationProperties -> literal triples (annotationProperties typically use { property, value } shape)
        if (Array.isArray(src.annotationProperties)) {
          for (const ap of src.annotationProperties) {
            try {
              const key = ap && (ap.property || ap.propertyUri || ap.key) ? String(ap.property || ap.propertyUri || ap.key) : "";
              const v = ap && ap.value !== undefined && ap.value !== null ? String(ap.value) : "";
              if (key && v !== "") {
                quads.push({
                  subject: { value: subj },
                  predicate: { value: key },
                  object: { value: v, termType: "Literal", datatype: { value: XSD_STRING } },
                });
              }
            } catch (_) { /* ignore per-annotation */ }
          }
        }
      } catch (_) {
        /* ignore per-node */
      }
    }

    // edges -> triples with object being IRI (NamedNode)
    for (const e of edges || []) {
      try {
        const src = e && e.data ? e.data : e;
        const subj = src && (src.from || src.source) ? String(src.from || src.source) : (e && (e.source || e.from) ? String(e.source || e.from) : "");
        const obj = src && (src.to || src.target) ? String(src.to || src.target) : (e && (e.target || e.to) ? String(e.target || e.to) : "");
        const pred = src && (src.propertyUri || src.property || src.propertyType) ? String(src.propertyUri || src.property || src.propertyType) : (e && (e.predicate || e.property) ? String(e.predicate || e.property) : "");
        if (!subj || !pred || !obj) continue;

        quads.push({
          subject: { value: subj },
          predicate: { value: pred },
          object: { value: obj, termType: "NamedNode" },
        });
      } catch (_) {
        /* ignore per-edge */
      }
    }
  } catch (_) {
    /* ignore overall failures */
  }

  return quads;
}


export default mapQuadsToDiagram;
