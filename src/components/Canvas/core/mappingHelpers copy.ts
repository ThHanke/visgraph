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

  // Prefer an explicit NamedNode check for IRI detection (handles real N3 Terms).
  const isNamedNode = (obj: any) => {
    try {
      if (!obj) return false;
      if (obj.termType === "NamedNode") return true;
      const v = obj && obj.value ? String(obj.value) : "";
      if (!v) return false;
      return /^https?:\/\//i.test(v);
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
      // optional override used to propagate subject view (TBox/ABox) to objects created due to unknown/object predicates
      forceIsTBox?: boolean | undefined;
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
        forceIsTBox: undefined,
      });
    }
  };

  const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
  const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";
  const XSD_STRING = "http://www.w3.org/2001/XMLSchema#string";
  const OWL_NAMED_INDIVIDUAL = "http://www.w3.org/2002/07/owl#NamedIndividual";
  const OWL_ONTOLOGY = "http://www.w3.org/2002/07/owl#Ontology";

  // Whitelist of rdf:type IRIs that we treat as TBox (schema-level) entities.
  // Per request: only explicit declared types from this list are considered TBox.
  const TBOX_TYPE_IRIS = new Set<string>([
    "http://www.w3.org/2002/07/owl#Class",
    "http://www.w3.org/2000/01/rdf-schema#Class",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property",
    "http://www.w3.org/2002/07/owl#ObjectProperty",
    "http://www.w3.org/2002/07/owl#DatatypeProperty",
    "http://www.w3.org/2002/07/owl#AnnotationProperty",
    "http://www.w3.org/2002/07/owl#FunctionalProperty",
    "http://www.w3.org/2002/07/owl#InverseFunctionalProperty",
    "http://www.w3.org/2002/07/owl#TransitiveProperty",
    "http://www.w3.org/2002/07/owl#SymmetricProperty",
    "http://www.w3.org/2002/07/owl#Ontology"
  ]);

  // small local cache for classifier results to avoid repeated work per-predicate
  const predicateKindCache = new Map<string, PredicateKind>();

  // Initialize cache from provided fat-map snapshot (availableProperties) if present.
  // The fat-map now provides an explicit propertyKind for each available property
  // (e.g. "object" | "datatype" | "annotation" | "unknown"). Honor that when present.
  try {
    const avail =
      options && Array.isArray((options as any).availableProperties)
        ? (options as any).availableProperties
        : [];
    for (const p of avail) {
      try {
        const iri = p && (p.iri || p.key || p) ? String(p.iri || p.key || p) : "";
        if (!iri) continue;
        // Prefer explicit propertyKind provided by the fat-map entry
        const kindRaw = (p && (p.propertyKind || p.kind || p.type)) || undefined;
        const kind =
          kindRaw === "object" || kindRaw === "datatype" || kindRaw === "annotation"
            ? String(kindRaw)
            : undefined;
        if (kind) {
          // Map fat-map kinds to local PredicateKind values
          if (kind === "object") predicateKindCache.set(iri, "object");
          else if (kind === "datatype") predicateKindCache.set(iri, "datatype");
          else if (kind === "annotation") predicateKindCache.set(iri, "annotation");
        } else {
          // No explicit propertyKind provided — mark as 'unknown' so mapper can decide to create
          // object nodes/edges for unknown predicates (caller may still override via options.predicateKind).
          try {
            predicateKindCache.set(iri, "unknown");
          } catch (_) {
            /* ignore cache errors */
          }
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
  // Only consider references from the authoritative data graph when deciding whether
  // to promote a blank node into an explicit node. Inferred-graph subjects must NOT
  // cause node creation.
  const isBlankNodeReferenced = (bn?: string | null) => {
    try {
      if (!bn) return false;
      const id = String(bn);
      if (!id.startsWith("_:")) return false;
      // Use dataQuads (only authoritative data) — do not consider inferred quads here
      if (!Array.isArray(dataQuads) || dataQuads.length === 0) return false;
      return dataQuads.some((dq: any) => {
        try { return dq && dq.subject && String(dq.subject.value) === id; } catch (_) { return false; }
      });
    } catch (_) {
      return false;
    }
  };

  // Split incoming quads into authoritative-data quads and inferred quads.
  // We will run the full mapping algorithm on dataQuads only, then fold inferredQuads into existing nodes.
  const typesBySubject = new Map<string, Set<string>>();
  const subjectsInBatch = new Set<string>();
  const dataSubjects = new Set<string>();
  const dataQuads: QuadLike[] = [];
  const inferredQuads: QuadLike[] = [];
  try {
    for (const _q of quads || []) {
      try {
        const graphVal =
          _q && _q.graph
            ? (_q.graph.value || _q.graph.id || (typeof _q.graph === "string" ? _q.graph : undefined))
            : undefined;
        if (typeof graphVal === "undefined" || graphVal === null) continue;
        const gstr = String(graphVal || "");
        // Only care about data/inferred graphs for diagram mapping
        if (!gstr.includes("urn:vg:data") && !gstr.includes("urn:vg:inferred")) continue;

        const s = _q && _q.subject ? _q.subject : null;
        const p = _q && _q.predicate ? _q.predicate : null;
        const o = _q && _q.object ? _q.object : null;
        const subjIri = s && s.value ? String(s.value) : "";
        const predIri = p && p.value ? String(p.value) : "";
        if (!subjIri || !predIri) continue;
        subjectsInBatch.add(subjIri);

        if (gstr.includes("urn:vg:data")) {
          dataSubjects.add(subjIri);
          dataQuads.push(_q);
          // collect rdf:type declarations from data quads only (used to decide TBox/ABox)
          if (predIri === RDF_TYPE) {
            const val = o && o.value ? String(o.value) : "";
            if (val) {
              if (!typesBySubject.has(subjIri)) typesBySubject.set(subjIri, new Set<string>());
              typesBySubject.get(subjIri)!.add(val);
            }
          }
        } else if (gstr.includes("urn:vg:inferred")) {
          inferredQuads.push(_q);
        }
      } catch (_) {
        /* ignore per-quad pre-scan errors */
      }
    }
  } catch (_) { /* ignore overall pre-scan errors */ }

  // Group quads by subject and process subjects individually: run the normal mapping on data quads per-subject,
  // then fold inferred quads into existing nodes (no node/edge creation for inferred-only subjects).
  const subjectBuckets = new Map<string, { data: QuadLike[]; inferred: QuadLike[] }>();
  try {
    for (const dq of dataQuads) {
      try {
        const s = dq && dq.subject ? dq.subject : null;
        const subjIri = s && s.value ? String(s.value) : "";
        if (!subjIri) continue;
        if (!subjectBuckets.has(subjIri)) subjectBuckets.set(subjIri, { data: [], inferred: [] });
        subjectBuckets.get(subjIri)!.data.push(dq);
      } catch (_) { /* ignore per-dq */ }
    }
    for (const iq of inferredQuads) {
      try {
        const s = iq && iq.subject ? iq.subject : null;
        const subjIri = s && s.value ? String(s.value) : "";
        if (!subjIri) continue;
        if (!subjectBuckets.has(subjIri)) subjectBuckets.set(subjIri, { data: [], inferred: [] });
        subjectBuckets.get(subjIri)!.inferred.push(iq);
      } catch (_) { /* ignore per-iq */ }
    }
  } catch (_) { /* ignore grouping errors */ }

  // Process each subject: data quads first using the existing per-quad logic, then fold inferred quads.
  for (const [subjectIri, bucket] of Array.from(subjectBuckets.entries())) {
    try {
      const dataForSubject = bucket.data || [];
      const inferredForSubject = bucket.inferred || [];

      // If there are no data quads for this subject, skip creating nodes/edges for it.
      if (!Array.isArray(dataForSubject) || dataForSubject.length === 0) {
        // Nothing to create; inferred-only subjects will be skipped (no nodes created)
        continue;
      }

      // Ensure node exists for subject (created from data quads processing)
      ensureNode(subjectIri);
      const entry = nodeMap.get(subjectIri)!;

      // Build subj-level rdf:type pre-scan (merge into typesBySubject if present)
      const subjTypesArr = typesBySubject.has(subjectIri)
        ? Array.from(typesBySubject.get(subjectIri)!).map(String)
        : Array.isArray(entry.rdfTypes)
        ? entry.rdfTypes.map(String)
        : [];

      // Compute subjectIsTBox for view propagation when needed.
      let subjectIsTBox = false;
      try {
        const hasIndividual = subjTypesArr.includes(OWL_NAMED_INDIVIDUAL);
        const hasTboxType = subjTypesArr.some((t) => TBOX_TYPE_IRIS.has(String(t)));
        subjectIsTBox = !hasIndividual && hasTboxType;
      } catch (_) { subjectIsTBox = false; }

      // Now run the usual per-quad mapping on dataForSubject
      for (const q of dataForSubject) {
        try {
          const pred = q && q.predicate ? q.predicate : null;
          const obj = q && q.object ? q.object : null;
          const predIri = pred && pred.value ? String(pred.value) : "";
          if (!predIri) continue;

          // Compute predicate kind (reuse cache / options)
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
              try { predicateKindCache.set(predIri, predicateKindLocal); } catch (_) { /* ignore */ }
            } else {
              predicateKindLocal = "annotation";
            }
          } catch (_) { predicateKindLocal = "annotation"; }

          // rdf:type
          if (predIri === RDF_TYPE) {
            const val = obj && obj.value ? String(obj.value) : "";
            if (val) {
              try { if (!entry.rdfTypes.includes(val)) entry.rdfTypes.push(val); } catch (_) { /* ignore */ }
            }
            continue;
          }

          // rdfs:label
          if (predIri === RDFS_LABEL && isLiteral(obj)) {
            const labelVal = (obj && obj.value) ? String(obj.value) : entry.label;
            try { entry.label = labelVal; } catch (_) { /* ignore */ }

            try {
              const propPrefixed = toPrefixed(
                predIri,
                options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
                options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
                (options as any).registry
              );
              const exists = Array.isArray(entry.annotationProperties)
                ? entry.annotationProperties.some((ap) => { try { return String(ap.property) === String(propPrefixed) && String(ap.value) === String(labelVal); } catch { return false; } })
                : false;
              if (!exists) entry.annotationProperties.push({ property: propPrefixed, value: labelVal });
            } catch (_) { /* ignore */ }
            continue;
          }

          // Annotation property
          if (predicateKindLocal === "annotation") {
            try {
              const val = obj && obj.value ? String(obj.value) : "";
              entry.annotationProperties.push({
                property: toPrefixed(
                  predIri,
                  options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
                  options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
                  (options as any).registry
                ),
                value: val,
              });
            } catch (_) { /* ignore */ }
            continue;
          }

          // literal -> annotation
          if (isLiteral(obj)) {
            try {
              const litVal = obj && obj.value ? String(obj.value) : "";
              entry.annotationProperties.push({
                property: toPrefixed(
                  predIri,
                  options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
                  options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
                  (options as any).registry
                ),
                value: litVal,
              });
            } catch (_) { /* ignore */ }
            continue;
          }

          // Blank node handling
          if (obj && (obj.termType === "BlankNode" || (obj.value && String(obj.value).startsWith("_:")))) {
            const bn = obj.value ? String(obj.value) : "";
            if (predicateKindLocal === "object" || predicateKindLocal === "unknown" || isBlankNodeReferenced(bn)) {
              ensureNode(bn);
              try {
                const objEntry = nodeMap.get(bn);
                if (objEntry) objEntry.forceIsTBox = subjectIsTBox;
              } catch (_) { /* ignore */ }
              const edgeId = String(generateEdgeId(subjectIri, bn, predIri || ""));
              rfEdges.push({
                id: edgeId,
                source: subjectIri,
                target: bn,
                type: "floating",
                data: {
                  key: edgeId,
                  from: subjectIri,
                  to: bn,
                  propertyUri: predIri,
                  propertyPrefixed: toPrefixed(
                    predIri,
                    options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
                    options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
                    (options as any).registry
                  ),
                  propertyType: "",
                  label: toPrefixed(
                    predIri,
                    options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
                    options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
                    (options as any).registry
                  ),
                  namespace: "",
                  rdfType: "",
                } as LinkData,
              });
            } else {
              try {
                entry.annotationProperties.push({
                  property: toPrefixed(
                    predIri,
                    options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
                    options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
                    (options as any).registry
                  ),
                  value: bn,
                });
              } catch (_) { /* ignore */ }
            }
            continue;
          }

          // NamedNode object handling
          if (obj && (obj.termType === "NamedNode" || (obj.value && /^https?:\/\//i.test(String(obj.value))))) {
            const objectIri = obj && obj.value ? String(obj.value) : "";
            if (!objectIri) continue;

            if (predicateKindLocal === "object" || predicateKindLocal === "unknown") {
              ensureNode(objectIri);
              try {
                const objEntry = nodeMap.get(objectIri);
                if (objEntry) objEntry.forceIsTBox = subjectIsTBox;
              } catch (_) { /* ignore */ }
              const edgeId = String(generateEdgeId(subjectIri, objectIri, predIri || ""));
              rfEdges.push({
                id: edgeId,
                source: subjectIri,
                target: objectIri,
                type: "floating",
                data: {
                  key: edgeId,
                  from: subjectIri,
                  to: objectIri,
                  propertyUri: predIri,
                  propertyPrefixed: toPrefixed(
                    predIri,
                    options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
                    options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
                    (options as any).registry
                  ),
                  propertyType: "",
                  label: toPrefixed(
                    predIri,
                    options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
                    options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
                    (options as any).registry
                  ),
                  namespace: "",
                  rdfType: "",
                } as LinkData,
              });
            } else {
              try {
                entry.annotationProperties.push({
                  property: toPrefixed(
                    predIri,
                    options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
                    options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
                    (options as any).registry
                  ),
                  value: objectIri,
                });
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
          } catch (_) { /* ignore */ }
        } catch (_) {
          /* ignore per-data-quad */
        }
      }

      // Fold inferred triples for this subject (no node/edge creation)
      try {
        for (const iq of inferredForSubject) {
          try {
            const pred = iq && iq.predicate ? iq.predicate : null;
            const obj = iq && iq.object ? iq.object : null;
            const predIri = pred && pred.value ? String(pred.value) : "";
            if (!predIri) continue;

            // rdf:type from inferred: merge into rdfTypes if not present
            if (predIri === RDF_TYPE) {
              const val = obj && obj.value ? String(obj.value) : "";
              if (val) {
                try { if (!entry.rdfTypes.includes(val)) entry.rdfTypes.push(val); } catch (_) { /* ignore */ }
              }
              continue;
            }

            // rdfs:label from inferred (literal) - apply as label and annotation if not duplicate
            if (predIri === RDFS_LABEL && isLiteral(obj)) {
              const labelVal = (obj && obj.value) ? String(obj.value) : entry.label;
              try { entry.label = labelVal; } catch (_) { /* ignore */ }
              try {
                const propPrefixed = toPrefixed(
                  predIri,
                  options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
                  options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
                  (options as any).registry
                );
                const exists = Array.isArray(entry.annotationProperties)
                  ? entry.annotationProperties.some((ap) => { try { return String(ap.property) === String(propPrefixed) && String(ap.value) === String(labelVal); } catch { return false; } })
                  : false;
                if (!exists) entry.annotationProperties.push({ property: propPrefixed, value: labelVal });
              } catch (_) { /* ignore */ }
              continue;
            }

            // Default: fold inferred triple as an annotation property on the subject node
            try {
              const val = obj && obj.value ? String(obj.value) : "";
              entry.annotationProperties.push({
                property: toPrefixed(
                  predIri,
                  options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
                  options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
                  (options as any).registry
                ),
                value: val,
              });
            } catch (_) {
              /* ignore per-inferred-fold failures */
            }
          } catch (_) {
            /* ignore per-inferred */
          }
        }
      } catch (_) {
        /* ignore folding errors */
      }
    } catch (_) {
      /* ignore per-subject */
    }
  }

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
    
    // Determine TBox/ABox using explicit whitelist + precedence:
    // - If rdfTypes include owl:NamedIndividual -> ABox (isTBox = false)
    // - Else if rdfTypes include any whitelist TBox type -> TBox (isTBox = true)
    // - Else -> ABox (isTBox = false)
    let isTBox = false;
    try {
      const types = Array.isArray(info.rdfTypes) ? info.rdfTypes.map((t: any) => String(t || "")) : [];
      const hasIndividual = types.includes(OWL_NAMED_INDIVIDUAL);
      const hasTboxType = types.some((t) => TBOX_TYPE_IRIS.has(String(t)));
      isTBox = !hasIndividual && hasTboxType;
    } catch (_) {
      isTBox = false;
    }

    // Honor explicit override set during mapping (propagate subject view to object nodes for
    // unknown/object predicates). This allows callers to force object nodes into the same view
    // as their subjects without synthesizing rdf:type triples.
    try {
      if (typeof info.forceIsTBox === "boolean") {
        isTBox = !!info.forceIsTBox;
      }
    } catch (_) { /* ignore */ }

      // compute node color using classType (preferred) or the node iri as fallback
      const nodeColor = getNodeColor(classType);

      const nodeData: NodeData & any = {
      key: iri,
      iri,
      // authoritative full IRI title (same as iri) available to renderers
      titleIri: iri,
      // primaryTypeIri preserves the full rdf:type IRI so renderers can shorten it later
      primaryTypeIri,
      rdfTypes: Array.isArray(info.rdfTypes) ? info.rdfTypes.map(String) : [],
      // keep label field for backward compatibility: prefer rdfs:label (if present), otherwise short local name
      label: info && info.label ? info.label : shortLocalName(iri),
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
      displayclassType: (() => {
        try {
          const pref = toPrefixed(
            classType,
            options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
            options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
            (options as any).registry
          );
          return pref;
        } catch (_) {
          return String(classType || "");
        }
      })(),
      namespace,
      classType,
      color: nodeColor || undefined,
      properties: [
        ...(Array.isArray(info.literalProperties)
          ? info.literalProperties.map((lp: any) => {
              try {
                return { property: String(lp.key || lp.property || lp.propertyUri || ""), value: lp.value };
              } catch (_) {
                return { property: String((lp && (lp.key || lp.property || lp.propertyUri)) || ""), value: String((lp && lp.value) || "") };
              }
            })
          : []),
        ...(Array.isArray(info.annotationProperties)
          ? (info.annotationProperties as any[]).map((ap) => {
              try {
                return { property: String((ap && (ap.property || ap.propertyUri)) || ""), value: (ap && ap.value) };
              } catch (_) {
                return { property: String((ap && (ap.property || ap.propertyUri)) || ""), value: String((ap && ap.value) || "") };
              }
            })
          : []),
      ],
      literalProperties: info.literalProperties || [],
      annotationProperties: info.annotationProperties || [],
      visible: true,
      hasReasoningError: false,
      isTBox: !!isTBox,
    };

    const rfNode: RFNode<NodeData> = {
      id: iri,
      type: "ontology",
      position: { x: 0, y: 0 },
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

  // Keep edges as emitted by the mapper. Visibility decisions (hidden/visible) are handled by the canvas.
  // Policy: do not drop edges here; KnowledgeCanvas will decide hiding based on node visibility and propertyPrefixed.
  const rfEdgesFiltered = rfEdges || [];
  console.debug("[VG_DEBUG] mapQuadsToDiagram.return", { rfNodes, rfEdgesFiltered });
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
