/**
 * @fileoverview Workflow Template Instantiator
 * Creates workflow run instances from templates in the catalog
 */

import { rdfManager } from "./rdfManager";
import type { NodeData, LinkData } from "../types/canvas";
import { DataFactory } from "n3";
import { useOntologyStore } from "../stores/ontologyStore";

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

export interface WorkflowInstance {
  planNode: NodeData;
  variableNodes: NodeData[];
  stepNodes: NodeData[];
  edges: LinkData[];
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
      const namespaces = (mgr as any).getNamespaces() || {};
      // Look for the empty prefix ("")
      if (namespaces[""] && typeof namespaces[""] === 'string') {
        return namespaces[""];
      }
    }
    // Fallback to default
    return "http://example.com/";
  } catch (error) {
    console.warn('[WorkflowInstantiator] Failed to get default namespace, using fallback', error);
    return "http://example.com/";
  }
}

/**
 * Ensure namespaces from the template IRIs are registered
 */
async function ensureTemplateNamespaces(template: WorkflowTemplate): Promise<void> {
  try {
    // Extract namespaces from template IRIs
    const namespaces = new Set<string>();
    
    // Add template plan namespace
    const planNs = extractNamespace(template.iri);
    if (planNs) namespaces.add(planNs);
    
    // Add step namespaces
    for (const step of template.steps) {
      const stepNs = extractNamespace(step.iri);
      if (stepNs) namespaces.add(stepNs);
    }
    
    // Add variable namespaces
    for (const v of [...template.inputVars, ...template.outputVars]) {
      const varNs = extractNamespace(v.iri);
      if (varNs) namespaces.add(varNs);
    }
    
    // Register namespaces if not already present
    const mgr = rdfManager;
    if (mgr && typeof (mgr as any).getNamespaces === 'function') {
      const existing = (mgr as any).getNamespaces() || {};
      const toAdd: Record<string, string> = {};
      
      for (const ns of namespaces) {
        // Check if this namespace is already registered
        const alreadyRegistered = Object.values(existing).some((v: any) => String(v) === ns);
        if (!alreadyRegistered) {
          // Generate a prefix (use the last segment of the namespace)
          const prefix = generatePrefixForNamespace(ns);
          toAdd[prefix] = ns;
        }
      }
      
      if (Object.keys(toAdd).length > 0 && typeof (mgr as any).setNamespaces === 'function') {
        (mgr as any).setNamespaces(toAdd, { replace: false });
        console.log('[WorkflowInstantiator] Registered namespaces:', toAdd);
      }
    }
  } catch (error) {
    console.warn('[WorkflowInstantiator] Failed to ensure namespaces:', error);
  }
}

/**
 * Extract namespace from an IRI
 */
function extractNamespace(iri: string): string {
  const hashIndex = iri.lastIndexOf('#');
  const slashIndex = iri.lastIndexOf('/');
  const splitIndex = Math.max(hashIndex, slashIndex);
  return splitIndex >= 0 ? iri.substring(0, splitIndex + 1) : "";
}

/**
 * Generate a prefix for a namespace
 */
function generatePrefixForNamespace(namespace: string): string {
  // Try to extract a meaningful prefix from the namespace
  const withoutProtocol = namespace.replace(/^https?:\/\//, '');
  const parts = withoutProtocol.split(/[\/\#]/);
  const lastPart = parts[parts.length - 2] || parts[parts.length - 1] || 'ns';
  return lastPart.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 8);
}

/**
 * Query resources and agents that a Step declares via prov:used and prov:wasAssociatedWith
 * These will be inherited by the Activity during instantiation
 */
async function queryStepResources(stepIri: string): Promise<{
  usedResources: string[];
  associatedAgent: string | null;
}> {
  const usedResources: string[] = [];
  let associatedAgent: string | null = null;

  try {
    // Query prov:used resources from the Step
    const usedQuads = await rdfManager.fetchQuadsPage({
      graphName: WORKFLOWS_GRAPH,
      filter: {
        subject: stepIri,
        predicate: `${PROV_NS}used`,
      },
      limit: 50,
    });

    for (const quad of usedQuads.items || []) {
      const resourceIri = (quad as any).object;
      if (resourceIri && typeof resourceIri === 'string') {
        usedResources.push(resourceIri);
      }
    }

    // Query prov:wasAssociatedWith agent from the Step
    const agentQuads = await rdfManager.fetchQuadsPage({
      graphName: WORKFLOWS_GRAPH,
      filter: {
        subject: stepIri,
        predicate: `${PROV_NS}wasAssociatedWith`,
      },
      limit: 1,
    });

    if (agentQuads.items && agentQuads.items.length > 0) {
      associatedAgent = (agentQuads.items[0] as any).object;
    }

    console.log('[WorkflowInstantiator] Queried Step resources', {
      stepIri,
      usedResources,
      associatedAgent,
    });

    return { usedResources, associatedAgent };
  } catch (error) {
    console.error('[WorkflowInstantiator] Failed to query Step resources:', error);
    return { usedResources: [], associatedAgent: null };
  }
}

/**
 * Query variable data to create input/output entities
 */
async function queryVariableDetails(varIri: string): Promise<{
  label: string;
  expectedType?: string;
}> {
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

  return { label, expectedType };
}

/**
 * Instantiate a workflow template at the given position
 * Creates a workflow RUN (prov:Activity) with inherited resources following Activity Generation Rules
 * 
 * Activity Generation Rules (from PyodideSemanticWorkflow README):
 * ================================================================
 * 
 * Rule 1: Link to Plan/Step
 *   ?activity prov:hadPlan ?plan ;
 *             p-plan:correspondsToStep ?step .
 * 
 * Rule 2: Inherit Step Resources (KEY PATTERN!)
 *   Template declares:  ?step prov:used ?code, ?requirements .
 *   Activity inherits:  ?activity prov:used ?code, ?requirements .
 *   This is why we put prov:used on the Step - it declares what gets inherited!
 * 
 * Rule 3: Add Concrete Data (User-Driven)
 *   User manually creates QuantityValue nodes and connects them to Activity.
 *   ActivityNode.tsx queries prov:used connections during execution.
 *   NOT handled during instantiation - handled by user via canvas + execution.
 * 
 * Rule 4: Associate with Agent
 *   Inherit agent from Step: ?activity prov:wasAssociatedWith ?agent .
 * 
 * Rule 5: Generate Output (Execution-Time)
 *   Output entities are created DURING execution, not at instantiation.
 *   ActivityNode.tsx generates output with prov:wasGeneratedBy.
 * 
 * What this function creates:
 * - Activity nodes (prov:Activity) 
 * - Resource nodes (Code, Requirements from Step.prov:used)
 * - Agent nodes (prov:Agent from Step.prov:wasAssociatedWith)
 * - Plan node (prov:Plan for visualization)
 * - Edges connecting these nodes
 * 
 * What this function does NOT create:
 * - Input entity nodes (user creates QuantityValues manually)
 * - Output entity nodes (generated during execution)
 * - prov:used edges to input entities (created when user draws connections)
 * 
 * @param templateIri - IRI of the workflow template (p-plan:Plan) from catalog
 * @param dropPosition - Canvas position where workflow should be instantiated
 * @returns WorkflowInstance containing nodes and edges to add to canvas
 */
export async function instantiateWorkflow(
  templateIri: string,
  dropPosition: { x: number; y: number },
): Promise<WorkflowInstance> {
  // Get template data
  const templates = await getWorkflowTemplates();
  const template = templates.find((t) => t.iri === templateIri);
  
  if (!template) {
    throw new Error(`Template not found: ${templateIri}`);
  }

  // Create a readable run ID based on template name
  const baseNamespace = getDefaultNamespace();
  const templateName = template.label.replace(/\s+/g, ''); // Remove spaces: "Sum QUDT Quantities" -> "SumQUDTQuantities"
  const timestamp = Date.now();
  const runId = `${templateName}Run_${timestamp}`;
  const runIri = `${baseNamespace}${runId}`;

  console.log('[WorkflowInstantiator] Creating workflow run', {
    template: template.label,
    runIri,
    baseNamespace,
    runId,
  });

  const triplesToAdd: Array<{ subject: any; predicate: any; object: any }> = [];

  // Create execution plan node
  const planIri = `${runIri}/plan`;
  const planLabel = `${template.label} Plan`;
  
  triplesToAdd.push(
    { subject: namedNode(planIri), predicate: namedNode(`${RDF_NS}type`), object: namedNode(`${PPLAN_NS}Plan`) },
    { subject: namedNode(planIri), predicate: namedNode(`${RDF_NS}type`), object: namedNode(`${PROV_NS}Plan`) },
    { subject: namedNode(planIri), predicate: namedNode(`${RDFS_NS}label`), object: literal(planLabel) },
  );

  // Create run activities (prov:Activity) for each step in the template
  const stepNodes: NodeData[] = [];
  const resourceNodes: NodeData[] = [];
  const entityNodes: NodeData[] = [];
  const stepSpacing = 120;
  const stepStartY = dropPosition.y - ((template.steps.length - 1) * stepSpacing) / 2;
  
  // Track resource IRIs to avoid duplicate nodes
  const resourceIriSet = new Set<string>();
  const resourceNodeMap = new Map<string, NodeData>();

  for (let i = 0; i < template.steps.length; i++) {
    const stepTemplate = template.steps[i];
    const stepRunIri = template.steps.length === 1 ? runIri : `${runIri}/step-${i}`;
    const runLabel = `${template.label} Run`;

    // Create prov:Activity for the run (Rule 1: Link to Plan/Step)
    triplesToAdd.push(
      { subject: namedNode(stepRunIri), predicate: namedNode(`${RDF_NS}type`), object: namedNode(`${PROV_NS}Activity`) },
      { subject: namedNode(stepRunIri), predicate: namedNode(`${RDFS_NS}label`), object: literal(runLabel) },
      { subject: namedNode(stepRunIri), predicate: namedNode(`${PPLAN_NS}correspondsToStep`), object: namedNode(stepTemplate.iri) },
      { subject: namedNode(stepRunIri), predicate: namedNode(`${PROV_NS}hadPlan`), object: namedNode(planIri) },
    );

    // Query and inherit resources from the template Step
    const { usedResources, associatedAgent } = await queryStepResources(stepTemplate.iri);

    // Inherit prov:used resources (Rule 2: Code, Requirements, etc.)
    for (const resourceIri of usedResources) {
      triplesToAdd.push({
        subject: namedNode(stepRunIri),
        predicate: namedNode(`${PROV_NS}used`),
        object: namedNode(resourceIri),
      });

      // Create node for this resource if not already created
      if (!resourceIriSet.has(resourceIri)) {
        resourceIriSet.add(resourceIri);
        
        // Query label from the template graph
        const labelQuads = await rdfManager.fetchQuadsPage({
          graphName: WORKFLOWS_GRAPH,
          filter: {
            subject: resourceIri,
            predicate: `${RDFS_NS}label`,
          },
        });
        const resourceLabel = (labelQuads.items?.[0] as any)?.object || extractLocalName(resourceIri);

        // Query rdf:type from the template graph
        const typeQuads = await rdfManager.fetchQuadsPage({
          graphName: WORKFLOWS_GRAPH,
          filter: {
            subject: resourceIri,
            predicate: `${RDF_NS}type`,
          },
          limit: 10,
        });
        const types = (typeQuads.items || []).map((q: any) => q.object).filter(Boolean);

        const resourceNode: NodeData = {
          key: resourceIri,
          iri: resourceIri,
          label: resourceLabel,
          displayPrefixed: resourceLabel,
          rdfTypes: types.length > 0 ? types : ['Resource'],
          literalProperties: [],
          annotationProperties: [],
          visible: true,
          position: {
            x: dropPosition.x - 250,  // Position resources to the left of activity
            y: dropPosition.y - 100 + resourceNodes.length * 80,
          },
        };
        
        resourceNodes.push(resourceNode);
        resourceNodeMap.set(resourceIri, resourceNode);
      }
    }

    // Rule 4: Associate with Agent (inherit from Step)
    if (associatedAgent) {
      triplesToAdd.push({
        subject: namedNode(stepRunIri),
        predicate: namedNode(`${PROV_NS}wasAssociatedWith`),
        object: namedNode(associatedAgent),
      });

      // Create node for the agent if not already created
      if (!resourceIriSet.has(associatedAgent)) {
        resourceIriSet.add(associatedAgent);
        
        // Query label from the template graph
        const labelQuads = await rdfManager.fetchQuadsPage({
          graphName: WORKFLOWS_GRAPH,
          filter: {
            subject: associatedAgent,
            predicate: `${RDFS_NS}label`,
          },
        });
        const agentLabel = (labelQuads.items?.[0] as any)?.object || extractLocalName(associatedAgent);

        // Query rdf:type
        const typeQuads = await rdfManager.fetchQuadsPage({
          graphName: WORKFLOWS_GRAPH,
          filter: {
            subject: associatedAgent,
            predicate: `${RDF_NS}type`,
          },
          limit: 10,
        });
        const types = (typeQuads.items || []).map((q: any) => q.object).filter(Boolean);

        const agentNode: NodeData = {
          key: associatedAgent,
          iri: associatedAgent,
          label: agentLabel,
          displayPrefixed: agentLabel,
          rdfTypes: types.length > 0 ? types : [`${PROV_NS}Agent`],
          literalProperties: [],
          annotationProperties: [],
          visible: true,
          position: {
            x: dropPosition.x - 250,
            y: dropPosition.y + 150,
          },
        };
        
        resourceNodes.push(agentNode);
        resourceNodeMap.set(associatedAgent, agentNode);
      }
    }

    // NOTE: Input/Output entities are NOT created during instantiation.
    // Following Activity Generation Rules from PyodideSemanticWorkflow:
    // - Users manually create QuantityValue nodes and connect them to Activities
    // - ActivityNode.tsx handles reading connected inputs during execution (Rule 3)
    // - Output entities are generated during execution, not at instantiation (Rule 5)

    stepNodes.push({
      key: stepRunIri,
      iri: stepRunIri,
      label: runLabel,
      displayPrefixed: runLabel,
      rdfTypes: [`${PROV_NS}Activity`],
      literalProperties: [],
      annotationProperties: [],
      visible: true,
      position: {
        x: dropPosition.x,
        y: stepStartY + i * stepSpacing,
      },
    });
  }

  // Ensure namespaces from the template are registered
  await ensureTemplateNamespaces(template);

  // Write triples to data graph
  console.log('[WorkflowInstantiator] Writing triples to data graph', {
    tripleCount: triplesToAdd.length,
    graph: DATA_GRAPH,
  });
  
  await rdfManager.applyBatch({ adds: triplesToAdd, removes: [] }, DATA_GRAPH);

  // Create the plan node for visualization
  const planNode: NodeData = {
    key: planIri,
    iri: planIri,
    label: planLabel,
    displayPrefixed: planLabel,
    rdfTypes: [`${PPLAN_NS}Plan`, `${PROV_NS}Plan`],
    literalProperties: [],
    annotationProperties: [],
    visible: true,
    position: {
      x: dropPosition.x + 250,  // Position plan to the right of activity
      y: dropPosition.y,
    },
  };

  // Create edges for all relationships
  const edges: LinkData[] = [];
  
  // Edges for prov:hadPlan connections (Activity -> Plan)
  for (const stepNode of stepNodes) {
    edges.push({
      from: stepNode.iri,
      to: planIri,
      propertyType: `${PROV_NS}hadPlan`,
      propertyUri: `${PROV_NS}hadPlan`,
      label: "hadPlan",
    });
  }

  // Edges for prov:used connections (Activity -> Resource/Entity)
  for (const stepNode of stepNodes) {
    // Get all prov:used objects for this activity
    const usedQuads = await rdfManager.fetchQuadsPage({
      graphName: DATA_GRAPH,
      filter: {
        subject: stepNode.iri,
        predicate: `${PROV_NS}used`,
      },
      limit: 50,
    });

    for (const quad of usedQuads.items || []) {
      const usedIri = (quad as any).object;
      if (usedIri) {
        edges.push({
          from: stepNode.iri,
          to: usedIri,
          propertyType: `${PROV_NS}used`,
          propertyUri: `${PROV_NS}used`,
          label: "used",
        });
      }
    }
  }

  // Edges for prov:wasAssociatedWith connections (Activity -> Agent)
  for (const stepNode of stepNodes) {
    const agentQuads = await rdfManager.fetchQuadsPage({
      graphName: DATA_GRAPH,
      filter: {
        subject: stepNode.iri,
        predicate: `${PROV_NS}wasAssociatedWith`,
      },
      limit: 10,
    });

    for (const quad of agentQuads.items || []) {
      const agentIri = (quad as any).object;
      if (agentIri) {
        edges.push({
          from: stepNode.iri,
          to: agentIri,
          propertyType: `${PROV_NS}wasAssociatedWith`,
          propertyUri: `${PROV_NS}wasAssociatedWith`,
          label: "wasAssociatedWith",
        });
      }
    }
  }

  // NOTE: Entity edges are NOT created during instantiation.
  // Input entities: User manually connects QuantityValues to Activity via canvas
  // Output entities: Created during Activity execution, not at instantiation

  console.log('[WorkflowInstantiator] Created workflow instance', {
    planNode: 1,
    activityNodes: stepNodes.length,
    resourceNodes: resourceNodes.length,
    edges: edges.length,
  });

  return {
    planNode,
    variableNodes: resourceNodes,  // Only resources (Code, Requirements, Agent), not entities
    stepNodes,
    edges,
  };
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
