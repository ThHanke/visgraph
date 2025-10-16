import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import { generateEdgeId } from "./edgeHelpers";
import initializeEdge from "./edgeStyle";
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
      if (obj === null || typeof obj === "undefined") return false;
      // Plain string representing an IRI or blank node id
      if (typeof obj === "string") {
        return /^https?:\/\//i.test(obj) || obj.startsWith("_:");
      }
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
      if (obj === null || typeof obj === "undefined") return false;
      // plain string -> literal
      if (typeof obj === "string") return true;
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
      if (obj === null || typeof obj === "undefined") return false;
      if (typeof obj === "string") return /^https?:\/\//i.test(obj);
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
      inferredProperties: Array<{ property: string; value: string }>;
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
        inferredProperties: [],
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
  const ABOX_TYPE_IRIS = new Set<string>([
    "http://www.w3.org/2002/07/owl#NamedIndividual",
  ]);

  // small local cache for classifier results to avoid repeated work per-predicate
  const predicateKindCache = new Map<string, PredicateKind>();

  // Initialize cache from provided fat-map snapshot (availableProperties) if present.
  {
    const avail =
      options && Array.isArray((options as any).availableProperties)
        ? (options as any).availableProperties
        : [];
    for (const p of avail) {
      try {
        const iri = p && (p.iri || p.key || p) ? String(p.iri || p.key || p) : "";
        if (!iri) continue;
        const kindRaw = (p && (p.propertyKind || p.kind || p.type)) || undefined;
        const kind =
          kindRaw === "object" || kindRaw === "datatype" || kindRaw === "annotation"
            ? String(kindRaw)
            : undefined;
        if (kind) {
          if (kind === "object") predicateKindCache.set(iri, "object");
          else if (kind === "datatype") predicateKindCache.set(iri, "datatype");
          else if (kind === "annotation") predicateKindCache.set(iri, "annotation");
        } else {
          predicateKindCache.set(iri, "unknown");
        }
      } catch (_) {
        /* ignore per-entry */
      }
    }
  }

  
  // Blank node referenced checker (in the provided quad batch)
  const isBlankNodeReferenced = (bn?: string | null, quadsToCheck?: QuadLike[]) => {
    try {
      if (!bn) return false;
      const id = String(bn);
      if (!id.startsWith("_:")) return false;
      const arr = Array.isArray(quadsToCheck) ? quadsToCheck : quads;
      if (!Array.isArray(arr) || arr.length === 0) return false;
      return arr.some((qq: any) => {
        try { return qq && qq.subject && String(qq.subject.value) === id; } catch (_) { return false; }
      });
    } catch (_) {
      return false;
    }
  };


  // Step 2: split quads by origin (graph name)
  const dataQuads: QuadLike[] = [];
  const inferredQuads: QuadLike[] = [];
  {
    for (const q of quads || []) {
      try {
        const graphVal =
          q && q.graph
            ? (q.graph.value || q.graph.id || (typeof q.graph === "string" ? q.graph : undefined))
            : undefined;
        const gstr = typeof graphVal !== "undefined" && graphVal !== null ? String(graphVal || "") : "";
        // default detection: data quads include "urn:vg:data"
        if (gstr && gstr.includes("urn:vg:data")) {
          dataQuads.push(q);
          continue;
        }
        // inferred quads detection: includes "urn:vg:inferred"
        if (gstr && gstr.includes("urn:vg:inferred")) {
          inferredQuads.push(q);
          continue;
        }
        // fallback: treat other graphs as data if no graph provided
        if (!gstr) {
          // If no graph we treat as data by default (preserve previous behaviour in many cases)
          dataQuads.push(q);
        }
      } catch (_) { /* ignore per-quad */ }
    }
  }

  // Pre-scan dataQuads for rdf:type declarations so we can make deterministic decisions
  const typesBySubject = new Map<string, Set<string>>();
  {
    for (const q of dataQuads || []) {
      try {
        const s = q && q.subject ? q.subject : null;
        const p = q && q.predicate ? q.predicate : null;
        const o = q && q.object ? q.object : null;
        const subjIri = s && s.value ? String(s.value) : "";
        const predIri = p && p.value ? String(p.value) : "";
        if (!subjIri || !predIri) continue;
        if (predIri === RDF_TYPE) {
          const val = o && o.value ? String(o.value) : "";
          if (val) {
            if (!typesBySubject.has(subjIri)) typesBySubject.set(subjIri, new Set<string>());
            typesBySubject.get(subjIri)!.add(val);
          }
        }
      } catch (_) { /* ignore per-quad */ }
    }
  }

  // Step 3: loop over data quads and fill the properties of the already existing nodes
  try {
    for (const q of dataQuads || []) {
      try {
        const subj = q && q.subject ? q.subject : null;
        const pred = q && q.predicate ? q.predicate : null;
        const obj = q && q.object ? q.object : null;

        const subjectIri = subj && subj.value ? String(subj.value) : "";
        const predIri = pred && pred.value ? String(pred.value) : "";
        if (!subjectIri || !predIri) continue;

        // ensure the node exists (pre-pass should have created it, but be defensive)
        ensureNode(subjectIri);
        const entry = nodeMap.get(subjectIri)!;

        // Determine subjectIsTBox using pre-scanned types (prefer deterministic)
        let subjectIsTBox = true;
        const subjTypesArr = typesBySubject.has(subjectIri)
          ? Array.from(typesBySubject.get(subjectIri)!).map(String)
          : Array.isArray(entry.rdfTypes)
          ? entry.rdfTypes.map(String)
          : [];

        // // const hasIndividual = subjTypesArr.includes(OWL_NAMED_INDIVIDUAL);
        // // const hasTboxType = subjTypesArr.some((t) => TBOX_TYPE_IRIS.has(String(t)));
        const hasAboxType = subjTypesArr.length === 0 || subjTypesArr.some((t) => ABOX_TYPE_IRIS.has(String(t)));
        subjectIsTBox = !hasAboxType;
        entry.forceIsTBox=subjectIsTBox
        // Determine predicate kind (use cache -> options.predicateKind -> default to annotation)
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
        } catch (_) {
          predicateKindLocal = "annotation";
        }

        // Handle rdf:type
        if (predIri === RDF_TYPE) {
          const val = obj && obj.value ? String(obj.value) : "";
          if (val) entry.rdfTypes.push(val);
          continue;
        }

        // rdfs:label as node label (literal preferred)
        if (predIri === RDFS_LABEL && isLiteral(obj)) {
          const labelVal = obj && obj.value ? String(obj.value) : entry.label;
          entry.label = labelVal;
          {
            const propPrefixed = toPrefixed(predIri);
            entry.annotationProperties.push({
                property: propPrefixed,
                value: labelVal,
              });

          }
          continue;
        }

        // Annotation property classifier
        if (predicateKindLocal === "annotation") {
          {
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
          }
          continue;
        }

        // Literals for data quads -> annotationProperties (per policy)
        if (isLiteral(obj)) {
          {
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
          }
          continue;
        }

        // Blank node handling for data quads
        if (obj && (obj.termType === "BlankNode" || (obj.value && String(obj.value).startsWith("_:")))) {
          const bn = obj.value ? String(obj.value) : "";
          if (predicateKindLocal === "object" || predicateKindLocal === "unknown" || isBlankNodeReferenced(bn, dataQuads)) {
            ensureNode(bn);
            {
              const objEntry = nodeMap.get(bn);
              if (objEntry) objEntry.forceIsTBox = subjectIsTBox;
            }

            const edgeId = String(generateEdgeId(subjectIri, bn, predIri || ""));
            rfEdges.push(
              initializeEdge({
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
              })
            );
          } else {
            {
              entry.annotationProperties.push({
                property: toPrefixed(
                  predIri,
                  options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
                  options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
                  (options as any).registry
                ),
                value: bn,
              });
            }
          }
          continue;
        }

        // object is NamedNode (IRI) for data quads
        if (obj && (obj.termType === "NamedNode" || (obj.value && /^https?:\/\//i.test(String(obj.value))))) {
          // assume the object is in subjects and needs no creation (else it would override the existing node in canvas)
          const objectIri = obj && obj.value ? String(obj.value) : "";
          if (!objectIri) continue;

          if (predicateKindLocal === "object" || predicateKindLocal === "unknown") {
            ensureNode(objectIri);
            {
              const objEntry = nodeMap.get(objectIri);
              if (objEntry) objEntry.forceIsTBox = subjectIsTBox;
            }

            const edgeId = String(generateEdgeId(subjectIri, objectIri, predIri || ""));
            rfEdges.push(
              initializeEdge({
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
              })
            );
          } else {
            {
              entry.annotationProperties.push({
                property: toPrefixed(
                  predIri,
                  options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
                  options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
                  (options as any).registry
                ),
                value: objectIri,
              });
            }
          }
          continue;
        }

        // fallback -> annotationProperties
        {
          entry.annotationProperties.push({
            property: predIri,
            value: obj && obj.value ? String(obj.value) : "",
          });
        }
      } catch (_) {
        /* ignore per-quad failures */
      }
    }
  } catch (_) { /* ignore overall */ }

  // Step 4: loop over inferred quads and fold them into existing data nodes' annotationProperties (do not create new nodes)
  {
    for (const q of inferredQuads || []) {
      try {
        const subj = q && q.subject ? q.subject : null;
        const pred = q && q.predicate ? q.predicate : null;
        const obj = q && q.object ? q.object : null;

        const subjectIri = subj && subj.value ? String(subj.value) : "";
        const predIri = pred && pred.value ? String(pred.value) : "";
        if (!subjectIri || !predIri) continue;

        // Only fold into nodes that already exist (i.e., created from data quads)
        if (!nodeMap.has(subjectIri)) continue;
        const entry = nodeMap.get(subjectIri)!;

        let prop = predIri;
        try {
          prop = toPrefixed(
            predIri,
            options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
            options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
            (options as any).registry
          );
        } catch (_) {
          prop = predIri;
        }

        let val = obj && obj.value ? String(obj.value) : "";
        if (!isLiteral(obj)) {
          if (isNamedNode(obj)) {
            try {
              val = toPrefixed(
                String(obj.value),
                options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
                options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
                (options as any).registry
              );
            } catch (_) {
              val = String(obj.value || "");
            }
          } else {
            val = String(obj && obj.value ? obj.value : "");
          }
        }

        // Push into annotationProperties (fold inferred triples into subject annotations)
        try {
          const exists = Array.isArray(entry.annotationProperties)
            ? entry.annotationProperties.some((ap) => {
                try { return String(ap.property) === String(prop) && String(ap.value) === String(val); } catch { return false; }
              })
            : false;
          if (!exists) {
            entry.annotationProperties.push({ property: prop, value: val });
          }
        } catch (_) { /* ignore */ }
      } catch (_) { /* ignore per-quad */ }
    }
  }

  // Build RF nodes from nodeMap entries
  const allNodeEntries = Array.from(nodeMap.entries()).map(([iri, info]) => {
    // Compute a lightweight classType/displayType from first rdf:type if available.
    let primaryTypeIri: string | undefined = undefined;
    if (Array.isArray(info.rdfTypes) && info.rdfTypes.length > 0) {
      primaryTypeIri = String(info.rdfTypes[0]);
    }
    let classType: string | undefined = undefined;
    const typesArr = Array.isArray(info.rdfTypes) ? info.rdfTypes.map(String) : [];
    if (typesArr.length > 0) {
      try {
        if (typesArr.includes(OWL_NAMED_INDIVIDUAL)) {
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

    // Determine isTBox
    let isTBox;
    // try {
    //   const types = Array.isArray(info.rdfTypes) ? info.rdfTypes.map((t: any) => String(t || "")) : [];
    //   const hasIndividual = types.includes(OWL_NAMED_INDIVIDUAL);
    //   const hasTboxType = types.some((t) => TBOX_TYPE_IRIS.has(String(t)));
    //   isTBox = !hasIndividual && hasTboxType;
    // } catch (_) {
    //   isTBox = false;
    // }
    const types = Array.isArray(info.rdfTypes) ? info.rdfTypes.map((t: any) => String(t || "")) : [];
    isTBox = true;


    // Honor explicit override set during mapping
    {
      if (typeof info.forceIsTBox === "boolean") {
        isTBox = !!info.forceIsTBox;
      }
    }

    // compute node color using classType (preferred) or the node iri as fallback
    const nodeColor = getNodeColor(classType);

    const nodeData: NodeData & any = {
      key: iri,
      iri,
      titleIri: iri,
      primaryTypeIri,
      rdfTypes: Array.isArray(info.rdfTypes) ? info.rdfTypes.map(String) : [],
      label: info.label || iri,
      displayPrefixed: toPrefixed(
        iri,
        options && Array.isArray((options as any).availableProperties) ? (options as any).availableProperties : undefined,
        options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined,
        (options as any).registry
      ),
      displayShort: shortLocalName(iri),
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
      inferredProperties: info.inferredProperties || [],
      visible: true,
      hasReasoningError: false,
      isTBox: !!isTBox,
    };

    // Compose a human-friendly subtitle for the node and attach as nodeData.subtitle.
    // Prefer explicit labels where available and fall back to already-computed
    // prefixed values (displayPrefixed / displayclassType) and finally to short local names.
    try {
      const resolveFromAvailable = (iriToFind: string | undefined, arr: any[] | undefined) => {
        try {
          if (!iriToFind || !Array.isArray(arr)) return "";
          const key = String(iriToFind);
          const found = arr.find((e: any) => {
            const cand = String((e && (e.iri || e.key || e)) || "");
            return cand === key;
          });
          if (!found) return "";
          return String(found.label || found.name || found.title || found.display || "").trim();
        } catch (_) { return ""; }
      };

      const subjectText = (() => {
        // prefer explicit node label (info.label), then already-computed displayPrefixed, then shortLocalName
        const lab = info.label && String(info.label).trim() ? String(info.label).trim() : "";
        if (lab && lab !== iri) return lab;
        if (nodeData.displayPrefixed && String(nodeData.displayPrefixed).trim()) return String(nodeData.displayPrefixed).trim();
        return shortLocalName(String(iri));
      })();

      const classText = (() => {
        if (!classType) return "";
        // prefer label from availableClasses snapshot (if provided)
        const fromAvail = resolveFromAvailable(classType, options && Array.isArray((options as any).availableClasses) ? (options as any).availableClasses : undefined);
        if (fromAvail) return fromAvail;
        // reuse already-computed prefixed displayclassType
        if (nodeData.displayclassType && String(nodeData.displayclassType).trim()) return String(nodeData.displayclassType).trim();
        // final fallback: short local name
        return shortLocalName(String(classType));
      })();

      if (classText) {
        nodeData.subtitle = `${subjectText} is a ${classText}`;
      } else {
        nodeData.subtitle = subjectText;
      }
    } catch (_) {
      // non-fatal: if anything goes wrong, leave subtitle undefined
    }

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

  const rfNodes: RFNode<NodeData>[] = allNodeEntries.map((e) => e.rfNode);

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

  {
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
  }

  return quads;
}


export default mapQuadsToDiagram;
