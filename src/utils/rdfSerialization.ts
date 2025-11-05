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
export type WorkerTerm =
  | { termType: "NamedNode"; value: string }
  | { termType: "BlankNode"; value: string }
  | { termType: "Literal"; value: string; datatype?: string; language?: string }
  | { termType: "DefaultGraph"; value?: string };

export interface WorkerQuad {
  subject: WorkerTerm;
  predicate: WorkerTerm;
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

function isWorkerTerm(term: unknown): term is WorkerTerm {
  return Boolean(
    term &&
      typeof term === "object" &&
      typeof (term as WorkerTerm).termType === "string",
  );
}

export function serializeTerm(term: Term): WorkerTerm {
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
  return {
    subject: serializeTerm(quad.subject),
    predicate: serializeTerm(quad.predicate),
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
  const object = deserializeTerm(serial.object, factory);
  const graph = deserializeTerm(serial.graph, factory);
  return factory.quad(subject, predicate, object, graph);
}
