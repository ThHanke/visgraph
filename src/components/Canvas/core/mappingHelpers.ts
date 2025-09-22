import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import { generateEdgeId } from "./edgeHelpers";
import { shortLocalName } from "../../../utils/termUtils";
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
 *   - object IRIs / blank nodes produce an edge and ensure node exists for object.
 * - Edges are created with id = generateEdgeId(subject, object, predicate).
 * - No calls to any store API.
 */
export function mapQuadsToDiagram(quads: QuadLike[] = []) {
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

  for (const q of quads || []) {
    try {
      const subj = q && q.subject ? q.subject : null;
      const pred = q && q.predicate ? q.predicate : null;
      const obj = q && q.object ? q.object : null;

      const subjectIri = subj && subj.value ? String(subj.value) : "";
      const predIri = pred && pred.value ? String(pred.value) : "";
      if (!subjectIri || !predIri) continue;

      ensureNode(subjectIri);
      const entry = nodeMap.get(subjectIri)!;

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

      // object is IRI/blank -> create edge + ensure object node
      if (isNamedOrBlank(obj)) {
        const objectIri = obj && obj.value ? String(obj.value) : "";
        if (!objectIri) continue;
        ensureNode(objectIri);
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
        continue;
      }

      // literal -> literalProperties
      if (isLiteral(obj)) {
        const litVal = obj && obj.value ? String(obj.value) : "";
        const dt = obj && obj.datatype && obj.datatype.value ? String(obj.datatype.value) : XSD_STRING;
        entry.literalProperties.push({ key: predIri, value: litVal, type: dt });
        continue;
      }

      // fallback -> annotationProperties
      entry.annotationProperties.push({
        property: predIri,
        value: obj && obj.value ? String(obj.value) : "",
      });
    } catch (_) {
      // ignore per-quad failures
    }
  }

  // Build RF nodes
  const rfNodes: RFNode<NodeData>[] = Array.from(nodeMap.keys()).map((iri) => {
    const info = nodeMap.get(iri)!;
    // Compute a lightweight classType/displayType from first rdf:type if available.
    let classType: string | undefined = undefined;
    if (Array.isArray(info.rdfTypes) && info.rdfTypes.length > 0) {
      const primary = String(info.rdfTypes[0]);
      try {
        // computeTermDisplay may be used by callers that pass an RDF manager into a different layer;
        // this function purposely does not require a manager. Return local short name as fallback.
        classType = shortLocalName(primary);
      } catch (_) {
        classType = shortLocalName(primary);
      }
    }

    // Coarse namespace extraction from IRI (prefix before last / or #)
    let namespace = "";
    try {
      const m = String(iri || "").match(/^(.*[\/#])/);
      namespace = m && m[1] ? String(m[1]) : "";
    } catch (_) {
      namespace = "";
    }

    const isTBox = Array.isArray(info.rdfTypes) && info.rdfTypes.some((t: any) =>
      /Class|ObjectProperty|AnnotationProperty|DatatypeProperty|owl:Class|owl:ObjectProperty/i.test(String(t || ""))
    );

    const nodeData: NodeData = {
      key: iri,
      iri,
      rdfTypes: Array.isArray(info.rdfTypes) ? info.rdfTypes.map(String) : [],
      label: info.label || shortLocalName(iri),
      namespace,
      classType,
      literalProperties: info.literalProperties || [],
      annotationProperties: info.annotationProperties || [],
      visible: true,
      hasReasoningError: false,
      isTBox: !!isTBox,
    };

    return {
      id: iri,
      type: "ontology",
      position: { x: 0, y: 0 },
      data: {
        ...nodeData,
        onSizeMeasured: (_w: number, _h: number) => {
          /* no-op */
        },
      } as NodeData,
    } as RFNode<NodeData>;
  });

  return { nodes: rfNodes, edges: rfEdges };
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
