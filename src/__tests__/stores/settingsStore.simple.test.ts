import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSettingsStore } from '../../stores/settingsStore';

describe('SettingsStore - Layout Management', () => {
  beforeEach(() => {
    // Reset store to default state
    useSettingsStore.setState({
      settings: {
        ontologies: [],
        shaclShapesUrl: '',
        autoReasoning: true,
        layoutAlgorithm: 'layered',
        enableValidation: true,
        startupFileUrl: ''
      }
    });
  });

  it('should have layered as default layout algorithm', () => {
    const { settings } = useSettingsStore.getState();
    expect(settings.layoutAlgorithm).toBe('layered');
  });

  it('should update layout algorithm', () => {
    const { updateSettings } = useSettingsStore.getState();
    
    updateSettings({ layoutAlgorithm: 'force' });
    
    const { settings } = useSettingsStore.getState();
    expect(settings.layoutAlgorithm).toBe('force');
  });

  it('should handle all valid layout types', () => {
    const { updateSettings } = useSettingsStore.getState();
    const validLayouts = ['force', 'hierarchical', 'circular', 'grid', 'tree', 'layered'];
    
    validLayouts.forEach(layout => {
      updateSettings({ layoutAlgorithm: layout as any });
      const { settings } = useSettingsStore.getState();
      expect(settings.layoutAlgorithm).toBe(layout);
    });
  });

  it('should preserve other settings when updating layout', () => {
    const { updateSettings } = useSettingsStore.getState();
    
    updateSettings({ autoReasoning: false });
    updateSettings({ layoutAlgorithm: 'circular' });
    
    const { settings } = useSettingsStore.getState();
    expect(settings.layoutAlgorithm).toBe('circular');
    expect(settings.autoReasoning).toBe(false);
  });
});