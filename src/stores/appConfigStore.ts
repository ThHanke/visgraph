import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  invariant,
  isPlainObject,
} from "../utils/guards";
import {
  normalizeBoolean,
  normalizeBooleanFlag,
  normalizeNumber,
  normalizeOptionalString,
  normalizeString,
  normalizeStringArray,
  normalizeStringSet,
} from "../utils/normalizers";
import { resolveStateStorage } from "../utils/stateStorage";

export interface WorkflowCatalogUrls {
  ontology: string;
  catalog: string;
  catalogUi: string;
}

export interface AppConfig {
  currentLayout: string;
  layoutAnimations: boolean;
  layoutSpacing: number;
  autoApplyLayout: boolean;
  showLegend: boolean;
  viewMode: "abox" | "tbox";
  canvasTheme: "light" | "dark" | "auto";
  tooltipEnabled: boolean;
  autoReasoning: boolean;
  collapseThreshold: number;
  clusteringAlgorithm: "louvain" | "label-propagation" | "kmeans";
  collapsedNodes: string[];
  reasoningRulesets: string[];
  debugRdfLogging: boolean;
  debugAll: boolean;
  recentOntologies: string[];
  recentLayouts: string[];
  additionalOntologies: string[];
  disabledAdditionalOntologies: string[];
  persistedAutoload: boolean;
  blacklistEnabled: boolean;
  blacklistedPrefixes: string[];
  blacklistedUris: string[];
  workflowCatalogEnabled: boolean;
  workflowCatalogUrls: WorkflowCatalogUrls;
  loadWorkflowCatalogOnStartup: boolean;
}

interface AppConfigStore {
  config: AppConfig;
  setCurrentLayout: (layout: string) => void;
  setLayoutAnimations: (enabled: boolean) => void;
  setLayoutSpacing: (spacing: number) => void;
  setShowLegend: (show: boolean) => void;
  setViewMode: (mode: "abox" | "tbox") => void;
  setCanvasTheme: (theme: "light" | "dark" | "auto") => void;
  setTooltipEnabled: (enabled: boolean) => void;
  setAutoApplyLayout: (enabled: boolean) => void;
  setPersistedAutoload: (enabled: boolean) => void;
  setAutoReasoning: (enabled: boolean) => void;
  setCollapseThreshold: (threshold: number) => void;
  setClusteringAlgorithm: (algorithm: "louvain" | "label-propagation" | "kmeans") => void;
  toggleNodeCollapsed: (iri: string) => void;
  setCollapsedNodes: (iris: string[]) => void;
  setReasoningRulesets: (reasoningRulesets: string[]) => void;
  setDebugRdfLogging: (enabled: boolean) => void;
  setDebugAll: (enabled: boolean) => void;
  setBlacklistEnabled: (enabled: boolean) => void;
  setBlacklistedPrefixes: (prefixes: string[]) => void;
  setBlacklistedUris: (uris: string[]) => void;
  addRecentOntology: (url: string) => void;
  addRecentLayout: (layout: string) => void;
  addAdditionalOntology: (uri: string) => void;
  removeAdditionalOntology: (uri: string) => void;
  addDisabledOntology: (uri: string) => void;
  removeDisabledOntology: (uri: string) => void;
  setWorkflowCatalogEnabled: (enabled: boolean) => void;
  setWorkflowCatalogUrls: (urls: Partial<WorkflowCatalogUrls>) => void;
  setLoadWorkflowCatalogOnStartup: (enabled: boolean) => void;
  resetWorkflowCatalogUrls: () => void;
  resetToDefaults: () => void;
  exportConfig: () => string;
  importConfig: (configJson: string) => void;
}

const STORAGE_KEY = "ontology-painter-config";
const APP_CONFIG_VERSION = 1;
const MIN_LAYOUT_SPACING = 50;
const MAX_LAYOUT_SPACING = 500;
const MIN_COLLAPSE_THRESHOLD = 1;
const MAX_COLLAPSE_THRESHOLD = 100;
const MAX_RECENT_ONTOLOGIES = 10;
const MAX_RECENT_LAYOUTS = 5;

const DEFAULT_WORKFLOW_CATALOG_URLS: WorkflowCatalogUrls = {
  ontology: "https://raw.githubusercontent.com/ThHanke/PyodideSemanticWorkflow/main/ontology/spw.ttl",
  catalog: "https://raw.githubusercontent.com/ThHanke/PyodideSemanticWorkflow/main/workflows/catalog.ttl",
  catalogUi: "https://raw.githubusercontent.com/ThHanke/PyodideSemanticWorkflow/main/workflows/catalog-ui.ttl",
};

// Note: If using a fork or different branch, update these URLs in the Configuration Panel ' Workflows tab

const defaultConfig: AppConfig = {
  currentLayout: "horizontal",
  layoutAnimations: true,
  layoutSpacing: 120,
  autoApplyLayout: true,
  showLegend: false,
  viewMode: "abox",
  canvasTheme: "auto",
  tooltipEnabled: true,
  autoReasoning: false,
  debugRdfLogging: true,
  debugAll: false,
  collapseThreshold: 10,
  clusteringAlgorithm: "louvain",
  collapsedNodes: [],
  reasoningRulesets: ["best-practice.n3", "owl-rl.n3"],
  recentOntologies: [],
  recentLayouts: ["horizontal"],
  additionalOntologies: [
    "http://www.w3.org/2002/07/owl#",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "http://www.w3.org/2000/01/rdf-schema#",
  ],
  disabledAdditionalOntologies: [],
  persistedAutoload: true,
  blacklistEnabled: false,
  blacklistedPrefixes: ["owl", "rdf", "rdfs", "xml", "xsd"],
  blacklistedUris: [
    "http://www.w3.org/2002/07/owl",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "http://www.w3.org/2000/01/rdf-schema#",
    "http://www.w3.org/XML/1998/namespace",
    "http://www.w3.org/2001/XMLSchema#",
  ],
  workflowCatalogEnabled: true,
  workflowCatalogUrls: { ...DEFAULT_WORKFLOW_CATALOG_URLS },
  loadWorkflowCatalogOnStartup: true,
};

function pushRecent(list: string[], value: string, limit: number, context: string): string[] {
  const normalized = normalizeString(value, `${context}.value`);
  const deduped = list.filter((entry) => entry !== normalized);
  return [normalized, ...deduped].slice(0, limit);
}

function normalizeWorkflowCatalogUrls(value: unknown, context: string): WorkflowCatalogUrls {
  if (!isPlainObject(value)) {
    return { ...DEFAULT_WORKFLOW_CATALOG_URLS };
  }
  const input = value as Partial<WorkflowCatalogUrls>;
  return {
    ontology: normalizeOptionalString(input.ontology, `${context}.ontology`) ?? DEFAULT_WORKFLOW_CATALOG_URLS.ontology,
    catalog: normalizeOptionalString(input.catalog, `${context}.catalog`) ?? DEFAULT_WORKFLOW_CATALOG_URLS.catalog,
    catalogUi: normalizeOptionalString(input.catalogUi, `${context}.catalogUi`) ?? DEFAULT_WORKFLOW_CATALOG_URLS.catalogUi,
  };
}

function normalizeAppConfigInput(value: unknown, context: string): AppConfig {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be a plain object`);
  }
  const input = value as Partial<AppConfig>;
  const cfg = defaultConfig;
  const layout = normalizeOptionalString(input.currentLayout, `${context}.currentLayout`) ?? cfg.currentLayout;
  invariant(layout.length > 0, `${context}.currentLayout must not be empty`);
  const layoutSpacing = normalizeNumber(
    input.layoutSpacing ?? cfg.layoutSpacing,
    `${context}.layoutSpacing`,
    { min: MIN_LAYOUT_SPACING, max: MAX_LAYOUT_SPACING },
  );
  const collapseThreshold = normalizeNumber(
    input.collapseThreshold ?? cfg.collapseThreshold,
    `${context}.collapseThreshold`,
    { min: MIN_COLLAPSE_THRESHOLD, max: MAX_COLLAPSE_THRESHOLD },
  );

  const viewMode = input.viewMode ?? cfg.viewMode;
  if (viewMode !== "abox" && viewMode !== "tbox") {
    throw new Error(`${context}.viewMode must be either 'abox' or 'tbox'`);
  }

  const canvasTheme = input.canvasTheme ?? cfg.canvasTheme;
  if (canvasTheme !== "light" && canvasTheme !== "dark" && canvasTheme !== "auto") {
    throw new Error(`${context}.canvasTheme must be 'light', 'dark', or 'auto'`);
  }

  const clusteringAlgorithm = input.clusteringAlgorithm ?? cfg.clusteringAlgorithm;
  if (clusteringAlgorithm !== "louvain" && clusteringAlgorithm !== "label-propagation" && clusteringAlgorithm !== "kmeans") {
    throw new Error(`${context}.clusteringAlgorithm must be 'louvain', 'label-propagation', or 'kmeans'`);
  }

  return {
    currentLayout: layout,
    layoutAnimations: normalizeBooleanFlag(
      input.layoutAnimations,
      `${context}.layoutAnimations`,
      cfg.layoutAnimations,
    ),
    layoutSpacing,
    autoApplyLayout: normalizeBooleanFlag(
      input.autoApplyLayout,
      `${context}.autoApplyLayout`,
      cfg.autoApplyLayout,
    ),
    showLegend: normalizeBooleanFlag(input.showLegend, `${context}.showLegend`, cfg.showLegend),
    viewMode,
    canvasTheme,
    tooltipEnabled: normalizeBooleanFlag(
      input.tooltipEnabled,
      `${context}.tooltipEnabled`,
      cfg.tooltipEnabled,
    ),
    autoReasoning: normalizeBooleanFlag(
      input.autoReasoning,
      `${context}.autoReasoning`,
      cfg.autoReasoning,
    ),
    collapseThreshold,
    clusteringAlgorithm,
    collapsedNodes: normalizeStringArray(
      input.collapsedNodes ?? cfg.collapsedNodes,
      `${context}.collapsedNodes`,
    ),
    reasoningRulesets: normalizeStringArray(
      input.reasoningRulesets ?? cfg.reasoningRulesets,
      `${context}.reasoningRulesets`,
    ),
    debugRdfLogging: normalizeBooleanFlag(
      input.debugRdfLogging,
      `${context}.debugRdfLogging`,
      cfg.debugRdfLogging,
    ),
    debugAll: normalizeBooleanFlag(input.debugAll, `${context}.debugAll`, cfg.debugAll),
    recentOntologies: normalizeStringArray(
      input.recentOntologies ?? cfg.recentOntologies,
      `${context}.recentOntologies`,
    ).slice(0, MAX_RECENT_ONTOLOGIES),
    recentLayouts: normalizeStringArray(
      input.recentLayouts ?? cfg.recentLayouts,
      `${context}.recentLayouts`,
    ).slice(0, MAX_RECENT_LAYOUTS),
    additionalOntologies: normalizeStringSet(
      input.additionalOntologies ?? cfg.additionalOntologies,
      `${context}.additionalOntologies`,
    ),
    disabledAdditionalOntologies: normalizeStringSet(
      input.disabledAdditionalOntologies ?? cfg.disabledAdditionalOntologies,
      `${context}.disabledAdditionalOntologies`,
    ),
    persistedAutoload: normalizeBooleanFlag(
      input.persistedAutoload,
      `${context}.persistedAutoload`,
      cfg.persistedAutoload,
    ),
    blacklistEnabled: normalizeBooleanFlag(
      input.blacklistEnabled,
      `${context}.blacklistEnabled`,
      cfg.blacklistEnabled,
    ),
    blacklistedPrefixes: normalizeStringSet(
      input.blacklistedPrefixes ?? cfg.blacklistedPrefixes,
      `${context}.blacklistedPrefixes`,
    ),
    blacklistedUris: normalizeStringSet(
      input.blacklistedUris ?? cfg.blacklistedUris,
      `${context}.blacklistedUris`,
    ),
    workflowCatalogEnabled: normalizeBooleanFlag(
      input.workflowCatalogEnabled,
      `${context}.workflowCatalogEnabled`,
      cfg.workflowCatalogEnabled,
    ),
    workflowCatalogUrls: normalizeWorkflowCatalogUrls(
      input.workflowCatalogUrls,
      `${context}.workflowCatalogUrls`,
    ),
    loadWorkflowCatalogOnStartup: normalizeBooleanFlag(
      input.loadWorkflowCatalogOnStartup,
      `${context}.loadWorkflowCatalogOnStartup`,
      cfg.loadWorkflowCatalogOnStartup,
    ),
  };
}

type Setter = Parameters<Parameters<typeof create<AppConfigStore>>[0]>[0];

function updateConfig(set: Setter, updater: (config: AppConfig) => AppConfig) {
  set((state) => ({ config: updater(state.config) }));
}

export const useAppConfigStore = create<AppConfigStore>()(
  persist(
    (set, get) => ({
      config: defaultConfig,

      setCurrentLayout: (layout: string) => {
        updateConfig(set, (config) => {
          const normalized = normalizeString(layout, "setCurrentLayout.layout");
          return {
            ...config,
            currentLayout: normalized,
            recentLayouts: pushRecent(
              config.recentLayouts,
              normalized,
              MAX_RECENT_LAYOUTS,
              "setCurrentLayout.recentLayouts",
            ),
          };
        });
      },

      setLayoutAnimations: (enabled: boolean) => {
        updateConfig(set, (config) => ({
          ...config,
          layoutAnimations: normalizeBoolean(enabled, "setLayoutAnimations.enabled"),
        }));
      },

      setLayoutSpacing: (spacing: number) => {
        updateConfig(set, (config) => ({
          ...config,
          layoutSpacing: normalizeNumber(spacing, "setLayoutSpacing.spacing", {
            min: MIN_LAYOUT_SPACING,
            max: MAX_LAYOUT_SPACING,
          }),
        }));
      },

      setShowLegend: (show: boolean) => {
        updateConfig(set, (config) => ({
          ...config,
          showLegend: normalizeBoolean(show, "setShowLegend.show"),
        }));
      },

      setViewMode: (mode: "abox" | "tbox") => {
        if (mode !== "abox" && mode !== "tbox") {
          throw new Error("setViewMode.mode must be 'abox' or 'tbox'");
        }
        updateConfig(set, (config) => ({
          ...config,
          viewMode: mode,
        }));
      },

      setCanvasTheme: (theme: "light" | "dark" | "auto") => {
        if (theme !== "light" && theme !== "dark" && theme !== "auto") {
          throw new Error("setCanvasTheme.theme must be 'light', 'dark', or 'auto'");
        }
        updateConfig(set, (config) => ({
          ...config,
          canvasTheme: theme,
        }));
      },

      setTooltipEnabled: (enabled: boolean) => {
        updateConfig(set, (config) => ({
          ...config,
          tooltipEnabled: normalizeBoolean(enabled, "setTooltipEnabled.enabled"),
        }));
      },

      setAutoApplyLayout: (enabled: boolean) => {
        updateConfig(set, (config) => ({
          ...config,
          autoApplyLayout: normalizeBoolean(enabled, "setAutoApplyLayout.enabled"),
        }));
      },

      setPersistedAutoload: (enabled: boolean) => {
        updateConfig(set, (config) => ({
          ...config,
          persistedAutoload: normalizeBoolean(enabled, "setPersistedAutoload.enabled"),
        }));
      },

      setAutoReasoning: (enabled: boolean) => {
        updateConfig(set, (config) => ({
          ...config,
          autoReasoning: normalizeBoolean(enabled, "setAutoReasoning.enabled"),
        }));
      },

      setCollapseThreshold: (threshold: number) => {
        updateConfig(set, (config) => ({
          ...config,
          collapseThreshold: normalizeNumber(threshold, "setCollapseThreshold.threshold", {
            min: MIN_COLLAPSE_THRESHOLD,
            max: MAX_COLLAPSE_THRESHOLD,
          }),
        }));
      },

      setClusteringAlgorithm: (algorithm: "louvain" | "label-propagation" | "kmeans") => {
        if (algorithm !== "louvain" && algorithm !== "label-propagation" && algorithm !== "kmeans") {
          throw new Error("setClusteringAlgorithm.algorithm must be 'louvain', 'label-propagation', or 'kmeans'");
        }
        updateConfig(set, (config) => ({
          ...config,
          clusteringAlgorithm: algorithm,
        }));
      },

      toggleNodeCollapsed: (iri: string) => {
        const normalized = normalizeString(iri, "toggleNodeCollapsed.iri");
        updateConfig(set, (config) => {
          const collapsedNodes = config.collapsedNodes || [];
          const isCollapsed = collapsedNodes.includes(normalized);
          return {
            ...config,
            collapsedNodes: isCollapsed
              ? collapsedNodes.filter((id) => id !== normalized)
              : [...collapsedNodes, normalized],
          };
        });
      },

      setCollapsedNodes: (iris: string[]) => {
        const normalized = normalizeStringArray(iris, "setCollapsedNodes.iris");
        updateConfig(set, (config) => ({
          ...config,
          collapsedNodes: normalized,
        }));
      },

      setReasoningRulesets: (reasoningRulesets: string[]) => {
        const normalized = normalizeStringArray(
          reasoningRulesets,
          "setReasoningRulesets.reasoningRulesets",
        );
        updateConfig(set, (config) => ({
          ...config,
          reasoningRulesets: normalized,
        }));
      },

      setDebugRdfLogging: (enabled: boolean) => {
        updateConfig(set, (config) => ({
          ...config,
          debugRdfLogging: normalizeBoolean(enabled, "setDebugRdfLogging.enabled"),
        }));
      },

      setDebugAll: (enabled: boolean) => {
        updateConfig(set, (config) => ({
          ...config,
          debugAll: normalizeBoolean(enabled, "setDebugAll.enabled"),
        }));
      },

      setBlacklistEnabled: (enabled: boolean) => {
        updateConfig(set, (config) => ({
          ...config,
          blacklistEnabled: normalizeBoolean(enabled, "setBlacklistEnabled.enabled"),
        }));
      },

      setBlacklistedPrefixes: (prefixes: string[]) => {
        const normalized = normalizeStringSet(prefixes, "setBlacklistedPrefixes.prefixes");
        updateConfig(set, (config) => ({
          ...config,
          blacklistedPrefixes: normalized,
        }));
      },

      setBlacklistedUris: (uris: string[]) => {
        const normalized = normalizeStringSet(uris, "setBlacklistedUris.uris");
        updateConfig(set, (config) => ({
          ...config,
          blacklistedUris: normalized,
        }));
      },

      addRecentOntology: (url: string) => {
        updateConfig(set, (config) => ({
          ...config,
          recentOntologies: pushRecent(
            config.recentOntologies,
            url,
            MAX_RECENT_ONTOLOGIES,
            "addRecentOntology",
          ),
        }));
      },

      addRecentLayout: (layout: string) => {
        updateConfig(set, (config) => ({
          ...config,
          recentLayouts: pushRecent(
            config.recentLayouts,
            layout,
            MAX_RECENT_LAYOUTS,
            "addRecentLayout",
          ),
        }));
      },

      addAdditionalOntology: (uri: string) => {
        const normalized = normalizeString(uri, "addAdditionalOntology.uri");
        updateConfig(set, (config) => ({
          ...config,
          additionalOntologies: normalizeStringSet(
            [...config.additionalOntologies, normalized],
            "addAdditionalOntology.next",
          ),
        }));
      },

      removeAdditionalOntology: (uri: string) => {
        const normalized = normalizeString(uri, "removeAdditionalOntology.uri");
        updateConfig(set, (config) => ({
          ...config,
          additionalOntologies: config.additionalOntologies.filter(
            (entry) => entry !== normalized,
          ),
        }));
      },

      addDisabledOntology: (uri: string) => {
        const normalized = normalizeString(uri, "addDisabledOntology.uri");
        updateConfig(set, (config) => ({
          ...config,
          disabledAdditionalOntologies: normalizeStringSet(
            [...config.disabledAdditionalOntologies, normalized],
            "addDisabledOntology.next",
          ),
        }));
      },

      removeDisabledOntology: (uri: string) => {
        const normalized = normalizeString(uri, "removeDisabledOntology.uri");
        updateConfig(set, (config) => ({
          ...config,
          disabledAdditionalOntologies: config.disabledAdditionalOntologies.filter(
            (entry) => entry !== normalized,
          ),
        }));
      },

      setWorkflowCatalogEnabled: (enabled: boolean) => {
        updateConfig(set, (config) => ({
          ...config,
          workflowCatalogEnabled: normalizeBoolean(enabled, "setWorkflowCatalogEnabled.enabled"),
        }));
      },

      setWorkflowCatalogUrls: (urls: Partial<WorkflowCatalogUrls>) => {
        updateConfig(set, (config) => ({
          ...config,
          workflowCatalogUrls: {
            ...config.workflowCatalogUrls,
            ...(urls.ontology !== undefined ? { ontology: normalizeString(urls.ontology, "setWorkflowCatalogUrls.ontology") } : {}),
            ...(urls.catalog !== undefined ? { catalog: normalizeString(urls.catalog, "setWorkflowCatalogUrls.catalog") } : {}),
            ...(urls.catalogUi !== undefined ? { catalogUi: normalizeString(urls.catalogUi, "setWorkflowCatalogUrls.catalogUi") } : {}),
          },
        }));
      },

      setLoadWorkflowCatalogOnStartup: (enabled: boolean) => {
        updateConfig(set, (config) => ({
          ...config,
          loadWorkflowCatalogOnStartup: normalizeBoolean(enabled, "setLoadWorkflowCatalogOnStartup.enabled"),
        }));
      },

      resetWorkflowCatalogUrls: () => {
        updateConfig(set, (config) => ({
          ...config,
          workflowCatalogUrls: { ...DEFAULT_WORKFLOW_CATALOG_URLS },
        }));
      },

      resetToDefaults: () => {
        set({ config: { ...defaultConfig } });
      },

      exportConfig: () => {
        return JSON.stringify(get().config, null, 2);
      },

      importConfig: (configJson: string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(configJson);
        } catch (error) {
          throw new Error(`Invalid configuration JSON: ${(error as Error).message}`);
        }
        const normalized = normalizeAppConfigInput(parsed, "importConfig");
        set({ config: normalized });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(resolveStateStorage),
      version: APP_CONFIG_VERSION,
      migrate: (persistedState: unknown) => {
        if (!isPlainObject(persistedState)) {
          return { config: { ...defaultConfig } };
        }
        const typed = persistedState as { config?: unknown };
        if (!typed.config) {
          return { config: { ...defaultConfig } };
        }
        return { config: normalizeAppConfigInput(typed.config, "persistedConfig") };
      },
    },
  ),
);
