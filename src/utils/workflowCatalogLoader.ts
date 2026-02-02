/**
 * @fileoverview Workflow Catalog Loader
 * Loads PyodideSemanticWorkflow catalog files from web URLs into the RDF store
 */

import { rdfManager } from "./rdfManager";
import type { AppConfig } from "../stores/appConfigStore";

export interface LoadCatalogResult {
  success: boolean;
  reason?: 'disabled' | 'network-error' | 'parse-error';
  error?: string;
  loadedFiles?: string[];
}

export interface LoadCatalogOptions {
  timeoutMs?: number;
}

const WORKFLOWS_GRAPH = "urn:vg:workflows";
const ONTOLOGIES_GRAPH = "urn:vg:ontologies";
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Load the workflow catalog from configured URLs
 * @param config Application configuration containing workflow catalog settings
 * @param options Loading options (timeout, etc.)
 * @returns Result indicating success or failure with details
 */
export async function loadWorkflowCatalog(
  config: AppConfig,
  options?: LoadCatalogOptions,
): Promise<LoadCatalogResult> {
  if (!config.workflowCatalogEnabled) {
    return { success: false, reason: 'disabled' };
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const loadedFiles: string[] = [];

  try {
    // 1. Load SPW ontology into ontologies graph
    try {
      await rdfManager.loadRDFFromUrl(
        config.workflowCatalogUrls.ontology,
        ONTOLOGIES_GRAPH,
        { timeoutMs },
      );
      loadedFiles.push(config.workflowCatalogUrls.ontology);
    } catch (error) {
      console.error('[WorkflowCatalog] Failed to load SPW ontology:', error);
      return {
        success: false,
        reason: 'network-error',
        error: `Failed to load ontology: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // 2. Load workflow catalog into workflows graph
    try {
      await rdfManager.loadRDFFromUrl(
        config.workflowCatalogUrls.catalog,
        WORKFLOWS_GRAPH,
        { timeoutMs },
      );
      loadedFiles.push(config.workflowCatalogUrls.catalog);
    } catch (error) {
      console.error('[WorkflowCatalog] Failed to load catalog:', error);
      return {
        success: false,
        reason: 'network-error',
        error: `Failed to load catalog: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    // 3. Load UI metadata into workflows graph (optional - don't fail if this doesn't work)
    try {
      await rdfManager.loadRDFFromUrl(
        config.workflowCatalogUrls.catalogUi,
        WORKFLOWS_GRAPH,
        { timeoutMs },
      );
      loadedFiles.push(config.workflowCatalogUrls.catalogUi);
    } catch (error) {
      // UI metadata is optional - log warning but don't fail
      console.warn('[WorkflowCatalog] UI metadata could not be loaded (this is optional):', error);
      // Continue without UI metadata
    }

    return { success: true, loadedFiles };
  } catch (error) {
    console.error('[WorkflowCatalog] Unexpected error:', error);
    return {
      success: false,
      reason: 'parse-error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Clear workflow catalog data from the store
 */
export async function clearWorkflowCatalog(): Promise<void> {
  try {
    rdfManager.removeGraph(WORKFLOWS_GRAPH);
    console.log('[WorkflowCatalog] Cleared workflows graph');
  } catch (error) {
    console.error('[WorkflowCatalog] Failed to clear workflows graph:', error);
  }
}

/**
 * Get counts of loaded workflow catalog triples
 */
export async function getWorkflowCatalogStats(): Promise<{
  workflowsGraphSize: number;
  ontologiesGraphSize: number;
}> {
  try {
    const counts = await rdfManager.getGraphCounts();
    return {
      workflowsGraphSize: counts[WORKFLOWS_GRAPH] || 0,
      ontologiesGraphSize: counts[ONTOLOGIES_GRAPH] || 0,
    };
  } catch (error) {
    console.error('[WorkflowCatalog] Failed to get stats:', error);
    return {
      workflowsGraphSize: 0,
      ontologiesGraphSize: 0,
    };
  }
}
