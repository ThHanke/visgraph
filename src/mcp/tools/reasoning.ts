// src/mcp/tools/reasoning.ts
import type { McpTool, McpResult } from '@/mcp/types';
import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';
import { VALID_ALGORITHMS } from './layout';
const EXPORT_FORMATS = ['turtle', 'jsonld', 'rdfxml', 'svg', 'png'];

// ---------------------------------------------------------------------------
// runReasoning
// ---------------------------------------------------------------------------
const runReasoning: McpTool = {
  name: 'runReasoning',
  description: 'Run OWL/RDFS reasoning over the loaded graph and infer new triples.',
  inputSchema: {
    type: 'object',
  },
  async handler(): Promise<McpResult> {
    try {
      const result = await rdfManager.runReasoning();
      const inferredTriples = result.meta?.addedCount ?? result.inferences.length;
      return { success: true, data: { inferredTriples } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// clearInferred
// ---------------------------------------------------------------------------
const clearInferred: McpTool = {
  name: 'clearInferred',
  description: 'Remove all inferred (reasoned) triples from the graph.',
  inputSchema: {
    type: 'object',
  },
  async handler(): Promise<McpResult> {
    try {
      const { dataProvider } = getWorkspaceRefs();
      await dataProvider.clearInferred();
      return { success: true, data: { cleared: true } };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

// ---------------------------------------------------------------------------
// getCapabilities
// ---------------------------------------------------------------------------
const getCapabilities: McpTool = {
  name: 'getCapabilities',
  description: 'Return the supported layout algorithms and export formats.',
  inputSchema: {
    type: 'object',
  },
  async handler(): Promise<McpResult> {
    try {
      return {
        success: true,
        data: {
          layoutAlgorithms: [...VALID_ALGORITHMS],
          exportFormats: EXPORT_FORMATS,
        },
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  },
};

export const reasoningTools: McpTool[] = [runReasoning, clearInferred, getCapabilities];
