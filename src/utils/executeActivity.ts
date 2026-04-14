/**
 * @fileoverview Standalone Activity execution utility.
 * Extracts execution logic from the old React Flow ActivityNode (now deleted).
 * Used by ProvActivityTemplate (per-node play button).
 */

import * as Reactodia from '@reactodia/workspace';
import { useOntologyStore } from '../stores/ontologyStore';
import { getPyodideClient } from './pyodideManager.workerClient';
import type { ExecuteResult } from '../workers/pyodide.workerProtocol';
import { DataFactory, Parser as N3Parser } from 'n3';

const PPLAN_NS = 'http://purl.org/net/p-plan#';
const PROV_NS = 'http://www.w3.org/ns/prov#';
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS_NS = 'http://www.w3.org/2000/01/rdf-schema#';
const DATA_GRAPH = 'urn:vg:data';
const WORKFLOWS_GRAPH = 'urn:vg:workflows';

const { namedNode, literal } = DataFactory;

/**
 * Query the workflows graph to find the step that follows `currentStepIri`
 * within `planIri`. Returns the next step IRI or null if there is none.
 *
 * A step B follows step A when a variable V satisfies:
 *   V p-plan:isOutputVarOf A  AND  V p-plan:isInputVarOf B
 */
export async function resolveNextStep(
  currentStepIri: string,
  planIri: string,
): Promise<string | null> {
  const rdfManager = useOntologyStore.getState().getRdfManager();
  if (!rdfManager) return null;
  const worker = (rdfManager as any).worker;
  if (!worker) return null;

  const outputVarQuads: any[] = await worker.call('getQuads', {
    predicate: `${PPLAN_NS}isOutputVarOf`,
    object: { termType: 'NamedNode', value: currentStepIri },
    graphName: WORKFLOWS_GRAPH,
  }) ?? [];

  for (const varQuad of outputVarQuads) {
    const varIri = varQuad.subject.value;

    const inputOfQuads: any[] = await worker.call('getQuads', {
      subject: varIri,
      predicate: `${PPLAN_NS}isInputVarOf`,
      graphName: WORKFLOWS_GRAPH,
    }) ?? [];

    for (const inputQuad of inputOfQuads) {
      const candidateStepIri = inputQuad.object.value;
      if (candidateStepIri === currentStepIri) continue;

      const planCheckQuads: any[] = await worker.call('getQuads', {
        subject: candidateStepIri,
        predicate: `${PPLAN_NS}isStepOfPlan`,
        object: { termType: 'NamedNode', value: planIri },
        graphName: WORKFLOWS_GRAPH,
      }) ?? [];

      if (planCheckQuads.length > 0) {
        return candidateStepIri;
      }
    }
  }

  return null;
}

/**
 * Execute a prov:Activity, write output to urn:vg:data, then create and
 * return the next Activity element if the template defines a successor step.
 *
 * Returns the new Activity IRI if a next step was created, otherwise null.
 */
export async function executeActivity(
  activityIri: string,
  model: Reactodia.DataDiagramModel,
): Promise<string | null> {
  const rdfManager = useOntologyStore.getState().getRdfManager();
  if (!rdfManager) throw new Error('RDF manager not available');
  const worker = (rdfManager as any).worker;
  if (!worker) throw new Error('RDF manager worker not available');

  // 1. Resolve code and requirements URLs from prov:used resources
  const activityUsedQuads: any[] = await worker.call('getQuads', {
    subject: activityIri,
    predicate: `${PROV_NS}used`,
    graphName: DATA_GRAPH,
  }) ?? [];

  let codeUrl = '';
  let requirementsUrl = '';

  for (const quad of activityUsedQuads) {
    const resourceIri = quad.object.value;

    const locationQuads: any[] = await worker.call('getQuads', {
      subject: resourceIri,
      predicate: `${PROV_NS}atLocation`,
      graphName: WORKFLOWS_GRAPH,
    }) ?? [];

    if (locationQuads.length === 0) continue;
    const location = locationQuads[0].object.value;

    const typeQuads: any[] = await worker.call('getQuads', {
      subject: resourceIri,
      predicate: `${RDF_NS}type`,
      graphName: WORKFLOWS_GRAPH,
    }) ?? [];

    const types: string[] = typeQuads.map((q: any) => q.object.value);
    const isCode = types.some(t => t.includes('SoftwareSourceCode') || t.includes('Code'));

    if (isCode) {
      codeUrl = location;
    } else {
      const labelQuads: any[] = await worker.call('getQuads', {
        subject: resourceIri,
        predicate: `${RDFS_NS}label`,
        graphName: WORKFLOWS_GRAPH,
      }) ?? [];
      const labelText = labelQuads[0]?.object?.value?.toLowerCase() ?? resourceIri.toLowerCase();
      if (labelText.includes('requirement')) {
        requirementsUrl = location;
      } else if (!codeUrl && (labelText.includes('code') || labelText.includes('.py'))) {
        codeUrl = location;
      }
    }
  }

  if (!codeUrl) throw new Error(`No Python code URL found for activity ${activityIri}`);

  // 2. Export data graph as Turtle, execute Python via Pyodide
  // The Python script receives the full data graph Turtle and derives its own
  // inputs from prov:used links — no need to pre-filter entity IRIs here.
  const exportResult = await worker.call('exportGraph', {
    graphName: DATA_GRAPH,
    format: 'text/turtle',
  });
  const inputTurtle: string = exportResult?.content ?? '';

  const pyodideClient = getPyodideClient();
  const result = await pyodideClient.call<'execute', ExecuteResult>('execute', {
    activityIri,
    codeUrl,
    requirementsUrl: requirementsUrl || undefined,
    inputTurtle,
  });

  // 4. Parse output Turtle and write back to data graph
  const parser = new N3Parser();
  const quads = parser.parse(result.outputTurtle);

  const adds = quads.map((quad: any) => ({
    subject:   { termType: quad.subject.termType,   value: quad.subject.value },
    predicate: { termType: quad.predicate.termType, value: quad.predicate.value },
    object: quad.object.termType === 'Literal'
      ? { termType: 'Literal', value: quad.object.value, datatype: quad.object.datatype?.value, language: quad.object.language }
      : { termType: quad.object.termType, value: quad.object.value },
    graph: { termType: 'NamedNode', value: DATA_GRAPH },
  }));

  await rdfManager.applyBatch({ adds, options: { suppressSubjects: false } }, DATA_GRAPH);

  // 5. Resolve next step and create next Activity on canvas if one exists
  const stepQuads: any[] = await worker.call('getQuads', {
    subject: activityIri,
    predicate: `${PPLAN_NS}correspondsToStep`,
    graphName: DATA_GRAPH,
  }) ?? [];
  if (stepQuads.length === 0) return null;

  const currentStepIri = stepQuads[0].object.value;

  const planQuads: any[] = await worker.call('getQuads', {
    subject: activityIri,
    predicate: `${PROV_NS}hadPlan`,
    graphName: DATA_GRAPH,
  }) ?? [];
  if (planQuads.length === 0) return null;

  const planIri = planQuads[0].object.value;

  const nextStepIri = await resolveNextStep(currentStepIri, planIri);
  if (!nextStepIri) return null;

  // Derive next Activity IRI from current (append or increment -step-N suffix)
  const runBase = activityIri.replace(/-step-\d+$/, '');
  const stepIndex = parseInt(activityIri.match(/-step-(\d+)$/)?.[1] ?? '0');
  const nextActivityIri = `${runBase}-step-${stepIndex + 1}`;

  // Read next step label from workflows graph
  const nextStepLabelQuads: any[] = await worker.call('getQuads', {
    subject: nextStepIri,
    predicate: `${RDFS_NS}label`,
    graphName: WORKFLOWS_GRAPH,
  }) ?? [];
  const nextLabel = nextStepLabelQuads[0]?.object?.value ?? nextStepIri.split(/[#/]/).pop() ?? 'Step';

  // Inherit resources and agent from the next template step
  const nextStepUsedQuads: any[] = await worker.call('getQuads', {
    subject: nextStepIri,
    predicate: `${PROV_NS}used`,
    graphName: WORKFLOWS_GRAPH,
  }) ?? [];
  const nextStepAgentQuads: any[] = await worker.call('getQuads', {
    subject: nextStepIri,
    predicate: `${PROV_NS}wasAssociatedWith`,
    graphName: WORKFLOWS_GRAPH,
  }) ?? [];

  // Write next Activity triples to data graph
  const nextAdds: any[] = [
    { subject: namedNode(nextActivityIri), predicate: namedNode(`${RDF_NS}type`),                object: namedNode(`${PROV_NS}Activity`) },
    { subject: namedNode(nextActivityIri), predicate: namedNode(`${RDFS_NS}label`),              object: literal(nextLabel) },
    { subject: namedNode(nextActivityIri), predicate: namedNode(`${PPLAN_NS}correspondsToStep`), object: namedNode(nextStepIri) },
    { subject: namedNode(nextActivityIri), predicate: namedNode(`${PROV_NS}hadPlan`),            object: namedNode(planIri) },
    ...nextStepUsedQuads.map((q: any) => ({
      subject: namedNode(nextActivityIri), predicate: namedNode(`${PROV_NS}used`), object: namedNode(q.object.value),
    })),
    ...(nextStepAgentQuads[0] ? [{
      subject: namedNode(nextActivityIri), predicate: namedNode(`${PROV_NS}wasAssociatedWith`), object: namedNode(nextStepAgentQuads[0].object.value),
    }] : []),
  ];

  await rdfManager.applyBatch({ adds: nextAdds }, DATA_GRAPH);

  // Place next Activity on canvas as free-standing node below current
  const actEl = model.elements.find(
    el => el instanceof Reactodia.EntityElement && el.data.id === activityIri
  ) as Reactodia.EntityElement | undefined;

  const nextPos = actEl
    ? { x: actEl.position.x, y: actEl.position.y + 160 }
    : { x: 200, y: 200 };

  const nextElement = model.createElement({
    id: nextActivityIri as Reactodia.ElementIri,
    types: [`${PROV_NS}Activity` as Reactodia.ElementTypeIri],
    properties: {
      [`${RDFS_NS}label`]: [{ termType: 'Literal', value: nextLabel } as Reactodia.Rdf.Literal],
    },
  });
  nextElement.setPosition(nextPos);

  return nextActivityIri;
}
