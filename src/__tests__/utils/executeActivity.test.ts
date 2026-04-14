import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initRdfManagerWorker } from './initRdfManagerWorker';
import { rdfManager } from '../../utils/rdfManager';
import { loadWorkflowCatalog } from '../../utils/workflowCatalogLoader';
import { resolveNextStep } from '../../utils/executeActivity';
import type { AppConfig } from '../../stores/appConfigStore';

const CATALOG_BASE = 'https://raw.githubusercontent.com/ThHanke/PyodideSemanticWorkflow/main';

const testConfig: AppConfig = {
  workflowCatalogEnabled: true,
  workflowCatalogUrls: {
    ontology: `${CATALOG_BASE}/ontology/spw.ttl`,
    catalog: `${CATALOG_BASE}/workflows/catalog.ttl`,
    catalogUi: `${CATALOG_BASE}/workflows/catalog-ui.ttl`,
  },
  loadWorkflowCatalogOnStartup: true,
  currentLayout: 'horizontal',
  layoutAnimations: true,
  layoutSpacing: 120,
  autoApplyLayout: true,
  showLegend: false,
  viewMode: 'abox',
  canvasTheme: 'auto',
  tooltipEnabled: true,
  autoReasoning: false,
  maxVisibleNodes: 1000,
  reasoningRulesets: [],
  debugRdfLogging: false,
  debugAll: false,
  recentOntologies: [],
  recentLayouts: [],
  additionalOntologies: [],
  persistedAutoload: false,
  blacklistEnabled: false,
  blacklistedPrefixes: [],
  blacklistedUris: [],
};

describe('resolveNextStep', () => {
  beforeEach(async () => {
    await initRdfManagerWorker();
    rdfManager.clear();
    await loadWorkflowCatalog(testConfig, { timeoutMs: 60000 });
  });

  it('returns null for a single-step workflow', async () => {
    const stepIri = 'https://thhanke.github.io/PyodideSemanticWorkflow#SumStep';
    const planIri = 'https://thhanke.github.io/PyodideSemanticWorkflow#SumTemplate';
    const result = await resolveNextStep(stepIri, planIri);
    expect(result).toBeNull();
  });

  it('returns the successor step IRI for a two-step workflow', async () => {
    const stepIri = 'https://thhanke.github.io/PyodideSemanticWorkflow#LoadCSVWColumnStep';
    const planIri = 'https://thhanke.github.io/PyodideSemanticWorkflow#CSVWAverageTemplate';
    const result = await resolveNextStep(stepIri, planIri);
    expect(result).toBe('https://thhanke.github.io/PyodideSemanticWorkflow#CalculateAverageStep');
  });
});
