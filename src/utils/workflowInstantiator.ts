/**
 * @fileoverview Workflow Template Instantiator
 * Creates workflow run instances from templates in the catalog
 */

import * as Reactodia from '@reactodia/workspace';
import { rdfManager } from "./rdfManager";
import { DataFactory } from "n3";

const { namedNode, literal } = DataFactory;

const WORKFLOWS_GRAPH = "urn:vg:workflows";
const DATA_GRAPH = "urn:vg:data";
const PPLAN_NS = "http://purl.org/net/p-plan#";
const PROV_NS = "http://www.w3.org/ns/prov#";
const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RDFS_NS = "http://www.w3.org/2000/01/rdf-schema#";
const SPW_NS = "https://thhanke.github.io/PyodideSemanticWorkflow#";

export interface WorkflowTemplate {
  iri: string;
  label: string;
  description?: string;
  inputVars: TemplateVariable[];
  outputVars: TemplateVariable[];
  steps: TemplateStep[];
}

export interface TemplateVariable {
  iri: string;
  label: string;
  expectedType?: string;
  required?: boolean;
}

export interface TemplateStep {
  iri: string;
  label: string;
}


/**
 * Query available workflow templates from the catalog
 */
export async function getWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  try {
    // Query all rdf:type triples in the workflows graph
    const allTypeQuads = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:workflows",
      filter: {
        predicate: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
      },
      limit: 200,
    });

    // Filter for entities that have p-plan:Plan as their type
    const planQuads = allTypeQuads.items?.filter(
      (quad: any) => quad.object === `${PPLAN_NS}Plan`
    ) || [];

    const templates: WorkflowTemplate[] = [];

    for (const quad of planQuads) {
      const planIri = (quad as any).subject;
      if (!planIri) continue;

      // Get label
      const labelQuads = await rdfManager.fetchQuadsPage({
        graphName: WORKFLOWS_GRAPH,
        filter: {
          subject: planIri,
          predicate: `${RDFS_NS}label`,
        },
      });
      const label = (labelQuads.items?.[0] as any)?.object || extractLocalName(planIri);

      // Get description
      const descQuads = await rdfManager.fetchQuadsPage({
        graphName: WORKFLOWS_GRAPH,
        filter: {
          subject: planIri,
          predicate: `${RDFS_NS}comment`,
        },
      });
      const description = (descQuads.items?.[0] as any)?.object;

      // Get all variables linked to this plan via p-plan:isVariableOfPlan
      const allVarQuads = await rdfManager.fetchQuadsPage({
        graphName: WORKFLOWS_GRAPH,
        filter: {
          predicate: `${PPLAN_NS}isVariableOfPlan`,
          object: planIri,
        },
        limit: 50,
      });

      const inputVars: TemplateVariable[] = [];
      const outputVars: TemplateVariable[] = [];

      // For each variable, check if it's an input or output
      for (const vq of allVarQuads.items || []) {
        const varIri = (vq as any).subject;
        if (!varIri) continue;

        // Check if this is an input variable (has p-plan:isInputVarOf pointing to any step)
        const isInputQuads = await rdfManager.fetchQuadsPage({
          graphName: WORKFLOWS_GRAPH,
          filter: {
            subject: varIri,
            predicate: `${PPLAN_NS}isInputVarOf`,
          },
          limit: 1,
        });

        // Check if this is an output variable (has p-plan:isOutputVarOf pointing to any step)
        const isOutputQuads = await rdfManager.fetchQuadsPage({
          graphName: WORKFLOWS_GRAPH,
          filter: {
            subject: varIri,
            predicate: `${PPLAN_NS}isOutputVarOf`,
          },
          limit: 1,
        });

        const varData = await getVariableData(varIri);

        if (isInputQuads.items && isInputQuads.items.length > 0) {
          inputVars.push(varData);
        }
        if (isOutputQuads.items && isOutputQuads.items.length > 0) {
          outputVars.push(varData);
        }
      }

      // Get steps (steps link TO the plan via p-plan:isStepOfPlan)
      const stepQuads = await rdfManager.fetchQuadsPage({
        graphName: WORKFLOWS_GRAPH,
        filter: {
          predicate: `${PPLAN_NS}isStepOfPlan`,
          object: planIri,
        },
        limit: 50,
      });

      const steps: TemplateStep[] = [];
      for (const sq of stepQuads.items || []) {
        const stepIri = (sq as any).subject;
        if (stepIri) {
          const stepLabelQuads = await rdfManager.fetchQuadsPage({
            graphName: WORKFLOWS_GRAPH,
            filter: {
              subject: stepIri,
              predicate: `${RDFS_NS}label`,
            },
          });
          const stepLabel = (stepLabelQuads.items?.[0] as any)?.object || extractLocalName(stepIri);
          steps.push({ iri: stepIri, label: stepLabel });
        }
      }

      templates.push({
        iri: planIri,
        label,
        description,
        inputVars,
        outputVars,
        steps,
      });
    }

    return templates;
  } catch (error) {
    console.error('[WorkflowInstantiator] Failed to get templates:', error);
    return [];
  }
}

/**
 * Get variable metadata from the workflows graph
 */
async function getVariableData(varIri: string): Promise<TemplateVariable> {
  const labelQuads = await rdfManager.fetchQuadsPage({
    graphName: WORKFLOWS_GRAPH,
    filter: {
      subject: varIri,
      predicate: `${RDFS_NS}label`,
    },
  });
  const label = (labelQuads.items?.[0] as any)?.object || extractLocalName(varIri);

  const typeQuads = await rdfManager.fetchQuadsPage({
    graphName: WORKFLOWS_GRAPH,
    filter: {
      subject: varIri,
      predicate: `${SPW_NS}expectedType`,
    },
  });
  const expectedType = (typeQuads.items?.[0] as any)?.object;

  const requiredQuads = await rdfManager.fetchQuadsPage({
    graphName: WORKFLOWS_GRAPH,
    filter: {
      subject: varIri,
      predicate: `${SPW_NS}required`,
    },
  });
  const required = (requiredQuads.items?.[0] as any)?.object === "true";

  return { iri: varIri, label, expectedType, required };
}

/**
 * Get the default/empty prefix namespace URI from the rdfManager
 */
function getDefaultNamespace(): string {
  try {
    const mgr = rdfManager;
    if (mgr && typeof (mgr as any).getNamespaces === 'function') {
      const entries: Array<{ prefix: string; uri: string }> = (mgr as any).getNamespaces() || [];
      const defaultEntry = entries.find((e: any) => e.prefix === "");
      if (defaultEntry && defaultEntry.uri) return defaultEntry.uri;
    }
    return "http://example.com/";
  } catch (error) {
    console.warn('[WorkflowInstantiator] Failed to get default namespace, using fallback', error);
    return "http://example.com/";
  }
}

/**
 * Query resources and agents that a Step declares via prov:used and prov:wasAssociatedWith
 */
async function queryStepResources(stepIri: string): Promise<{
  usedResources: string[];
  associatedAgent: string | null;
}> {
  const usedResources: string[] = [];
  let associatedAgent: string | null = null;

  try {
    const usedQuads = await rdfManager.fetchQuadsPage({
      graphName: WORKFLOWS_GRAPH,
      filter: { subject: stepIri, predicate: `${PROV_NS}used` },
      limit: 50,
    });
    for (const quad of usedQuads.items || []) {
      const resourceIri = (quad as any).object;
      if (resourceIri && typeof resourceIri === 'string') usedResources.push(resourceIri);
    }

    const agentQuads = await rdfManager.fetchQuadsPage({
      graphName: WORKFLOWS_GRAPH,
      filter: { subject: stepIri, predicate: `${PROV_NS}wasAssociatedWith` },
      limit: 1,
    });
    if (agentQuads.items && agentQuads.items.length > 0) {
      associatedAgent = (agentQuads.items[0] as any).object;
    }

    return { usedResources, associatedAgent };
  } catch (error) {
    console.error('[WorkflowInstantiator] Failed to query Step resources:', error);
    return { usedResources: [], associatedAgent: null };
  }
}


/**
 * Instantiate a workflow template onto the Reactodia canvas.
 *
 * Template entities (Plan, Steps, Resources, Agent) keep their original IRIs and are
 * copied from urn:vg:workflows into urn:vg:data.
 *
 * Run instances (Activity, input variable instances, output variable instances) receive
 * new IRIs in the default (empty-prefix) namespace.
 */
export async function instantiateWorkflowOnCanvas(
  templateIri: string,
  position: { x: number; y: number },
  model: Reactodia.DataDiagramModel,
  editor: Reactodia.EditorController,
  ctx: Reactodia.WorkspaceContext,
): Promise<void> {
  const triplesToAdd: Array<{ subject: any; predicate: any; object: any }> = [];

  /** Copy ALL subject-quads for an IRI from workflows graph into data graph triples buffer. */
  async function copyEntityToData(iri: string): Promise<void> {
    const quads = await rdfManager.fetchQuadsPage({
      graphName: WORKFLOWS_GRAPH,
      filter: { subject: iri },
      limit: 100,
    });
    for (const q of quads.items ?? []) {
      const quad = q as any;
      if (!quad.predicate || !quad.object) continue;
      const obj = typeof quad.object === 'string' ? namedNode(quad.object) : quad.object;
      triplesToAdd.push({ subject: namedNode(iri), predicate: namedNode(quad.predicate), object: obj });
    }
  }

  // 1. Template label
  const planLabelQuads = await rdfManager.fetchQuadsPage({
    graphName: WORKFLOWS_GRAPH,
    filter: { subject: templateIri, predicate: `${RDFS_NS}label` },
  });
  const templateLabel = (planLabelQuads.items?.[0] as any)?.object || extractLocalName(templateIri);

  // 2. Enumerate steps
  const stepQuads = await rdfManager.fetchQuadsPage({
    graphName: WORKFLOWS_GRAPH,
    filter: { predicate: `${PPLAN_NS}isStepOfPlan`, object: templateIri },
    limit: 100,
  });
  const stepIris: string[] = (stepQuads.items || []).map((q: any) => q.subject).filter(Boolean);
  if (stepIris.length === 0) throw new Error(`No steps found for template ${templateIri}`);

  // 3. Build step→inputVars / step→outputVars maps
  const stepInputVars = new Map<string, string[]>();
  const stepOutputVars = new Map<string, string[]>();
  const allOutputVarIris = new Set<string>();
  const allInputVarIris = new Set<string>();

  for (const stepIri of stepIris) {
    const inVarQuads = await rdfManager.fetchQuadsPage({
      graphName: WORKFLOWS_GRAPH,
      filter: { predicate: `${PPLAN_NS}isInputVarOf`, object: stepIri },
      limit: 50,
    });
    const inVars = (inVarQuads.items || []).map((q: any) => q.subject).filter(Boolean);
    stepInputVars.set(stepIri, inVars);
    inVars.forEach((v: string) => allInputVarIris.add(v));

    const outVarQuads = await rdfManager.fetchQuadsPage({
      graphName: WORKFLOWS_GRAPH,
      filter: { predicate: `${PPLAN_NS}isOutputVarOf`, object: stepIri },
      limit: 50,
    });
    const outVars = (outVarQuads.items || []).map((q: any) => q.subject).filter(Boolean);
    stepOutputVars.set(stepIri, outVars);
    outVars.forEach((v: string) => allOutputVarIris.add(v));
  }

  // 4. Find entry step and last step
  const entryStepIri = stepIris.find(s =>
    (stepInputVars.get(s) ?? []).every(v => !allOutputVarIris.has(v))
  ) ?? stepIris[0];
  const lastStepIri = stepIris.find(s =>
    (stepOutputVars.get(s) ?? []).every(v => !allInputVarIris.has(v))
  ) ?? stepIris[stepIris.length - 1];

  // 5. Entry step resources and agent
  const { usedResources, associatedAgent } = await queryStepResources(entryStepIri);

  // 6. External input vars and last-step output vars
  const externalInputVarIris = (stepInputVars.get(entryStepIri) ?? []).filter(v => !allOutputVarIris.has(v));
  const lastStepOutputVarIris = stepOutputVars.get(lastStepIri) ?? [];

  // 7. Generate run IRIs with default namespace (Activity + var instances)
  const defaultNs = getDefaultNamespace();
  const templateName = templateLabel.replace(/\s+/g, '');
  const timestamp = Date.now();
  const activityIri = `${defaultNs}${templateName}Run_${timestamp}`;
  const activityLabel = `${templateLabel} Run`;

  const inputVarInstanceIris = externalInputVarIris.map(
    varIri => `${defaultNs}${extractLocalName(varIri)}_${timestamp}`
  );
  const outputVarInstanceIris = lastStepOutputVarIris.map(
    varIri => `${defaultNs}${extractLocalName(varIri)}_${timestamp}`
  );

  // 8. Copy ALL template entities to data graph (keep original IRIs)
  await copyEntityToData(templateIri); // Plan
  for (const stepIri of stepIris) await copyEntityToData(stepIri);
  for (const resourceIri of usedResources) await copyEntityToData(resourceIri);
  if (associatedAgent) await copyEntityToData(associatedAgent);
  // Template variable schemas (original IRIs)
  for (const varIri of [...allInputVarIris, ...allOutputVarIris]) {
    await copyEntityToData(varIri);
  }

  // Predicates that are template-structural — must NOT be copied to run instances
  const TEMPLATE_ONLY_PREDICATES = new Set([
    `${PPLAN_NS}isInputVarOf`,
    `${PPLAN_NS}isOutputVarOf`,
    `${PPLAN_NS}isVariableOfPlan`,
    `${PPLAN_NS}correspondsToVariable`,
    `${PPLAN_NS}isStepOfPlan`,
  ]);

  // rdf:type values that belong only at the template level — skip when copying to run instances
  const TEMPLATE_ONLY_TYPES = new Set([
    `${PPLAN_NS}Variable`,
    `${PPLAN_NS}Step`,
    `${PPLAN_NS}Plan`,
  ]);

  /**
   * Copy only metadata from a template variable to a run-level p-plan:Entity instance.
   *
   * Skips:
   *   - Template-structural predicates (isInputVarOf, isVariableOfPlan, …)
   *   - Template-level rdf:type values (p-plan:Variable, p-plan:Step, p-plan:Plan)
   *
   * Keeps:
   *   - rdfs:label, domain-specific types (e.g. qudt:QuantityValue if present),
   *     schema/constraint properties (spw:expectedType, spw:required, …)
   *
   * Adds:
   *   - rdf:type p-plan:Entity  (run-level marker)
   *   - rdf:type prov:Entity
   *   - p-plan:correspondsToVariable → templateVarIri  (run ↔ template bridge)
   */
  async function copyVarMetaToInstance(templateVarIri: string, instanceIri: string): Promise<void> {
    const varQuads = await rdfManager.fetchQuadsPage({
      graphName: WORKFLOWS_GRAPH, filter: { subject: templateVarIri }, limit: 50,
    });
    for (const q of varQuads.items ?? []) {
      const quad = q as any;
      if (!quad.predicate || !quad.object) continue;
      if (TEMPLATE_ONLY_PREDICATES.has(quad.predicate)) continue;
      // For rdf:type, skip template-level types but keep domain types
      if (quad.predicate === `${RDF_NS}type` && TEMPLATE_ONLY_TYPES.has(quad.object)) continue;
      const obj = typeof quad.object === 'string' ? namedNode(quad.object) : quad.object;
      triplesToAdd.push({ subject: namedNode(instanceIri), predicate: namedNode(quad.predicate), object: obj });
    }
    // Promote spw:expectedType → rdf:type on the instance so it carries the domain type
    // specified in the plan (e.g. qudt:QuantityValue, prov:Collection, …)
    const expectedTypeQuads = await rdfManager.fetchQuadsPage({
      graphName: WORKFLOWS_GRAPH,
      filter: { subject: templateVarIri, predicate: `${SPW_NS}expectedType` },
      limit: 10,
    });
    for (const q of expectedTypeQuads.items ?? []) {
      const typeIri = (q as any).object;
      if (typeIri && typeof typeIri === 'string') {
        triplesToAdd.push({
          subject: namedNode(instanceIri),
          predicate: namedNode(`${RDF_NS}type`),
          object: namedNode(typeIri),
        });
      }
    }

    // Run-level typing — p-plan:Entity subclasses prov:Entity so one triple suffices
    triplesToAdd.push(
      { subject: namedNode(instanceIri), predicate: namedNode(`${RDF_NS}type`), object: namedNode(`${PPLAN_NS}Entity`) },
    );
    // Run ↔ template bridge
    triplesToAdd.push({
      subject: namedNode(instanceIri),
      predicate: namedNode(`${PPLAN_NS}correspondsToVariable`),
      object: namedNode(templateVarIri),
    });
  }

  // 9. Activity triples
  triplesToAdd.push(
    { subject: namedNode(activityIri), predicate: namedNode(`${RDF_NS}type`),                object: namedNode(`${PROV_NS}Activity`) },
    // p-plan:Activity subclass marks this as a run-level activity
    { subject: namedNode(activityIri), predicate: namedNode(`${RDF_NS}type`),                object: namedNode(`${PPLAN_NS}Activity`) },
    { subject: namedNode(activityIri), predicate: namedNode(`${RDFS_NS}label`),              object: literal(activityLabel) },
    { subject: namedNode(activityIri), predicate: namedNode(`${PPLAN_NS}correspondsToStep`), object: namedNode(entryStepIri) },
    { subject: namedNode(activityIri), predicate: namedNode(`${PROV_NS}hadPlan`),            object: namedNode(templateIri) },
  );
  // Code/requirements resources (template IRIs are fine here — same as prov:used spw:SumCode)
  for (const resourceIri of usedResources) {
    triplesToAdd.push({ subject: namedNode(activityIri), predicate: namedNode(`${PROV_NS}used`), object: namedNode(resourceIri) });
  }
  if (associatedAgent) {
    triplesToAdd.push({ subject: namedNode(activityIri), predicate: namedNode(`${PROV_NS}wasAssociatedWith`), object: namedNode(associatedAgent) });
  }

  // Helper: get var label from workflows graph
  async function getVarLabel(varIri: string): Promise<string> {
    const lq = await rdfManager.fetchQuadsPage({
      graphName: WORKFLOWS_GRAPH,
      filter: { subject: varIri, predicate: `${RDFS_NS}label` },
    });
    return (lq.items?.[0] as any)?.object ?? extractLocalName(varIri);
  }

  // 10. Input var instances: metadata from template var + p-plan:Entity + correspondsToVariable
  //     Activity prov:used each instance (not the template variable)
  for (let i = 0; i < externalInputVarIris.length; i++) {
    const templateVarIri = externalInputVarIris[i];
    const instanceIri = inputVarInstanceIris[i];
    await copyVarMetaToInstance(templateVarIri, instanceIri);
    triplesToAdd.push({
      subject: namedNode(activityIri),
      predicate: namedNode(`${PROV_NS}used`),
      object: namedNode(instanceIri),
    });
  }

  // 11. Output var instances: metadata from template var + p-plan:Entity + correspondsToVariable
  //     Instance prov:wasGeneratedBy activity
  for (let i = 0; i < lastStepOutputVarIris.length; i++) {
    const templateVarIri = lastStepOutputVarIris[i];
    const instanceIri = outputVarInstanceIris[i];
    await copyVarMetaToInstance(templateVarIri, instanceIri);
    triplesToAdd.push({
      subject: namedNode(instanceIri),
      predicate: namedNode(`${PROV_NS}wasGeneratedBy`),
      object: namedNode(activityIri),
    });
  }

  // 12. Helper: get label + types for a node from workflows graph
  async function getNodeMeta(iri: string): Promise<{ label: string; types: string[] }> {
    const lq = await rdfManager.fetchQuadsPage({
      graphName: WORKFLOWS_GRAPH, filter: { subject: iri, predicate: `${RDFS_NS}label` },
    });
    const label = (lq.items?.[0] as any)?.object ?? extractLocalName(iri);
    const tq = await rdfManager.fetchQuadsPage({
      graphName: WORKFLOWS_GRAPH, filter: { subject: iri, predicate: `${RDF_NS}type` }, limit: 10,
    });
    const types = (tq.items || []).map((q: any) => q.object).filter(Boolean);
    return { label, types };
  }

  // Place all elements at the drop position initially — layout will reposition them
  const allNewElements = new Set<Reactodia.Element>();

  function placeEl(id: string, types: string[], label: string): Reactodia.EntityElement {
    const el = model.createElement({
      id: id as Reactodia.ElementIri,
      types: types as Reactodia.ElementTypeIri[],
      properties: { [`${RDFS_NS}label`]: [{ termType: 'Literal', value: label, language: '' } as any] },
    });
    el.setPosition(position);
    allNewElements.add(el);
    return el;
  }

  // Activity
  placeEl(activityIri, [`${PROV_NS}Activity`, `${PPLAN_NS}Activity`], activityLabel);

  // Group members: Plan + Steps + Resources + Agent + template Variables
  const groupEls: Reactodia.EntityElement[] = [];

  const planMeta = await getNodeMeta(templateIri);
  groupEls.push(placeEl(
    templateIri,
    planMeta.types.length > 0 ? planMeta.types : [`${PPLAN_NS}Plan`],
    planMeta.label,
  ));

  for (const stepIri of stepIris) {
    const meta = await getNodeMeta(stepIri);
    groupEls.push(placeEl(stepIri, meta.types.length > 0 ? meta.types : [`${PPLAN_NS}Step`], meta.label));
  }

  for (const resourceIri of usedResources) {
    const meta = await getNodeMeta(resourceIri);
    groupEls.push(placeEl(resourceIri, meta.types.length > 0 ? meta.types : [`${PROV_NS}Entity`], meta.label));
  }

  if (associatedAgent) {
    const meta = await getNodeMeta(associatedAgent);
    groupEls.push(placeEl(associatedAgent, meta.types.length > 0 ? meta.types : [`${PROV_NS}Agent`], meta.label));
  }

  const allTemplateVarIris = [...allInputVarIris, ...allOutputVarIris];
  for (const varIri of allTemplateVarIris) {
    const meta = await getNodeMeta(varIri);
    groupEls.push(placeEl(varIri, meta.types.length > 0 ? meta.types : [`${PPLAN_NS}Variable`], meta.label));
  }

  // Input var instances (run-scoped)
  for (let i = 0; i < inputVarInstanceIris.length; i++) {
    const varLabel = await getVarLabel(externalInputVarIris[i]);
    placeEl(inputVarInstanceIris[i], [`${PPLAN_NS}Entity`], varLabel);
  }

  // Output var instances (run-scoped)
  for (let i = 0; i < outputVarInstanceIris.length; i++) {
    const varLabel = await getVarLabel(lastStepOutputVarIris[i]);
    placeEl(outputVarInstanceIris[i], [`${PPLAN_NS}Entity`], varLabel);
  }

  // Group template entities together
  if (groupEls.length >= 2) {
    model.group(groupEls);
  }

  // Write all triples to data graph
  await rdfManager.applyBatch({ adds: triplesToAdd }, DATA_GRAPH);

  // Refresh canvas data so links are resolved
  await model.requestData();

  // Apply the canvas layout algorithm to the newly added elements
  await ctx.performLayout({ selectedElements: allNewElements, animate: true, zoomToFit: false });

  console.log('[WorkflowInstantiator] instantiateWorkflowOnCanvas complete', {
    activityIri,
    planIri: templateIri,
    steps: stepIris.length,
    resources: usedResources.length,
    agent: associatedAgent,
    inputVarInstances: inputVarInstanceIris.length,
    outputVarInstances: outputVarInstanceIris.length,
  });
}

/**
 * Extract local name from IRI
 */
function extractLocalName(iri: string): string {
  const hashIndex = iri.lastIndexOf('#');
  const slashIndex = iri.lastIndexOf('/');
  const splitIndex = Math.max(hashIndex, slashIndex);
  return splitIndex >= 0 ? iri.substring(splitIndex + 1) : iri;
}
