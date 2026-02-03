/**
 * @fileoverview Tests for workflow instantiator
 */

import { describe, expect, it, beforeEach } from "vitest";
import { rdfManager } from "../../utils/rdfManager";
import { initRdfManagerWorker } from "./initRdfManagerWorker";
import { loadWorkflowCatalog } from "../../utils/workflowCatalogLoader";
import { getWorkflowTemplates } from "../../utils/workflowInstantiator";
import type { AppConfig } from "../../stores/appConfigStore";

const CATALOG_BASE = "https://raw.githubusercontent.com/ThHanke/PyodideSemanticWorkflow/main";

const testConfig: AppConfig = {
  workflowCatalogEnabled: true,
  workflowCatalogUrls: {
    ontology: `${CATALOG_BASE}/ontology/spw.ttl`,
    catalog: `${CATALOG_BASE}/workflows/catalog.ttl`,
    catalogUi: `${CATALOG_BASE}/workflows/catalog-ui.ttl`,
  },
  loadWorkflowCatalogOnStartup: true,
  currentLayout: "horizontal",
  layoutAnimations: true,
  layoutSpacing: 120,
  autoApplyLayout: true,
  showLegend: false,
  viewMode: "abox",
  canvasTheme: "auto",
  tooltipEnabled: true,
  autoReasoning: false,
  maxVisibleNodes: 1000,
  reasoningRulesets: [],
  debugRdfLogging: false,
  debugAll: false,
  recentOntologies: [],
  recentLayouts: [],
  additionalOntologies: [],
  disabledAdditionalOntologies: [],
  persistedAutoload: false,
  blacklistEnabled: false,
  blacklistedPrefixes: [],
  blacklistedUris: [],
};

describe("Workflow Template Instantiator", () => {
  beforeEach(async () => {
    await initRdfManagerWorker();
    rdfManager.clear();
  });

  it("retrieves workflow templates after catalog load", async () => {
    // Load the catalog
    const loadResult = await loadWorkflowCatalog(testConfig, { timeoutMs: 60000 });
    expect(loadResult.success).toBe(true);
    
    // Debug: Check what's actually in the workflows graph
    const allTypesQuads = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:workflows",
      filter: {
        predicate: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
      },
      limit: 100,
    });
    console.log('[TEST] All rdf:type quads in workflows graph:', allTypesQuads.total);
    console.log('[TEST] Result object keys:', Object.keys(allTypesQuads));
    console.log('[TEST] quads length:', allTypesQuads.quads?.length);
    console.log('[TEST] Sample type quad:', JSON.stringify(allTypesQuads.quads?.[0], null, 2));
    
    // Check for SumTemplate specifically
    const sumTemplateQuads = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:workflows",
      filter: {
        subject: "https://thhanke.github.io/PyodideSemanticWorkflow#SumTemplate",
      },
      limit: 50,
    });
    console.log('[TEST] SumTemplate quads:', sumTemplateQuads.total);
    console.log('[TEST] SumTemplate sample:', sumTemplateQuads.quads?.slice(0, 3));
    
    // Now try to get templates
    const templates = await getWorkflowTemplates();
    
    console.log('[TEST] Found templates:', templates);
    
    expect(templates.length).toBeGreaterThanOrEqual(3);
    expect(templates.map(t => t.label)).toContain("Sum QUDT Quantities");
    expect(templates.map(t => t.label)).toContain("Multiply QUDT Quantities");
    expect(templates.map(t => t.label)).toContain("Convert QUDT Units");
  });

  it("templates have correct structure", async () => {
    await loadWorkflowCatalog(testConfig, { timeoutMs: 60000 });
    const templates = await getWorkflowTemplates();
    
    expect(templates.length).toBeGreaterThan(0);
    
    const sumTemplate = templates.find(t => t.label === "Sum QUDT Quantities");
    expect(sumTemplate).toBeDefined();
    expect(sumTemplate?.inputVars.length).toBe(2);
    expect(sumTemplate?.outputVars.length).toBe(1);
    expect(sumTemplate?.steps.length).toBe(1);
  });
});
