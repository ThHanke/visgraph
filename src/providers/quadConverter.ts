import { DataFactory as f, type Quad, type Term } from 'n3';

interface WorkerTerm {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
}

export interface WorkerQuad {
  subject: WorkerTerm;
  predicate: WorkerTerm;
  object: WorkerTerm;
  graph: WorkerTerm;
}

function toTerm(t: WorkerTerm): Term {
  if (t.termType === 'BlankNode') return f.blankNode(t.value);
  if (t.termType === 'Literal') {
    if (t.language) return f.literal(t.value, t.language);
    return f.literal(t.value, t.datatype ? f.namedNode(t.datatype.value) : undefined);
  }
  return f.namedNode(t.value);
}

export function workerQuadsToRdf(wqs: WorkerQuad[]): Quad[] {
  return wqs.map(wq => {
    const graph =
      !wq.graph || wq.graph.termType === 'DefaultGraph' || !wq.graph.value
        ? f.defaultGraph()
        : f.namedNode(wq.graph.value);
    return f.quad(
      toTerm(wq.subject) as ReturnType<typeof f.namedNode>,
      toTerm(wq.predicate) as ReturnType<typeof f.namedNode>,
      toTerm(wq.object),
      graph
    );
  });
}
