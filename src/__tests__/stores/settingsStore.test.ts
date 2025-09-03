import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSettingsStore } from '../../stores/settingsStore';

// Mock localStorage
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock
});

describe('SettingsStore', () => {
  beforeEach(() => {
    // Clear all mocks
    vi.clearAllMocks();
    localStorageMock.getItem.mockReturnValue(null);
    
    // Reset store state
    useSettingsStore.setState({
      settings: {
        ontologies: [
          { url: 'http://xmlns.com/foaf/0.1/', name: 'FOAF', enabled: true },
          { url: 'https://www.w3.org/TR/vocab-org/', name: 'Organization', enabled: true }
        ],
        shaclShapesUrl: '',
        autoReasoning: true,
        layoutAlgorithm: 'layered',
        enableValidation: true,
        startupFileUrl: 'https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/refs/heads/main/LengthMeasurement.ttl'
      },
      isHydrated: false
    });
  });

  it('should have default settings with layered layout', () => {
    const { settings } = useSettingsStore.getState();
    expect(settings.layoutAlgorithm).toBe('layered');
    expect(settings.autoReasoning).toBe(true);
    expect(settings.enableValidation).toBe(true);
  });

  it('should update layout algorithm setting', () => {
    const { updateSettings } = useSettingsStore.getState();
    
    updateSettings({ layoutAlgorithm: 'force' });
    
    const { settings } = useSettingsStore.getState();
    expect(settings.layoutAlgorithm).toBe('force');
  });

  it('should handle all valid layout algorithms', () => {
    const { updateSettings } = useSettingsStore.getState();
    const validLayouts = ['force', 'hierarchical', 'circular', 'grid', 'tree', 'layered'];
    
    validLayouts.forEach(layout => {
      updateSettings({ layoutAlgorithm: layout as any });
      const { settings } = useSettingsStore.getState();
      expect(settings.layoutAlgorithm).toBe(layout);
    });
  });

  it('should add new ontology', () => {
    const { addOntology } = useSettingsStore.getState();
    const newOntology = { url: 'http://example.com/test', name: 'Test', enabled: true };
    
    addOntology(newOntology);
    
    const { settings } = useSettingsStore.getState();
    expect(settings.ontologies).toContain(newOntology);
    expect(settings.ontologies).toHaveLength(3);
  });

  it('should remove ontology by URL', () => {
    const { removeOntology } = useSettingsStore.getState();
    
    removeOntology('http://xmlns.com/foaf/0.1/');
    
    const { settings } = useSettingsStore.getState();
    expect(settings.ontologies).toHaveLength(1);
    expect(settings.ontologies[0].url).toBe('https://www.w3.org/TR/vocab-org/');
  });

  it('should toggle ontology enabled state', () => {
    const { toggleOntology } = useSettingsStore.getState();
    
    toggleOntology('http://xmlns.com/foaf/0.1/');
    
    const { settings } = useSettingsStore.getState();
    const foafOntology = settings.ontologies.find(o => o.url === 'http://xmlns.com/foaf/0.1/');
    expect(foafOntology?.enabled).toBe(false);
    
    // Toggle back
    toggleOntology('http://xmlns.com/foaf/0.1/');
    const { settings: newSettings } = useSettingsStore.getState();
    const foafOntologyToggled = newSettings.ontologies.find(o => o.url === 'http://xmlns.com/foaf/0.1/');
    expect(foafOntologyToggled?.enabled).toBe(true);
  });

  it('should export settings as JSON string', () => {
    const { exportSettings } = useSettingsStore.getState();
    
    const exported = exportSettings();
    const parsed = JSON.parse(exported);
    
    expect(parsed.layoutAlgorithm).toBe('layered');
    expect(parsed.ontologies).toHaveLength(2);
  });

  it('should import valid settings JSON', () => {
    const { importSettings } = useSettingsStore.getState();
    const testSettings = {
      ontologies: [],
      shaclShapesUrl: 'http://test.com',
      autoReasoning: false,
      layoutAlgorithm: 'circular',
      enableValidation: false,
      startupFileUrl: ''
    };
    
    importSettings(JSON.stringify(testSettings));
    
    const { settings } = useSettingsStore.getState();
    expect(settings.layoutAlgorithm).toBe('circular');
    expect(settings.autoReasoning).toBe(false);
    expect(settings.shaclShapesUrl).toBe('http://test.com');
  });

  it('should throw error for invalid settings JSON', () => {
    const { importSettings } = useSettingsStore.getState();
    
    expect(() => {
      importSettings('invalid json');
    }).toThrow('Invalid settings format');
  });

  it('should set hydrated state', () => {
    const { setHydrated } = useSettingsStore.getState();
    
    expect(useSettingsStore.getState().isHydrated).toBe(false);
    
    setHydrated(true);
    
    expect(useSettingsStore.getState().isHydrated).toBe(true);
  });

  it('should load preset settings', () => {
    const { loadPreset } = useSettingsStore.getState();
    const presetSettings = {
      ontologies: [{ url: 'http://preset.com', name: 'Preset', enabled: true }],
      shaclShapesUrl: 'http://preset-shapes.com',
      autoReasoning: false,
      layoutAlgorithm: 'grid' as const,
      enableValidation: false,
      startupFileUrl: 'http://preset-startup.com'
    };
    
    loadPreset(presetSettings);
    
    const { settings } = useSettingsStore.getState();
    expect(settings).toEqual(presetSettings);
  });

  describe('localStorage persistence', () => {
    it('should handle localStorage errors gracefully', () => {
      // Mock localStorage to throw an error
      localStorageMock.setItem.mockImplementation(() => {
        throw new Error('Storage quota exceeded');
      });
      
      const { updateSettings } = useSettingsStore.getState();
      
      // Should not throw
      expect(() => {
        updateSettings({ layoutAlgorithm: 'force' });
      }).not.toThrow();
    });

    it('should handle corrupted localStorage data', () => {
      // Mock localStorage to return corrupted data
      localStorageMock.getItem.mockReturnValue('{"corrupted": json}');
      
      // Should fall back to default settings
      const { settings } = useSettingsStore.getState();
      expect(settings.layoutAlgorithm).toBe('layered');
    });
  });
});