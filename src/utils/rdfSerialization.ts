import type {
  BlankNode,
  DataFactory,
  Literal,
  NamedNode,
  Quad,
  Term,
} from "@rdfjs/types";

/**
 * Interfaces describing the minimal JSON representation of RDF/JS terms and quads
 * that can safely cross the worker boundary via structured cloning.
 */
export type WorkerNamedNode = { termType: "NamedNode"; value: string };
export type WorkerBlankNode = { termType: "BlankNode"; value: string };
export type WorkerLiteral = {
  termType: "Literal";
  value: string;
  datatype?: string;
  language?: string;
};
export type WorkerDefaultGraph = { termType: "DefaultGraph"; value?: string };

export type WorkerTerm =
  | WorkerNamedNode
  | WorkerBlankNode
  | WorkerLiteral
  | WorkerDefaultGraph;

export interface WorkerQuad {
  subject: WorkerTerm;
  predicate: WorkerNamedNode;
  object: WorkerTerm;
  graph: WorkerTerm;
}

export interface WorkerQuadUpdate {
  subject: WorkerTerm;
  predicate: WorkerNamedNode;
  object?: WorkerTerm;
  graph: WorkerTerm;
}

type DataFactoryLike = Pick<
  DataFactory,
  "namedNode" | "blankNode" | "literal" | "defaultGraph" | "quad"
>;

function isRdfTerm(term: unknown): term is Term {
  return Boolean(term && typeof (term as any).termType === "string");
}

export function isWorkerTerm(term: unknown): term is WorkerTerm {
  return Boolean(
    term &&
      typeof term === "object" &&
      typeof (term as WorkerTerm).termType === "string",
  );
}

function assertWorkerNamedNode(
  term: WorkerTerm,
): asserts term is WorkerNamedNode {
  if (term.termType !== "NamedNode") {
    throw new Error("worker-term-predicate-must-be-named-node");
  }
}

export function isWorkerQuad(value: unknown): value is WorkerQuad {
  if (!value || typeof value !== "object") return false;
  const quad = value as WorkerQuad;
  return (
    isWorkerTerm(quad.subject) &&
    isWorkerTerm(quad.object) &&
    isWorkerTerm(quad.graph) &&
    isWorkerTerm(quad.predicate) &&
    quad.predicate.termType === "NamedNode"
  );
}

export function isWorkerQuadUpdate(value: unknown): value is WorkerQuadUpdate {
  if (!value || typeof value !== "object") return false;
  const quad = value as WorkerQuadUpdate;
  if (
    !isWorkerTerm(quad.subject) ||
    !isWorkerTerm(quad.graph) ||
    !isWorkerTerm(quad.predicate) ||
    quad.predicate.termType !== "NamedNode"
  ) {
    return false;
  }
  if (quad.object && !isWorkerTerm(quad.object)) {
    return false;
  }
  return true;
}

export function serializeTerm(term: Term): WorkerTerm {
  if (!isRdfTerm(term)) {
    throw new Error("serialize-term-invalid");
  }

  switch (term.termType) {
    case "NamedNode":
      return { termType: "NamedNode", value: term.value };
    case "BlankNode":
      return { termType: "BlankNode", value: term.value };
    case "Literal": {
      const literal = term as Literal;
      const payload: WorkerTerm = {
        termType: "Literal",
        value: literal.value,
      };
      if (literal.language) payload.language = literal.language;
      const dt = literal.datatype?.value;
      if (dt && dt !== "http://www.w3.org/2001/XMLSchema#string") {
        payload.datatype = dt;
      }
      return payload;
    }
    case "DefaultGraph":
    default:
      return { termType: "DefaultGraph", value: (term as any).value };
  }
}

export function serializeQuad(quad: Quad): WorkerQuad {
  const predicate = serializeTerm(quad.predicate);
  assertWorkerNamedNode(predicate);

  return {
    subject: serializeTerm(quad.subject),
    predicate,
    object: serializeTerm(quad.object),
    graph: serializeTerm(quad.graph),
  };
}

export function deserializeTerm(
  term: WorkerTerm | Term | null | undefined,
  factory: DataFactoryLike,
): Term {
  if (isRdfTerm(term)) return term;
  if (!term || !isWorkerTerm(term)) return factory.defaultGraph();
  switch (term.termType) {
    case "NamedNode":
      return factory.namedNode(term.value);
    case "BlankNode":
      return factory.blankNode(term.value);
    case "Literal": {
      if (term.language) return factory.literal(term.value, term.language);
      if (term.datatype) {
        const dt = factory.namedNode(term.datatype);
        return factory.literal(term.value, dt);
      }
      return factory.literal(term.value);
    }
    case "DefaultGraph":
    default:
      return factory.defaultGraph();
  }
}

export function deserializeQuad(
  quad: WorkerQuad | Quad,
  factory: DataFactoryLike,
): Quad {
  if (isRdfTerm((quad as Quad).subject)) return quad as Quad;
  const serial = quad as WorkerQuad;
  if (!serial.object) {
    throw new Error("serialized-quad-missing-object");
  }
  const subject = deserializeTerm(serial.subject, factory);
  const predicate = deserializeTerm(serial.predicate, factory);
  if (predicate.termType !== "NamedNode") {
    throw new Error("serialized-quad-invalid-predicate");
  }
  const object = deserializeTerm(serial.object, factory);
  const graph = deserializeTerm(serial.graph, factory);
  return factory.quad(subject, predicate, object, graph);
}
