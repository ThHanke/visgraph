import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  assertArray,
  assertPlainObject,
  isPlainObject,
} from "../utils/guards";
import {
  normalizeBoolean,
  normalizeBooleanFlag,
  normalizeOptionalString,
  normalizeString,
} from "../utils/normalizers";
import { resolveStateStorage } from "../utils/stateStorage";

export interface OntologyConfig {
  url: string;
  name: string;
  enabled: boolean;
}

export interface Settings {
  ontologies: OntologyConfig[];
  shaclShapesUrl: string;
  autoReasoning: boolean;
  layoutAlgorithm: "horizontal" | "vertical";
  enableValidation: boolean;
  startupFileUrl: string;
}

interface SettingsStore {
  settings: Settings;
  updateSettings: (updates: Partial<Settings>) => void;
  addOntology: (ontology: OntologyConfig) => void;
  removeOntology: (url: string) => void;
  toggleOntology: (url: string) => void;
  loadPreset: (preset: Settings) => void;
  exportSettings: () => string;
  importSettings: (settingsJson: string) => void;
}

const SETTINGS_STORAGE_KEY = "ontology-painter-settings";
const SETTINGS_VERSION = 1;

const defaultSettings: Settings = {
  ontologies: [
    { url: "http://xmlns.com/foaf/0.1/", name: "FOAF", enabled: true },
    { url: "https://www.w3.org/TR/vocab-org/", name: "Organization", enabled: true },
  ],
  shaclShapesUrl: "",
  autoReasoning: false,
  layoutAlgorithm: "horizontal",
  enableValidation: true,
  startupFileUrl: "",
};

function normalizeLayoutAlgorithm(value: unknown, context: string): Settings["layoutAlgorithm"] {
  const normalized = normalizeString(value, context);
  if (normalized !== "horizontal" && normalized !== "vertical") {
    throw new Error(`${context} must be either 'horizontal' or 'vertical'`);
  }
  return normalized;
}

function normalizeOntologyConfig(value: unknown, context: string): OntologyConfig {
  assertPlainObject(value, `${context} must be a plain object`);
  const candidate = value as Partial<OntologyConfig>;
  const url = normalizeString(candidate.url, `${context}.url`);
  const name = normalizeString(candidate.name ?? url, `${context}.name`);
  const enabled = normalizeBooleanFlag(candidate.enabled, `${context}.enabled`, true);
  return { url, name, enabled };
}

function normalizeOntologies(value: unknown, context: string): OntologyConfig[] {
  assertArray(value, `${context} must be an array`);
  const seen = new Set<string>();
  const result: OntologyConfig[] = [];
  for (const [index, entry] of (value as unknown[]).entries()) {
    const config = normalizeOntologyConfig(entry, `${context}[${index}]`);
    if (seen.has(config.url)) continue;
    seen.add(config.url);
    result.push(config);
  }
  return result;
}

function normalizeSettingsInput(value: unknown, context: string): Settings {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be a plain object`);
  }
  const input = value as Partial<Settings>;
  return {
    ontologies: normalizeOntologies(
      input.ontologies ?? defaultSettings.ontologies,
      `${context}.ontologies`,
    ),
    shaclShapesUrl:
      normalizeOptionalString(
        input.shaclShapesUrl ?? defaultSettings.shaclShapesUrl,
        `${context}.shaclShapesUrl`,
        { allowEmpty: true },
      ) ?? "",
    autoReasoning: normalizeBooleanFlag(
      input.autoReasoning,
      `${context}.autoReasoning`,
      defaultSettings.autoReasoning,
    ),
    layoutAlgorithm: normalizeLayoutAlgorithm(
      input.layoutAlgorithm ?? defaultSettings.layoutAlgorithm,
      `${context}.layoutAlgorithm`,
    ),
    enableValidation: normalizeBooleanFlag(
      input.enableValidation,
      `${context}.enableValidation`,
      defaultSettings.enableValidation,
    ),
    startupFileUrl:
      normalizeOptionalString(
        input.startupFileUrl ?? defaultSettings.startupFileUrl,
        `${context}.startupFileUrl`,
        { allowEmpty: true },
      ) ?? "",
  };
}

function applySettingsPatch(current: Settings, patch: Partial<Settings>, context: string): Settings {
  if (!isPlainObject(patch)) {
    throw new Error(`${context} must be a plain object`);
  }
  const updated: Settings = { ...current };

  if (Object.prototype.hasOwnProperty.call(patch, "ontologies")) {
    updated.ontologies = normalizeOntologies(patch.ontologies, `${context}.ontologies`);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "shaclShapesUrl")) {
    updated.shaclShapesUrl =
      normalizeOptionalString(
        patch.shaclShapesUrl,
        `${context}.shaclShapesUrl`,
        { allowEmpty: true },
      ) ?? "";
  }
  if (Object.prototype.hasOwnProperty.call(patch, "autoReasoning")) {
    updated.autoReasoning = normalizeBoolean(
      patch.autoReasoning,
      `${context}.autoReasoning`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(patch, "layoutAlgorithm")) {
    updated.layoutAlgorithm = normalizeLayoutAlgorithm(
      patch.layoutAlgorithm,
      `${context}.layoutAlgorithm`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(patch, "enableValidation")) {
    updated.enableValidation = normalizeBoolean(
      patch.enableValidation,
      `${context}.enableValidation`,
    );
  }
  if (Object.prototype.hasOwnProperty.call(patch, "startupFileUrl")) {
    updated.startupFileUrl =
      normalizeOptionalString(
        patch.startupFileUrl,
        `${context}.startupFileUrl`,
        { allowEmpty: true },
      ) ?? "";
  }

  return updated;
}

function withSettingsUpdate(
  set: Parameters<Parameters<typeof create<SettingsStore>>[0]>[0],
  updater: (settings: Settings) => Settings,
) {
  set((state) => ({ settings: updater(state.settings) }));
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      settings: defaultSettings,

      updateSettings: (updates) => {
        withSettingsUpdate(set, (settings) =>
          applySettingsPatch(settings, updates, "updateSettings"),
        );
      },

      addOntology: (ontology) => {
        const normalized = normalizeOntologyConfig(ontology, "addOntology.ontology");
        withSettingsUpdate(set, (settings) => {
          const deduped = settings.ontologies.filter((entry) => entry.url !== normalized.url);
          return { ...settings, ontologies: [...deduped, normalized] };
        });
      },

      removeOntology: (url) => {
        const normalizedUrl = normalizeString(url, "removeOntology.url");
        withSettingsUpdate(set, (settings) => ({
          ...settings,
          ontologies: settings.ontologies.filter((entry) => entry.url !== normalizedUrl),
        }));
      },

      toggleOntology: (url) => {
        const normalizedUrl = normalizeString(url, "toggleOntology.url");
        withSettingsUpdate(set, (settings) => ({
          ...settings,
          ontologies: settings.ontologies.map((entry) =>
            entry.url === normalizedUrl ? { ...entry, enabled: !entry.enabled } : entry,
          ),
        }));
      },

      loadPreset: (preset) => {
        set({ settings: normalizeSettingsInput(preset, "loadPreset.preset") });
      },

      exportSettings: () => {
        return JSON.stringify(get().settings, null, 2);
      },

      importSettings: (settingsJson) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(settingsJson);
        } catch (error) {
          throw new Error(`Invalid settings JSON: ${(error as Error).message}`);
        }
        set({ settings: normalizeSettingsInput(parsed, "importSettings.value") });
      },
    }),
    {
      name: SETTINGS_STORAGE_KEY,
      version: SETTINGS_VERSION,
      storage: createJSONStorage(resolveStateStorage),
      migrate: (persistedState: unknown, version: number) => {
        console.log('[Settings] Running migration from version', version, 'to', SETTINGS_VERSION);
        
        // Handle invalid persisted state
        if (!isPlainObject(persistedState)) {
          console.warn('[Settings] Invalid persisted state, using defaults');
          return { settings: { ...defaultSettings } };
        }
        
        const payload = persistedState as { settings?: unknown };
        if (!payload.settings) {
          console.warn('[Settings] No settings in persisted state, using defaults');
          return { settings: { ...defaultSettings } };
        }
        
        // Apply version-specific migrations here if needed in the future
        // Example:
        // if (version < 2) {
        //   // Apply migration logic for v1 -> v2
        // }
        
        // Normalize and validate the migrated settings
        try {
          const normalized = normalizeSettingsInput(payload.settings, "persistedSettings");
          console.log('[Settings] Migration completed successfully');
          return { settings: normalized };
        } catch (error) {
          console.error('[Settings] Migration failed, using defaults:', error);
          return { settings: { ...defaultSettings } };
        }
      },
    },
  ),
);
