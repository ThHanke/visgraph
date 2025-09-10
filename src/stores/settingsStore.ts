import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { fallback } from '../utils/startupDebug';

interface OntologyConfig {
  url: string;
  name: string;
  enabled: boolean;
}

interface Settings {
  ontologies: OntologyConfig[];
  shaclShapesUrl: string;
  autoReasoning: boolean;
  layoutAlgorithm: 'force' | 'hierarchical' | 'circular';
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

const defaultSettings: Settings = {
  ontologies: [
    { url: 'http://xmlns.com/foaf/0.1/', name: 'FOAF', enabled: true },
    { url: 'https://www.w3.org/TR/vocab-org/', name: 'Organization', enabled: true }
  ],
  shaclShapesUrl: '',
  autoReasoning: false,
  layoutAlgorithm: 'force',
  enableValidation: true,
  startupFileUrl: ''
};

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      settings: defaultSettings,

      updateSettings: (updates) => {
        set((state) => ({
          settings: { ...state.settings, ...updates }
        }));
      },

      addOntology: (ontology) => {
        set((state) => ({
          settings: {
            ...state.settings,
            ontologies: [...state.settings.ontologies, ontology]
          }
        }));
      },

      removeOntology: (url) => {
        set((state) => ({
          settings: {
            ...state.settings,
            ontologies: state.settings.ontologies.filter(ont => ont.url !== url)
          }
        }));
      },

      toggleOntology: (url) => {
        set((state) => ({
          settings: {
            ...state.settings,
            ontologies: state.settings.ontologies.map(ont => 
              ont.url === url ? { ...ont, enabled: !ont.enabled } : ont
            )
          }
        }));
      },

      loadPreset: (preset) => {
        set({ settings: preset });
      },

      exportSettings: () => {
        return JSON.stringify(get().settings, null, 2);
      },

      importSettings: (settingsJson) => {
        try {
          const settings = JSON.parse(settingsJson);
          set({ settings });
        } catch (error) {
          ((...__vg_args)=>{try{fallback('console.error',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'error', captureStack:true})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.error(...__vg_args);})('Failed to import settings:', error);
          throw new Error('Invalid settings format');
        }
      }
    }),
    {
      name: 'ontology-painter-settings',
      version: 1,
      storage: createJSONStorage(() => localStorage),
    }
  )
);
