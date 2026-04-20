// src/mcp/tools/reasoning.ts
import type { McpTool, McpResult } from '@/mcp/types';
import { rdfManager } from '@/utils/rdfManager';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';
import { VALID_ALGORITHMS, fitCanvasView } from './layout';
const EXPORT_FORMATS = ['turtle', 'jsonld', 'rdfxml', 'svg', 'png'];

// ---------------------------------------------------------------------------
// runReasoning
// ---------------------------------------------------------------------------
const runReasoning: McpTool = {
  name: 'runReasoning',
  description: 'Run OWL/RDFS reasoning over the loaded graph and infer new triples. Pass clearBefore=true to clear previous inferences first.',
  inputSchema: {
    type: 'object',
    properties: {
      clearBefore: { type: 'boolean', default: false },
    },
  },
  async handler(params): Promise<McpResult> {
    try {
      const { clearBefore = false } = (params ?? {}) as { clearBefore?: boolean };
      const { ctx, dataProvider } = getWorkspaceRefs();

      if (clearBefore) {
        await dataProvider.clearInferred();
      }

      // Must pass rulesets from app config — empty array skips all rules
      const cfg = (await import('@/stores/appConfigStore')).useAppConfigStore.getState().config;
      const rulesets: string[] = Array.isArray(cfg?.reasoningRulesets) ? cfg.reasoningRulesets : ['best-practice.n3', 'owl-rl.n3'];
      const result = await rdfManager.runReasoning({ rulesets });
      const inferredTriples = result.meta?.addedCount ?? result.inferences.length;

      await ctx.model.requestData();
      fitCanvasView(ctx);

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
