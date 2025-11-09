import type { Node as RFNode, Edge as RFEdge } from "@xyflow/react";
import { generateEdgeId } from "./edgeHelpers";
import initializeEdge from "./edgeStyle";
import {
  shortLocalName,
  toPrefixed,
  getNodeColor,
} from "../../../utils/termUtils";
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

type TermLike = {
  termType?: string;
  value?: unknown;
  id?: unknown;
  datatype?: { value?: unknown };
  language?: string;
};

type QuadLike =
  | {
      subject?: TermLike | null;
      predicate?: TermLike | null;
      object?: TermLike | null;
      graph?: TermLike | string | null;
    }
  | any;

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
function termValue(term: unknown): string | null {
  if (typeof term === "string") return term;
  if (!term || typeof term !== "object") return null;
  const candidate =
    (term as TermLike).value ?? (term as TermLike).id ?? null;
  return typeof candidate === "string" ? candidate : null;
}

function isBlankNode(term: unknown): boolean {
  const value = termValue(term);
  return typeof value === "string" && value.startsWith("_:");
}

function isNamedNode(term: unknown): boolean {
  const value = termValue(term);
  if (typeof value !== "string") return false;
  if (/^https?:\/\//i.test(value)) return true;
  return Boolean(
    term &&
      typeof term === "object" &&
      (term as TermLike).termType === "NamedNode",
  );
}

function isNamedOrBlank(term: unknown): boolean {
  return isNamedNode(term) || isBlankNode(term);
}

function isLiteral(term: unknown): boolean {
  if (term && typeof term === "object" && (term as TermLike).termType === "Literal") {
    return true;
  }
  const value = termValue(term);
  if (typeof value !== "string") return false;
  return !/^https?:\/\//i.test(value) && !value.startsWith("_:");
}

function graphName(term: unknown): string | null {
  if (typeof term === "string") return term;
  const value = termValue(term);
  return value ?? null;
}

function sanitizePredicateKind(
  resolver: ((iri: string) => PredicateKind) | undefined,
): (iri: string) => PredicateKind {
  if (typeof resolver === "function") return resolver;
  return () => "annotation";
}

// `toPrefixed` throws when the registry lacks the prefix; fall back to the original IRI instead
// of relying on catch-all suppression downstream.
function safeToPrefixed(iri: string | undefined, registry: any): string | undefined {
  if (!iri) return undefined;
  try {
    return toPrefixed(iri, registry);
  } catch {
    return iri;
  }
}

function extractNamespace(iri: string): string {
  const match = iri.match(/^(.*[/#])/);
  return match && match[1] ? match[1] : "";
}

function toStringSafe(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return value == null ? "" : String(value);
}

function resolveLiteral(term: unknown, defaultType: string): {
  value: string;
  type?: string;
} {
  const value = termValue(term) ?? "";
  let type: string | undefined;
  if (term && typeof term === "object") {
    const literal = term as TermLike;
    const datatype = literal.datatype?.value;
    if (typeof datatype === "string" && datatype.length > 0) {
      type = datatype;
    } else if (typeof literal.language === "string" && literal.language.length > 0) {
      type = `@${literal.language}`;
    }
  }
  if (!type && value) {
    type = defaultType;
  }
  return { value, type };
}

function coerceQuad(input: QuadLike): {
  subject: string;
  predicate: string;
  object: string;
  raw: QuadLike;
  graph: string | null;
} | null {
  if (!input || typeof input !== "object") return null;
  const subject = termValue((input as any).subject);
  const predicate = termValue((input as any).predicate);
  const object = termValue((input as any).object);
  if (!subject || !predicate || !object) return null;
  const graph = graphName((input as any).graph);
  return { subject, predicate, object, raw: input, graph };
}

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
  const predicateKindResolver = sanitizePredicateKind(options?.predicateKind);
  const availableProperties = Array.isArray(options?.availableProperties)
    ? options!.availableProperties!
    : [];
  const availableClasses = Array.isArray(options?.availableClasses)
    ? options!.availableClasses!
    : [];

  const getPredicateKind = (iri: string): PredicateKind => {
    if (predicateKindCache.has(iri)) {
      return predicateKindCache.get(iri)!;
    }
    const resolved = predicateKindResolver(iri) ?? "annotation";
    predicateKindCache.set(iri, resolved);
    return resolved;
  };

  // Collection structures
  const normalizedByRef = new Map<QuadLike, ReturnType<typeof coerceQuad>>();
  const nodeMap = new Map<
    string,
    {
      iri: string;
      rdfTypes: string[];
      literalProperties: Array<{ key: string; value: string; type: string }>;
      // annotationProperties now carry native Term objects (predicate/object) in addition to legacy string fields
      annotationProperties: Array<{ property: string; value: string; predicateTerm?: any; objectTerm?: any; type?: string }>;
      inferredProperties: Array<{ property: string; value: string; predicateTerm?: any; objectTerm?: any; type?: string }>;
      label?: string | undefined;
      // optional override used to propagate subject view (TBox/ABox) to objects created due to unknown/object predicates
      forceIsTBox?: boolean | undefined;
    }
  >();

  const rfEdges: RFEdge<LinkData>[] = [];
  const seenEdgeIds = new Set<string>();

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
  for (const property of availableProperties) {
    if (!property || typeof property !== "object") continue;
    const iriCandidate =
      (property as any).iri ??
      (property as any).key ??
      (typeof property === "string" ? property : null);
    if (typeof iriCandidate !== "string" || iriCandidate.length === 0) {
      continue;
    }
    const kindRaw =
      (property as any).propertyKind ??
      (property as any).kind ??
      (property as any).type;
    if (kindRaw === "object" || kindRaw === "datatype" || kindRaw === "annotation") {
      predicateKindCache.set(iriCandidate, kindRaw);
    } else {
      predicateKindCache.set(iriCandidate, "unknown");
    }
  }

  // Blank node referenced checker (in the provided quad batch)
  const isBlankNodeReferenced = (bn?: string | null, collection?: QuadLike[]) => {
    if (typeof bn !== "string" || !bn.startsWith("_:")) return false;
    const source = Array.isArray(collection) ? collection : quads;
    if (!Array.isArray(source) || source.length === 0) return false;
    return source.some((candidate) => {
      const normalized = coerceQuad(candidate);
      return normalized?.subject === bn;
    });
  };


  // Step 2: split quads by origin (graph name)
  const dataQuads: QuadLike[] = [];
  const inferredQuads: QuadLike[] = [];
  for (const quad of Array.isArray(quads) ? quads : []) {
    const normalized = coerceQuad(quad);
    if (!normalized) continue;
    normalizedByRef.set(quad, normalized);

    const graphId = normalized.graph ?? "";
    if (graphId.includes("urn:vg:inferred")) {
      inferredQuads.push(quad);
      continue;
    }
    if (graphId.includes("urn:vg:data") || graphId === "") {
      dataQuads.push(quad);
      continue;
    }
  }

  // Pre-scan dataQuads for rdf:type declarations so we can make deterministic decisions
  const typesBySubject = new Map<string, Set<string>>();
  for (const quad of dataQuads) {
    const normalized = normalizedByRef.get(quad) ?? coerceQuad(quad);
    if (!normalized) continue;
    const predicateIri = normalized.predicate;
    if (predicateIri !== RDF_TYPE) continue;
    const objectIri = normalized.object;
    if (!objectIri) continue;
    const subjectId = normalized.subject;
    if (!subjectId) continue;
    const objectId = objectIri;
    if (!objectId) continue;
    if (!typesBySubject.has(subjectId)) {
      typesBySubject.set(subjectId, new Set<string>());
    }
    typesBySubject.get(subjectId)!.add(objectId);
  }

  const propertyLabelByIri = new Map<string, string>();
  for (const property of availableProperties) {
    if (!property || typeof property !== "object") continue;
    const iri = typeof property.iri === "string" ? property.iri : undefined;
    const label =
      typeof property.label === "string"
        ? property.label
        : typeof property.name === "string"
        ? property.name
        : typeof property.title === "string"
        ? property.title
        : typeof property.display === "string"
        ? property.display
        : undefined;
    if (iri && label) {
      propertyLabelByIri.set(iri, label);
    }
  }

  const classLabelByIri = new Map<string, string>();
  for (const cls of availableClasses) {
    if (!cls || typeof cls !== "object") continue;
    const iri = typeof cls.iri === "string" ? cls.iri : undefined;
    const label =
      typeof cls.label === "string"
        ? cls.label
        : typeof cls.name === "string"
        ? cls.name
        : typeof cls.title === "string"
        ? cls.title
        : typeof cls.display === "string"
        ? cls.display
        : undefined;
    if (iri && label) {
      classLabelByIri.set(iri, label);
    }
  }

  // Step 3: loop over data quads and fill the properties of the already existing nodes
  for (const quad of dataQuads) {
    const normalized = normalizedByRef.get(quad) ?? coerceQuad(quad);
    if (!normalized) continue;

    const subjectIri = normalized.subject;
    if (!subjectIri) continue;
    ensureNode(subjectIri);
    const entry = nodeMap.get(subjectIri)!;

    const subjectTypesSet = typesBySubject.get(subjectIri);
    const subjectTypes = subjectTypesSet
      ? Array.from(subjectTypesSet)
      : Array.isArray(entry.rdfTypes)
      ? entry.rdfTypes.slice()
      : [];

    const hasAboxType =
      subjectTypes.length === 0 ||
      subjectTypes.some((type) => ABOX_TYPE_IRIS.has(type));
    entry.forceIsTBox = !hasAboxType;

    const predicateIri = normalized.predicate;
    if (!predicateIri) continue;
    const predicateTerm = (quad as { predicate?: TermLike }).predicate ?? null;
    const objectTerm = (quad as { object?: TermLike }).object ?? null;

    if (predicateIri === RDF_TYPE) {
      const typeValue = termValue(objectTerm);
      if (typeValue) {
        entry.rdfTypes.push(typeValue);
      }
      continue;
    }

    const predicateKindLocal = getPredicateKind(predicateIri);

    if (predicateIri === RDFS_LABEL && isLiteral(objectTerm)) {
      const { value, type } = resolveLiteral(objectTerm, XSD_STRING);
      if (value) entry.label = value;
      entry.annotationProperties.push({
        property: predicateIri,
        value,
        predicateTerm,
        objectTerm,
        ...(type ? { type } : {}),
      });
      continue;
    }

    if (predicateKindLocal === "annotation") {
      const literal = resolveLiteral(objectTerm, XSD_STRING);
      entry.annotationProperties.push({
        property: predicateIri,
        value: literal.value,
        predicateTerm,
        objectTerm,
        ...(literal.type ? { type: literal.type } : {}),
      });
      continue;
    }

    if (isLiteral(objectTerm)) {
      const literal = resolveLiteral(objectTerm, XSD_STRING);
      entry.annotationProperties.push({
        property: predicateIri,
        value: literal.value,
        predicateTerm,
        objectTerm,
        ...(literal.type ? { type: literal.type } : {}),
      });
      continue;
    }

    if (isBlankNode(objectTerm)) {
      const bn = termValue(objectTerm);
      if (!bn) continue;
      if (
        predicateKindLocal === "object" ||
        predicateKindLocal === "unknown" ||
        isBlankNodeReferenced(bn, dataQuads)
      ) {
        const canonicalBn = bn;
        ensureNode(canonicalBn);
        const objEntry = nodeMap.get(canonicalBn);
        if (objEntry) objEntry.forceIsTBox = entry.forceIsTBox;

        const edgeId = String(generateEdgeId(subjectIri, canonicalBn, predicateIri));
        const propertyPrefixed =
          safeToPrefixed(predicateIri, options?.registry) ?? predicateIri;
        const propertyLabel = propertyLabelByIri.get(predicateIri);

        if (!seenEdgeIds.has(edgeId)) {
          seenEdgeIds.add(edgeId);
          rfEdges.push(
            initializeEdge({
              id: edgeId,
              source: subjectIri,
              target: canonicalBn,
              type: "floating",
              data: {
                key: edgeId,
                from: subjectIri,
                to: canonicalBn,
                propertyUri: predicateIri,
                propertyPrefixed,
                propertyType: "",
                label: propertyLabel,
                namespace: "",
                rdfType: "",
              } as LinkData,
            }),
          );
        }
      } else {
        entry.annotationProperties.push({
          property: predicateIri,
          value: bn,
          predicateTerm,
          objectTerm,
        });
      }
      continue;
    }

    if (isNamedNode(objectTerm)) {
      const objectIri = termValue(objectTerm);
      if (!objectIri) continue;

      if (predicateKindLocal === "object" || predicateKindLocal === "unknown") {
        const canonicalObject = objectIri;
        ensureNode(canonicalObject);
        const objEntry = nodeMap.get(canonicalObject);
        if (objEntry) objEntry.forceIsTBox = entry.forceIsTBox;

        const edgeId = String(generateEdgeId(subjectIri, canonicalObject, predicateIri));
        const propertyPrefixed =
          safeToPrefixed(predicateIri, options?.registry) ?? predicateIri;
        const propertyLabel = propertyLabelByIri.get(predicateIri);

        if (!seenEdgeIds.has(edgeId)) {
          seenEdgeIds.add(edgeId);
          rfEdges.push(
            initializeEdge({
              id: edgeId,
              source: subjectIri,
              target: canonicalObject,
              type: "floating",
              data: {
                key: edgeId,
                from: subjectIri,
                to: canonicalObject,
                propertyUri: predicateIri,
                propertyPrefixed,
                propertyType: "",
                label: propertyLabel,
                namespace: "",
                rdfType: "",
              } as LinkData,
            }),
          );
        }
      } else {
        entry.annotationProperties.push({
          property: predicateIri,
          value: objectIri,
          predicateTerm,
          objectTerm,
        });
      }
      continue;
    }

    entry.annotationProperties.push({
      property: predicateIri,
      value: termValue(objectTerm) ?? "",
      predicateTerm,
      objectTerm,
    });
  }

  // Step 4: fold inferred quads into annotation properties (do not create new nodes)
  for (const quad of inferredQuads) {
    const normalized = normalizedByRef.get(quad) ?? coerceQuad(quad);
    if (!normalized) continue;
    if (!nodeMap.has(normalized.subject)) continue;

    const entry = nodeMap.get(normalized.subject)!;
    const predicateTerm = (quad as { predicate?: TermLike }).predicate ?? null;
    const objectTerm = (quad as { object?: TermLike }).object ?? null;
    const value = termValue(objectTerm) ?? "";

    const duplicate = entry.annotationProperties.some(
      (ap) => ap.property === normalized.predicate && ap.value === value,
    );
    if (duplicate) continue;

    if (isLiteral(objectTerm)) {
      const literal = resolveLiteral(objectTerm, XSD_STRING);
      entry.annotationProperties.push({
        property: normalized.predicate,
        value: literal.value,
        predicateTerm,
        objectTerm,
        ...(literal.type ? { type: literal.type } : {}),
      });
    } else {
      entry.annotationProperties.push({
        property: normalized.predicate,
        value,
        predicateTerm,
        objectTerm,
      });
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
    if (typesArr.includes(OWL_NAMED_INDIVIDUAL)) {
      classType = typesArr.find((t) => t !== OWL_NAMED_INDIVIDUAL) ?? primaryTypeIri;
    } else {
      classType = primaryTypeIri;
    }

    const namespace = extractNamespace(iri);
    const isTBox = typeof info.forceIsTBox === "boolean" ? info.forceIsTBox : true;

    // compute node color using classType (preferred) or the node iri as fallback
    let nodeColor: string | undefined;
    const colorSource =
      typeof classType === "string" && classType.trim().length > 0 ? classType : iri;
    if (colorSource) {
      nodeColor = getNodeColor(colorSource, options?.palette, {
        registry: options?.registry,
        availableProperties,
        availableClasses,
      });
    }

    const nodeData: NodeData & any = {
      key: iri,
      iri,
      titleIri: iri,
      primaryTypeIri,
      rdfTypes: Array.isArray(info.rdfTypes) ? info.rdfTypes.map(String) : [],
      label: info.label || iri,
      displayPrefixed: safeToPrefixed(iri, options?.registry),
      displayShort: shortLocalName(iri),
      displayclassType: safeToPrefixed(classType, options?.registry),
      namespace,
      classType,
      color: nodeColor || undefined,
      properties: [
        ...(Array.isArray(info.literalProperties)
          ? info.literalProperties.map((lp: any) => {
              const propertyId =
                typeof lp?.key === "string"
                  ? lp.key
                  : typeof lp?.property === "string"
                  ? lp.property
                  : typeof lp?.propertyUri === "string"
                  ? lp.propertyUri
                  : "";
              return { property: propertyId, value: lp?.value };
            })
          : []),
        ...(Array.isArray(info.annotationProperties)
          ? (info.annotationProperties as any[]).map((ap) => {
              const propertyId =
                typeof ap?.property === "string"
                  ? ap.property
                  : typeof ap?.propertyUri === "string"
                  ? ap.propertyUri
                  : "";
              return { property: propertyId, value: ap?.value };
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

    const subjectText = (() => {
      const explicit = typeof info.label === "string" ? info.label.trim() : "";
      if (explicit && explicit !== iri) return explicit;
      if (typeof nodeData.displayPrefixed === "string" && nodeData.displayPrefixed.trim()) {
        return nodeData.displayPrefixed.trim();
      }
      return shortLocalName(iri);
    })();

    const classText = (() => {
      if (!classType) return "";
      if (classLabelByIri.has(classType)) return classLabelByIri.get(classType)!;
      const prefixed = nodeData.displayclassType;
      if (typeof prefixed === "string" && prefixed.trim()) return prefixed.trim();
      return shortLocalName(classType);
    })();

    nodeData.subtitle = classText ? `${subjectText} is a ${classText}` : subjectText;

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

  const rfEdgesFiltered = rfEdges;

  const PARALLEL_EDGE_SHIFT_STEP = 60;
  const edgeGroups = new Map<string, RFEdge<LinkData>[]>();

  for (const edge of rfEdgesFiltered) {
    if (!edge) continue;
    const source =
      typeof edge.source === "string"
        ? edge.source
        : toStringSafe(edge.data && (edge.data as any).from);
    const target =
      typeof edge.target === "string"
        ? edge.target
        : toStringSafe(edge.data && (edge.data as any).to);
    const key = `${source}||${target}`;
    if (!edgeGroups.has(key)) edgeGroups.set(key, []);
    edgeGroups.get(key)!.push(edge);
  }

  const indexToShift = (index: number) => {
    if (index === 0) return 0;
    const magnitude = Math.ceil(index / 2);
    const direction = index % 2 === 1 ? 1 : -1;
    return direction * magnitude * PARALLEL_EDGE_SHIFT_STEP;
  };

  for (const groupEdges of edgeGroups.values()) {
    groupEdges.sort((a, b) => toStringSafe(a.id).localeCompare(toStringSafe(b.id)));
    groupEdges.forEach((edge, index) => {
      edge.data = {
        ...(edge.data || {}),
        shift: indexToShift(index),
      } as LinkData;
    });
  }

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

  const nodeSources = Array.isArray(nodes) ? nodes : [];
  for (const node of nodeSources) {
    const src =
      node && typeof node === "object" && "data" in node ? (node as any).data : node;
    if (!src || typeof src !== "object") continue;

    const subjectIri = toStringSafe(
      (src as any).iri ?? (src as any).key ?? (src as any).id,
    ).trim();
    if (!subjectIri) continue;

    const rdfTypesRaw = Array.isArray((src as any).rdfTypes)
      ? (src as any).rdfTypes
      : (src as any).rdfTypes
      ? [(src as any).rdfTypes]
      : [];
    for (const rdfType of rdfTypesRaw) {
      const typeIri = toStringSafe(rdfType).trim();
      if (!typeIri) continue;
      quads.push({
        subject: { value: subjectIri },
        predicate: { value: RDF_TYPE },
        object: { value: typeIri, termType: "NamedNode" },
      });
    }

    const labelValue = toStringSafe((src as any).label).trim();
    if (labelValue) {
      quads.push({
        subject: { value: subjectIri },
        predicate: { value: RDFS_LABEL },
        object: {
          value: labelValue,
          termType: "Literal",
          datatype: { value: XSD_STRING },
        },
      });
    }

    if (Array.isArray((src as any).literalProperties)) {
      for (const literal of (src as any).literalProperties) {
        if (!literal || typeof literal !== "object") continue;
        const predicateIri = toStringSafe(
          (literal as any).key ??
            (literal as any).property ??
            (literal as any).propertyUri,
        ).trim();
        const value = toStringSafe((literal as any).value);
        if (!predicateIri || value === "") continue;
        const datatype = toStringSafe(
          (literal as any).type ?? (literal as any).datatype,
        ).trim();
        quads.push({
          subject: { value: subjectIri },
          predicate: { value: predicateIri },
          object: {
            value,
            termType: "Literal",
            datatype: { value: datatype || XSD_STRING },
          },
        });
      }
    }

    if (Array.isArray((src as any).annotationProperties)) {
      for (const annotation of (src as any).annotationProperties) {
        if (!annotation || typeof annotation !== "object") continue;
        const predicateIri = toStringSafe(
          (annotation as any).property ??
            (annotation as any).propertyUri ??
            (annotation as any).key,
        ).trim();
        const value = toStringSafe((annotation as any).value);
        if (!predicateIri || value === "") continue;
        quads.push({
          subject: { value: subjectIri },
          predicate: { value: predicateIri },
          object: {
            value,
            termType: "Literal",
            datatype: { value: XSD_STRING },
          },
        });
      }
    }
  }

  const edgeSources = Array.isArray(edges) ? edges : [];
  for (const edge of edgeSources) {
    const src =
      edge && typeof edge === "object" && "data" in edge ? (edge as any).data : edge;
    if (!src || typeof src !== "object") continue;

    const subjectIri = toStringSafe(
      (src as any).from ??
        (src as any).source ??
        (edge as any)?.source ??
        (edge as any)?.from,
    ).trim();
    const objectIri = toStringSafe(
      (src as any).to ??
        (src as any).target ??
        (edge as any)?.target ??
        (edge as any)?.to,
    ).trim();
    const predicateIri = toStringSafe(
      (src as any).propertyUri ??
        (src as any).property ??
        (src as any).propertyType ??
        (edge as any)?.predicate ??
        (edge as any)?.property,
    ).trim();

    if (!subjectIri || !predicateIri || !objectIri) continue;

    quads.push({
      subject: { value: subjectIri },
      predicate: { value: predicateIri },
      object: { value: objectIri, termType: "NamedNode" },
    });
  }

  return quads;
}


export default mapQuadsToDiagram;
