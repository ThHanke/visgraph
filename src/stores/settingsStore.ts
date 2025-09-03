import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface OntologyConfig {
  url: string;
  name: string;
  enabled: boolean;
}

interface Settings {
  ontologies: OntologyConfig[];
  shaclShapesUrl: string;
  autoReasoning: boolean;
  layoutAlgorithm: 'force' | 'hierarchical' | 'circular' | 'grid' | 'tree' | 'layered';
  enableValidation: boolean;
  startupFileUrl: string;
}

interface SettingsStore {
  settings: Settings;
  isHydrated: boolean;
  updateSettings: (updates: Partial<Settings>) => void;
  addOntology: (ontology: OntologyConfig) => void;
  removeOntology: (url: string) => void;
  toggleOntology: (url: string) => void;
  loadPreset: (preset: Settings) => void;
  exportSettings: () => string;
  importSettings: (settingsJson: string) => void;
  setHydrated: (hydrated: boolean) => void;
}

const defaultSettings: Settings = {
  ontologies: [
    { url: 'http://xmlns.com/foaf/0.1/', name: 'FOAF', enabled: true },
    { url: 'https://www.w3.org/TR/vocab-org/', name: 'Organization', enabled: true }
  ],
  shaclShapesUrl: '',
  autoReasoning: true,
  layoutAlgorithm: 'layered',
  enableValidation: true,
  startupFileUrl: 'https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/refs/heads/main/LengthMeasurement.ttl'
};

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      settings: defaultSettings,
      isHydrated: false,

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
          console.error('Failed to import settings:', error);
          throw new Error('Invalid settings format');
        }
      },

      setHydrated: (hydrated) => {
        set({ isHydrated: hydrated });
      }
    }),
    {
      name: 'ontology-painter-settings',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.setHydrated(true);
        }
      },
    }
  )
);