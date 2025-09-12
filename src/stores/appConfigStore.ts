/**
 * @fileoverview App Configuration Store
 * Manages persistent app settings using localStorage with Zustand
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

export interface AppConfig {
  // Layout settings
  currentLayout: string;
  layoutAnimations: boolean;
  layoutSpacing: number;
  
  // UI preferences
  showLegend: boolean;
  viewMode: 'abox' | 'tbox';
  canvasTheme: 'light' | 'dark' | 'auto';
  
  // Performance settings
  autoReasoning: boolean;
  maxVisibleNodes: number;

  // Debug / developer toggles
  // When true RDFManager will emit a console.log reporting how many triples were added
  // during each successful load. Default is true to preserve current behavior; can be disabled.
  debugRdfLogging: boolean;
  
  // Recently used
  recentOntologies: string[];
  recentLayouts: string[];
  
  // Additional ontologies to auto-load
  additionalOntologies: string[];
  // Additional ontologies the user explicitly disabled (do not auto-load even if referenced)
  disabledAdditionalOntologies: string[];

  // Blacklist settings: control which prefixes/namespace URIs are excluded from UI subject emissions.
  // When enabled, subjects belonging to these prefixes or namespace URIs will not be emitted to the UI,
  // preventing canvas nodes for core vocabulary terms while preserving triples in the store.
  blacklistEnabled: boolean;
  blacklistedPrefixes: string[];
  blacklistedUris: string[];
}

interface AppConfigStore {
  config: AppConfig;
  
  // Layout actions
  setCurrentLayout: (layout: string) => void;
  setLayoutAnimations: (enabled: boolean) => void;
  setLayoutSpacing: (spacing: number) => void;
  
  // UI actions
  setShowLegend: (show: boolean) => void;
  setViewMode: (mode: 'abox' | 'tbox') => void;
  setCanvasTheme: (theme: 'light' | 'dark' | 'auto') => void;
  
  // Performance actions
  setAutoReasoning: (enabled: boolean) => void;
  setMaxVisibleNodes: (max: number) => void;

  // Debugging action to toggle RDFManager logging
  setDebugRdfLogging: (enabled: boolean) => void;

  // Blacklist actions (UI / config controls)
  setBlacklistEnabled: (enabled: boolean) => void;
  setBlacklistedPrefixes: (prefixes: string[]) => void;
  setBlacklistedUris: (uris: string[]) => void;
  
  // Recent items actions
  addRecentOntology: (url: string) => void;
  addRecentLayout: (layout: string) => void;
  
      // Additional ontologies actions
      addAdditionalOntology: (uri: string) => void;
      removeAdditionalOntology: (uri: string) => void;
      // User-disabled ontologies (do not auto-load even if referenced)
      addDisabledOntology: (uri: string) => void;
      removeDisabledOntology: (uri: string) => void;
      
      // Utility actions
      resetToDefaults: () => void;
      exportConfig: () => string;
      importConfig: (configJson: string) => void;
    }

const defaultConfig: AppConfig = {
  currentLayout: 'horizontal',
  layoutAnimations: true,
  layoutSpacing: 120,
  showLegend: false,
  viewMode: 'abox',
  canvasTheme: 'auto',
  autoReasoning: false,
  // Enable RDFManager triple-count logging by default to preserve existing behavior.
  debugRdfLogging: true,
  maxVisibleNodes: 1000,
  recentOntologies: [],
  recentLayouts: ['horizontal'],
  additionalOntologies: [],
  disabledAdditionalOntologies: [],

  // Blacklist defaults (enabled)
  blacklistEnabled: true,
  blacklistedPrefixes: ['owl', 'rdf', 'rdfs', 'xml', 'xsd'],
  blacklistedUris: [
    'http://www.w3.org/2002/07/owl',
    'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
    'http://www.w3.org/2000/01/rdf-schema#',
    'http://www.w3.org/XML/1998/namespace',
    'http://www.w3.org/2001/XMLSchema#'
  ]
};

export const useAppConfigStore = create<AppConfigStore>()(
  persist(
    (set, get) => ({
      config: defaultConfig,

      // Layout actions
      setCurrentLayout: (layout: string) => {
        set((state) => ({
          config: {
            ...state.config,
            currentLayout: layout
          }
        }));
        // Add to recent layouts
        get().addRecentLayout(layout);
      },

      setLayoutAnimations: (enabled: boolean) => {
        set((state) => ({
          config: {
            ...state.config,
            layoutAnimations: enabled
          }
        }));
      },

            setLayoutSpacing: (spacing: number) => {
        set((state) => ({
          config: {
            ...state.config,
            layoutSpacing: Math.max(50, Math.min(500, spacing)) // Clamp between 50-500
          }
        }));
      },

      // UI actions
      setShowLegend: (show: boolean) => {
        set((state) => ({
          config: {
            ...state.config,
            showLegend: show
          }
        }));
      },

      setViewMode: (mode: 'abox' | 'tbox') => {
        set((state) => ({
          config: {
            ...state.config,
            viewMode: mode
          }
        }));
      },

      setCanvasTheme: (theme: 'light' | 'dark' | 'auto') => {
        set((state) => ({
          config: {
            ...state.config,
            canvasTheme: theme
          }
        }));
      },

      // Performance actions
      setAutoReasoning: (enabled: boolean) => {
        set((state) => ({
          config: {
            ...state.config,
            autoReasoning: enabled
          }
        }));
      },

      setMaxVisibleNodes: (max: number) => {
        set((state) => ({
          config: {
            ...state.config,
            maxVisibleNodes: Math.max(100, Math.min(5000, max)) // Clamp between 100-5000
          }
        }));
      },

      // Debugging action
      setDebugRdfLogging: (enabled: boolean) => {
        set((state) => ({
          config: {
            ...state.config,
            debugRdfLogging: enabled
          }
        }));
      },

      // Blacklist actions (UI/config controls)
      setBlacklistEnabled: (enabled: boolean) => {
        set((state) => ({
          config: {
            ...state.config,
            blacklistEnabled: Boolean(enabled)
          }
        }));
      },

      setBlacklistedPrefixes: (prefixes: string[]) => {
        set((state) => ({
          config: {
            ...state.config,
            blacklistedPrefixes: Array.isArray(prefixes) ? prefixes.slice() : []
          }
        }));
      },

      setBlacklistedUris: (uris: string[]) => {
        set((state) => ({
          config: {
            ...state.config,
            blacklistedUris: Array.isArray(uris) ? uris.slice() : []
          }
        }));
      },

      // Recent items actions
      addRecentOntology: (url: string) => {
        set((state) => {
          const recent = state.config.recentOntologies.filter(u => u !== url);
          recent.unshift(url);
          return {
            config: {
              ...state.config,
              recentOntologies: recent.slice(0, 10) // Keep only last 10
            }
          };
        });
      },

      addRecentLayout: (layout: string) => {
        set((state) => {
          const recent = state.config.recentLayouts.filter(l => l !== layout);
          recent.unshift(layout);
          return {
            config: {
              ...state.config,
              recentLayouts: recent.slice(0, 5) // Keep only last 5
            }
          };
        });
      },

      // Additional ontologies actions
      addAdditionalOntology: (uri: string) => {
        set((state) => ({
          config: {
            ...state.config,
            additionalOntologies: [...new Set([...state.config.additionalOntologies, uri])]
          }
        }));
      },

      removeAdditionalOntology: (uri: string) => {
        set((state) => ({
          config: {
            ...state.config,
            additionalOntologies: state.config.additionalOntologies.filter(o => o !== uri)
          }
        }));
      },

      // Track ontologies the user explicitly disabled so they are not auto-loaded again.
      addDisabledOntology: (uri: string) => {
        set((state) => ({
          config: {
            ...state.config,
            disabledAdditionalOntologies: [...new Set([...state.config.disabledAdditionalOntologies, uri])]
          }
        }));
      },

      removeDisabledOntology: (uri: string) => {
        set((state) => ({
          config: {
            ...state.config,
            disabledAdditionalOntologies: state.config.disabledAdditionalOntologies.filter(o => o !== uri)
          }
        }));
      },

      // Utility actions
      resetToDefaults: () => {
        set({ config: { ...defaultConfig } });
      },

      exportConfig: () => {
        return JSON.stringify(get().config, null, 2);
      },

      importConfig: (configJson: string) => {
        try {
          const importedConfig = JSON.parse(configJson);
          // Validate and merge with defaults to ensure all required fields exist
          const validatedConfig = {
            ...defaultConfig,
            ...importedConfig
          };
          set({ config: validatedConfig });
        } catch (error) {
          console.error('Failed to import config:', error);
          throw new Error('Invalid configuration format');
        }
      }
    }),
    {
      name: 'ontology-painter-config', // localStorage key
      storage: createJSONStorage(() => localStorage),
      version: 1, // Version for migration if needed
      migrate: (persistedState: any, version: number) => {
        // Handle migrations if config structure changes
        if (version === 0) {
          // Migration from version 0 to 1
          return {
            ...persistedState,
            config: {
              ...defaultConfig,
              ...persistedState.config
            }
          };
        }
        return persistedState;
      }
    }
  )
);
