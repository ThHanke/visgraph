import type { WorkerLiteral, WorkerNamedNode, WorkerTerm } from "./rdfSerialization";
import { isWorkerTerm } from "./rdfSerialization";
import { invariant } from "./guards";

export type TermContext = "subject" | "predicate" | "object" | "graph";

export function sanitizeBlankNode(value: string): string {
  return value.startsWith("_:") ? value.slice(2) : value;
}

export function ensureWorkerTerm(value: WorkerTerm | unknown, context: TermContext): WorkerTerm {
  invariant(isWorkerTerm(value), `Invalid WorkerTerm for ${context}`, { value, context });
  switch (value.termType) {
    case "BlankNode":
      return { termType: "BlankNode", value: sanitizeBlankNode(value.value) };
    case "Literal": {
      const literal: WorkerLiteral = { termType: "Literal", value: value.value };
      if (value.language) literal.language = value.language;
      if (value.datatype) literal.datatype = value.datatype;
      return context === "object" ? literal : coerceLiteralToNamedNode(literal, context);
    }
    case "NamedNode":
      return { termType: "NamedNode", value: value.value };
    case "DefaultGraph":
      return context === "graph" ? { termType: "DefaultGraph" } : coerceDefaultGraphToContext(context);
    default:
      throw new Error(`Unsupported WorkerTerm type '${value.termType}' for context '${context}'`);
  }
}

export function ensureWorkerNamedNode(value: WorkerTerm | unknown, context: TermContext): WorkerNamedNode {
  const term = ensureWorkerTerm(value, context);
  if (term.termType !== "NamedNode") {
    throw new Error(`Expected NamedNode for ${context}, received ${term.termType}`);
  }
  return term;
}

function coerceLiteralToNamedNode(literal: WorkerLiteral, context: TermContext): WorkerTerm {
  if (context === "object") return literal;
  if (context === "graph") {
    return literal.value === "default"
      ? { termType: "DefaultGraph" }
      : { termType: "NamedNode", value: literal.value };
  }
  return { termType: "NamedNode", value: literal.value };
}

function coerceDefaultGraphToContext(context: TermContext): WorkerTerm {
  if (context === "graph") return { termType: "DefaultGraph" };
  return { termType: "NamedNode", value: "" };
}
