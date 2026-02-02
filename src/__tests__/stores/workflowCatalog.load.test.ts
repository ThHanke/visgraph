/**
 * @fileoverview Integration tests for workflow catalog loading from web
 * Tests loading from actual GitHub URLs to validate end-to-end functionality
 */

import { describe, expect, it, beforeEach } from "vitest";
import { rdfManager } from "../../utils/rdfManager";
import { initRdfManagerWorker } from "../utils/initRdfManagerWorker";
import { loadWorkflowCatalog, clearWorkflowCatalog, getWorkflowCatalogStats } from "../../utils/workflowCatalogLoader";
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
  // Minimal config for testing
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

describe("Workflow Catalog Loading from Web", () => {
  beforeEach(async () => {
    await initRdfManagerWorker();
    rdfManager.clear();
  });

  it("returns disabled status when catalog is disabled", async () => {
    const disabledConfig = { ...testConfig, workflowCatalogEnabled: false };
    const result = await loadWorkflowCatalog(disabledConfig);
    
    expect(result.success).toBe(false);
    expect(result.reason).toBe('disabled');
  });

  it("loads SPW ontology into urn:vg:ontologies graph", async () => {
    await rdfManager.loadRDFFromUrl(
      testConfig.workflowCatalogUrls.ontology,
      "urn:vg:ontologies",
    );
    
    const counts = await rdfManager.getGraphCounts();
    expect(counts["urn:vg:ontologies"]).toBeGreaterThan(0);
    
    // Verify specific SPW ontology content exists
    const quads = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:ontologies",
      filter: { 
        subject: "https://github.com/ThHanke/PyodideSemanticWorkflow#expectedType" 
      },
    });
    
    expect(quads.total).toBeGreaterThan(0);
  });

  it("loads workflow catalog.ttl into urn:vg:workflows graph", async () => {
    await rdfManager.loadRDFFromUrl(
      testConfig.workflowCatalogUrls.catalog,
      "urn:vg:workflows",
    );
    
    const counts = await rdfManager.getGraphCounts();
    expect(counts["urn:vg:workflows"]).toBeGreaterThan(0);
    
    // Verify SumTemplate exists
    const sumTemplateQuads = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:workflows",
      filter: { 
        subject: "https://github.com/ThHanke/PyodideSemanticWorkflow#SumTemplate" 
      },
    });
    
    expect(sumTemplateQuads.total).toBeGreaterThan(0);
  });

  it("loads catalog-ui.ttl into urn:vg:workflows graph", async () => {
    await rdfManager.loadRDFFromUrl(
      testConfig.workflowCatalogUrls.catalogUi,
      "urn:vg:workflows",
    );
    
    const counts = await rdfManager.getGraphCounts();
    expect(counts["urn:vg:workflows"]).toBeGreaterThan(0);
    
    // Verify UI metadata exists (schema:image for SumTemplate)
    const uiQuads = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:workflows",
      filter: { 
        subject: "https://github.com/ThHanke/PyodideSemanticWorkflow#SumTemplate",
        predicate: "https://schema.org/image",
      },
    });
    
    expect(uiQuads.total).toBeGreaterThan(0);
  });

  it("loads complete workflow catalog with loadWorkflowCatalog function", async () => {
    const result = await loadWorkflowCatalog(testConfig, { timeoutMs: 60000 });
    
    expect(result.success).toBe(true);
    expect(result.loadedFiles).toHaveLength(3);
    expect(result.loadedFiles).toContain(testConfig.workflowCatalogUrls.ontology);
    expect(result.loadedFiles).toContain(testConfig.workflowCatalogUrls.catalog);
    expect(result.loadedFiles).toContain(testConfig.workflowCatalogUrls.catalogUi);
    
    const counts = await rdfManager.getGraphCounts();
    expect(counts["urn:vg:ontologies"]).toBeGreaterThan(0);
    expect(counts["urn:vg:workflows"]).toBeGreaterThan(50); // Should have many triples
  });

  it("verifies all three workflow templates are present", async () => {
    const result = await loadWorkflowCatalog(testConfig, { timeoutMs: 60000 });
    expect(result.success).toBe(true);
    
    const templates = ["SumTemplate", "MultiplyTemplate", "ConvertTemplate"];
    
    for (const template of templates) {
      const quads = await rdfManager.fetchQuadsPage({
        graphName: "urn:vg:workflows",
        filter: { 
          subject: `https://github.com/ThHanke/PyodideSemanticWorkflow#${template}` 
        },
      });
      
      expect(quads.total).toBeGreaterThan(0);
    }
  });

  it("verifies workflow templates have p-plan:Plan type", async () => {
    await loadWorkflowCatalog(testConfig, { timeoutMs: 60000 });
    
    // Check that SumTemplate is a p-plan:Plan
    const planQuads = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:workflows",
      filter: { 
        subject: "https://github.com/ThHanke/PyodideSemanticWorkflow#SumTemplate",
        predicate: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
      },
    });
    
    expect(planQuads.total).toBeGreaterThan(0);
    
    // Verify at least one type is p-plan:Plan
    const hasPlanType = planQuads.quads?.some(
      (q: any) => q.object?.value === "http://purl.org/net/p-plan#Plan"
    );
    expect(hasPlanType).toBe(true);
  });

  it("verifies SPW ontology properties are loaded", async () => {
    await loadWorkflowCatalog(testConfig, { timeoutMs: 60000 });
    
    // Check for spw:expectedType property definition
    const expectedTypeQuads = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:ontologies",
      filter: { 
        subject: "https://github.com/ThHanke/PyodideSemanticWorkflow#expectedType",
      },
    });
    
    expect(expectedTypeQuads.total).toBeGreaterThan(0);
    
    // Check for spw:required property definition
    const requiredQuads = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:ontologies",
      filter: { 
        subject: "https://github.com/ThHanke/PyodideSemanticWorkflow#required",
      },
    });
    
    expect(requiredQuads.total).toBeGreaterThan(0);
  });

  it("can clear workflow catalog", async () => {
    await loadWorkflowCatalog(testConfig, { timeoutMs: 60000 });
    
    let counts = await rdfManager.getGraphCounts();
    expect(counts["urn:vg:workflows"]).toBeGreaterThan(0);
    
    await clearWorkflowCatalog();
    
    counts = await rdfManager.getGraphCounts();
    expect(counts["urn:vg:workflows"] || 0).toBe(0);
  });

  it("can get workflow catalog stats", async () => {
    await loadWorkflowCatalog(testConfig, { timeoutMs: 60000 });
    
    const stats = await getWorkflowCatalogStats();
    
    expect(stats.workflowsGraphSize).toBeGreaterThan(0);
    expect(stats.ontologiesGraphSize).toBeGreaterThan(0);
  });

  it("handles network errors gracefully with invalid URL", async () => {
    const badConfig = {
      ...testConfig,
      workflowCatalogUrls: {
        ontology: "https://invalid-url-12345.com/fake.ttl",
        catalog: testConfig.workflowCatalogUrls.catalog,
        catalogUi: testConfig.workflowCatalogUrls.catalogUi,
      },
    };
    
    const result = await loadWorkflowCatalog(badConfig, { timeoutMs: 5000 });
    
    expect(result.success).toBe(false);
    expect(result.reason).toBe('network-error');
    expect(result.error).toBeDefined();
  });

  it("loads workflow input/output variables", async () => {
    await loadWorkflowCatalog(testConfig, { timeoutMs: 60000 });
    
    // Check SumInput1 variable exists
    const inputQuads = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:workflows",
      filter: { 
        subject: "https://github.com/ThHanke/PyodideSemanticWorkflow#SumInput1",
      },
    });
    
    expect(inputQuads.total).toBeGreaterThan(0);
    
    // Check SumOutput variable exists
    const outputQuads = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:workflows",
      filter: { 
        subject: "https://github.com/ThHanke/PyodideSemanticWorkflow#SumOutput",
      },
    });
    
    expect(outputQuads.total).toBeGreaterThan(0);
  });

  it("loads workflow implementation code references", async () => {
    await loadWorkflowCatalog(testConfig, { timeoutMs: 60000 });
    
    // Check SumCode entity exists
    const codeQuads = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:workflows",
      filter: { 
        subject: "https://github.com/ThHanke/PyodideSemanticWorkflow#SumCode",
      },
    });
    
    expect(codeQuads.total).toBeGreaterThan(0);
    
    // Verify it has prov:atLocation
    const locationQuads = await rdfManager.fetchQuadsPage({
      graphName: "urn:vg:workflows",
      filter: { 
        subject: "https://github.com/ThHanke/PyodideSemanticWorkflow#SumCode",
        predicate: "http://www.w3.org/ns/prov#atLocation",
      },
    });
    
    expect(locationQuads.total).toBeGreaterThan(0);
  });
});
