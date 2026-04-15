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

function extractLocalName(iri: string): string {
  const i = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
  return i >= 0 ? iri.substring(i + 1) : iri;
}

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

  // 2. Remove stale output from any previous run of this activity.
  //    Find all entities with prov:wasGeneratedBy activityIri, remove their data
  //    AND their canvas elements so reruns start visually clean.
  const prevGeneratedIris = new Set<string>();
  {
    const prevQuads: any[] = await worker.call('getQuads', {
      predicate: `${PROV_NS}wasGeneratedBy`,
      object: { termType: 'NamedNode', value: activityIri },
      graphName: DATA_GRAPH,
    }) ?? [];
    console.debug('[executeActivity] prev generated quads:', prevQuads.length, prevQuads.map((q: any) => q.subject?.value));
    for (const q of prevQuads) prevGeneratedIris.add(q.subject.value);
  }

  if (prevGeneratedIris.size > 0) {
    // Also collect prov:hadMember children (collection value entities)
    for (const entityIri of [...prevGeneratedIris]) {
      const memberQuads: any[] = await worker.call('getQuads', {
        subject: entityIri,
        predicate: `${PROV_NS}hadMember`,
        graphName: DATA_GRAPH,
      }) ?? [];
      for (const mq of memberQuads) prevGeneratedIris.add(mq.object.value);
    }

    // Remove canvas elements for stale entities
    for (const entityIri of prevGeneratedIris) {
      const el = model.elements.find(
        e => e instanceof Reactodia.EntityElement && e.data.id === entityIri
      ) as Reactodia.EntityElement | undefined;
      if (el) model.removeElement(el.id);
    }

    // Remove data from store — send syncBatch directly to worker with proper
    // WorkerTerm objects so deserializeTerm handles Literal datatypes correctly.
    // (rdfManager.removeTriple / applyBatch go through coerceWorkerTerm which
    //  drops datatype info from non-string Literals when passed as plain objects.)
    const removeUpdates: any[] = [];
    for (const entityIri of prevGeneratedIris) {
      const entityQuads: any[] = await worker.call('getQuads', {
        subject: entityIri,
        graphName: DATA_GRAPH,
      }) ?? [];
      for (const eq of entityQuads) {
        removeUpdates.push({
          subject:   eq.subject,
          predicate: eq.predicate,
          object:    eq.object,
          graph:     eq.graph ?? { termType: 'NamedNode', value: DATA_GRAPH },
        });
      }
    }
    console.debug('[executeActivity] removing', removeUpdates.length, 'quads for', prevGeneratedIris.size, 'entities');
    if (removeUpdates.length > 0) {
      await worker.call('syncBatch', {
        graphName: DATA_GRAPH,
        adds: [],
        removes: removeUpdates,
      });
    }
  }
  console.debug('[executeActivity] cleanup done, prevGeneratedIris:', [...prevGeneratedIris]);

  // 3. Export data graph as Turtle, execute Python via Pyodide
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

  // 5. Parse output Turtle and write back to data graph
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

  // Place newly generated entities on canvas (result or error annotation)
  // and refresh all existing element data.
  const newGeneratedIris: string[] = [];
  for (const quad of quads) {
    if (quad.predicate.value === `${PROV_NS}wasGeneratedBy` &&
        quad.object.value === activityIri &&
        quad.subject.termType === 'NamedNode') {
      newGeneratedIris.push(quad.subject.value);
    }
  }
  console.debug('[executeActivity] new generated IRIs:', newGeneratedIris);
  const actEl = model.elements.find(
    el => el instanceof Reactodia.EntityElement && el.data.id === activityIri
  ) as Reactodia.EntityElement | undefined;
  for (let i = 0; i < newGeneratedIris.length; i++) {

    const iri = newGeneratedIris[i];
    const existing = model.elements.find(
      el => el instanceof Reactodia.EntityElement && el.data.id === iri
    );
    if (!existing) {
      const el = model.createElement({
        id: iri as Reactodia.ElementIri,
        types: [],
        properties: {},
      });
      el.setPosition(actEl
        ? { x: actEl.position.x + (i + 1) * 220, y: actEl.position.y }
        : { x: 400, y: 300 });
    }
  }
  await model.requestData();

  // 6. Resolve next step and create next Activity on canvas if one exists
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

  // Find variables that are output of currentStep AND input of nextStep (the "wire")
  const currentStepOutVarQuads: any[] = await worker.call('getQuads', {
    predicate: `${PPLAN_NS}isOutputVarOf`,
    object: { termType: 'NamedNode', value: currentStepIri },
    graphName: WORKFLOWS_GRAPH,
  }) ?? [];
  const nextStepInVarQuads: any[] = await worker.call('getQuads', {
    predicate: `${PPLAN_NS}isInputVarOf`,
    object: { termType: 'NamedNode', value: nextStepIri },
    graphName: WORKFLOWS_GRAPH,
  }) ?? [];
  const nextStepInVarSet = new Set(nextStepInVarQuads.map((q: any) => q.subject.value));
  const sharedVarIris = currentStepOutVarQuads
    .map((q: any) => q.subject.value)
    .filter((v: string) => nextStepInVarSet.has(v));

  // For each shared var, find the run-level entity already in the data graph
  // (written by the Python script via pplan:correspondsToVariable)
  const intermediateEntityIris: string[] = [];
  for (const varIri of sharedVarIris) {
    const entityQuads: any[] = await worker.call('getQuads', {
      predicate: `${PPLAN_NS}correspondsToVariable`,
      object: { termType: 'NamedNode', value: varIri },
      graphName: DATA_GRAPH,
    }) ?? [];
    for (const eq of entityQuads) intermediateEntityIris.push(eq.subject.value);
  }

  // Find output vars of the next step so we can create placeholders
  const nextStepOutVarQuads: any[] = await worker.call('getQuads', {
    predicate: `${PPLAN_NS}isOutputVarOf`,
    object: { termType: 'NamedNode', value: nextStepIri },
    graphName: WORKFLOWS_GRAPH,
  }) ?? [];
  const nextOutputVarIris: string[] = nextStepOutVarQuads.map((q: any) => q.subject.value);

  // Write next Activity triples to data graph
  const nextAdds: any[] = [
    { subject: namedNode(nextActivityIri), predicate: namedNode(`${RDF_NS}type`),                object: namedNode(`${PROV_NS}Activity`) },
    { subject: namedNode(nextActivityIri), predicate: namedNode(`${RDF_NS}type`),                object: namedNode(`${PPLAN_NS}Activity`) },
    { subject: namedNode(nextActivityIri), predicate: namedNode(`${RDFS_NS}label`),              object: literal(nextLabel) },
    { subject: namedNode(nextActivityIri), predicate: namedNode(`${PPLAN_NS}correspondsToStep`), object: namedNode(nextStepIri) },
    { subject: namedNode(nextActivityIri), predicate: namedNode(`${PROV_NS}hadPlan`),            object: namedNode(planIri) },
    ...nextStepUsedQuads.map((q: any) => ({
      subject: namedNode(nextActivityIri), predicate: namedNode(`${PROV_NS}used`), object: namedNode(q.object.value),
    })),
    ...(nextStepAgentQuads[0] ? [{
      subject: namedNode(nextActivityIri), predicate: namedNode(`${PROV_NS}wasAssociatedWith`), object: namedNode(nextStepAgentQuads[0].object.value),
    }] : []),
    // Wire intermediate data entities as prov:used inputs of nextActivity
    ...intermediateEntityIris.map(entityIri => ({
      subject: namedNode(nextActivityIri), predicate: namedNode(`${PROV_NS}used`), object: namedNode(entityIri),
    })),
  ];

  // Create output var instance placeholders for the next step's outputs
  for (const varIri of nextOutputVarIris) {
    const instanceIri = `${nextActivityIri}_${extractLocalName(varIri)}`;
    nextAdds.push(
      { subject: namedNode(instanceIri), predicate: namedNode(`${RDF_NS}type`),                   object: namedNode(`${PPLAN_NS}Entity`) },
      { subject: namedNode(instanceIri), predicate: namedNode(`${RDF_NS}type`),                   object: namedNode(`${PROV_NS}Entity`) },
      { subject: namedNode(instanceIri), predicate: namedNode(`${PPLAN_NS}correspondsToVariable`), object: namedNode(varIri) },
      { subject: namedNode(instanceIri), predicate: namedNode(`${PROV_NS}wasGeneratedBy`),         object: namedNode(nextActivityIri) },
    );
  }

  await rdfManager.applyBatch({ adds: nextAdds }, DATA_GRAPH);

  // Place next Activity on canvas as free-standing node below current
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

  // Place output var instance placeholders on canvas
  for (let i = 0; i < nextOutputVarIris.length; i++) {
    const varIri = nextOutputVarIris[i];
    const instanceIri = `${nextActivityIri}_${extractLocalName(varIri)}`;
    const outEl = model.createElement({
      id: instanceIri as Reactodia.ElementIri,
      types: [`${PPLAN_NS}Entity` as Reactodia.ElementTypeIri],
      properties: {
        [`${RDFS_NS}label`]: [{ termType: 'Literal', value: extractLocalName(varIri) } as Reactodia.Rdf.Literal],
      },
    });
    outEl.setPosition({ x: nextPos.x + (i + 1) * 200, y: nextPos.y });
  }

  return nextActivityIri;
}
