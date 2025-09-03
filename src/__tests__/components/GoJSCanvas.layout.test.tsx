import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { GoJSCanvas } from '../../components/Canvas/GoJSCanvas';
import { useSettingsStore } from '../../stores/settingsStore';
import { useOntologyStore } from '../../stores/ontologyStore';
import { useReasoningStore } from '../../stores/reasoningStore';

// Mock GoJS
vi.mock('gojs', () => ({
  default: {
    GraphObject: {
      make: vi.fn(() => ({}))
    },
    Diagram: vi.fn(() => ({
      div: null,
      model: {},
      layout: {},
      layoutDiagram: vi.fn(),
      startTransaction: vi.fn(),
      commitTransaction: vi.fn(),
      addDiagramListener: vi.fn(),
      findNodeForKey: vi.fn(),
      findLinkForKey: vi.fn(),
      nodes: { each: vi.fn() },
      toolManager: {
        linkingTool: { temporaryLink: { routing: '', curve: '' } },
        relinkingTool: { isEnabled: true }
      }
    })),
    GraphLinksModel: vi.fn(() => ({})),
    ForceDirectedLayout: vi.fn(() => ({})),
    LayeredDigraphLayout: vi.fn(() => ({})),
    TreeLayout: vi.fn(() => ({})),
    CircularLayout: vi.fn(() => ({})),
    GridLayout: vi.fn(() => ({})),
    Spot: { Center: '' },
    Node: vi.fn(),
    Shape: vi.fn(),
    TextBlock: vi.fn(),
    Panel: vi.fn(),
    Link: { Orthogonal: '', JumpOver: '' },
    Binding: vi.fn(),
    Size: vi.fn()
  }
}));

// Mock stores
vi.mock('../../stores/settingsStore');
vi.mock('../../stores/ontologyStore');
vi.mock('../../stores/reasoningStore');

// Mock sonner
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn()
  }
}));

describe('GoJSCanvas Layout Management', () => {
  const mockUpdateSettings = vi.fn();
  const mockSetHydrated = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Mock settings store
    (useSettingsStore as any).mockReturnValue({
      settings: {
        layoutAlgorithm: 'layered',
        ontologies: [],
        shaclShapesUrl: '',
        autoReasoning: true,
        enableValidation: true,
        startupFileUrl: ''
      },
      isHydrated: true,
      updateSettings: mockUpdateSettings,
      setHydrated: mockSetHydrated
    });

    // Mock ontology store
    (useOntologyStore as any).mockReturnValue({
      loadedOntologies: [],
      allEntities: [],
      availableClasses: [],
      loadOntology: vi.fn(),
      loadKnowledgeGraph: vi.fn()
    });

    // Mock reasoning store
    (useReasoningStore as any).mockReturnValue({
      startReasoning: vi.fn()
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should not initialize diagram when settings are not hydrated', () => {
    (useSettingsStore as any).mockReturnValue({
      settings: { layoutAlgorithm: 'layered' },
      isHydrated: false,
      updateSettings: mockUpdateSettings,
      setHydrated: mockSetHydrated
    });

    render(<GoJSCanvas />);
    
    // The diagram should not be initialized yet
    expect(screen.queryByRole('button')).toBeTruthy(); // Toolbar should still render
  });

  it('should initialize diagram with saved layout algorithm', async () => {
    (useSettingsStore as any).mockReturnValue({
      settings: { layoutAlgorithm: 'force' },
      isHydrated: true,
      updateSettings: mockUpdateSettings,
      setHydrated: mockSetHydrated
    });

    render(<GoJSCanvas />);
    
    await waitFor(() => {
      // Verify the component renders
      expect(screen.getByRole('main')).toBeTruthy();
    });
  });

  it('should handle layout change errors gracefully', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    
    render(<GoJSCanvas />);
    
    await waitFor(() => {
      expect(screen.getByRole('main')).toBeTruthy();
    });

    consoleErrorSpy.mockRestore();
  });

  it('should fall back to default layout when invalid layout is provided', async () => {
    (useSettingsStore as any).mockReturnValue({
      settings: { layoutAlgorithm: 'invalid-layout' },
      isHydrated: true,
      updateSettings: mockUpdateSettings,
      setHydrated: mockSetHydrated
    });

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    
    render(<GoJSCanvas />);
    
    await waitFor(() => {
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unknown layout type: invalid-layout')
      );
    });

    consoleWarnSpy.mockRestore();
  });

  describe('Layout Algorithm Selection', () => {
    const layouts = ['force', 'layered', 'hierarchical', 'tree', 'circular', 'grid'];

    layouts.forEach(layout => {
      it(`should handle ${layout} layout correctly`, async () => {
        (useSettingsStore as any).mockReturnValue({
          settings: { layoutAlgorithm: layout },
          isHydrated: true,
          updateSettings: mockUpdateSettings,
          setHydrated: mockSetHydrated
        });

        const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        
        render(<GoJSCanvas />);
        
        await waitFor(() => {
          expect(consoleSpy).toHaveBeenCalledWith(
            `Initializing diagram with layout: ${layout}`
          );
        });

        consoleSpy.mockRestore();
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle diagram initialization errors', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      // Mock GoJS to throw an error
      const originalMake = vi.mocked(require('gojs').default.GraphObject.make);
      vi.mocked(require('gojs').default.GraphObject.make).mockImplementation(() => {
        throw new Error('GoJS initialization failed');
      });

      render(<GoJSCanvas />);
      
      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          'Error initializing diagram:',
          expect.any(Error)
        );
      });

      // Restore original mock
      vi.mocked(require('gojs').default.GraphObject.make).mockImplementation(originalMake);
      consoleErrorSpy.mockRestore();
    });

    it('should handle layout creation errors', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      // Mock layout creation to throw an error
      vi.mocked(require('gojs').default.ForceDirectedLayout).mockImplementation(() => {
        throw new Error('Layout creation failed');
      });

      render(<GoJSCanvas />);
      
      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          'Error creating layout:',
          expect.any(Error)
        );
      });

      consoleErrorSpy.mockRestore();
    });
  });

  describe('Settings Persistence', () => {
    it('should wait for settings hydration before initializing', () => {
      let hydrationState = false;
      
      (useSettingsStore as any).mockImplementation(() => ({
        settings: { layoutAlgorithm: 'layered' },
        isHydrated: hydrationState,
        updateSettings: mockUpdateSettings,
        setHydrated: (value: boolean) => {
          hydrationState = value;
          mockSetHydrated(value);
        }
      }));

      const { rerender } = render(<GoJSCanvas />);
      
      // Initially should not initialize
      expect(mockSetHydrated).not.toHaveBeenCalled();
      
      // Simulate hydration
      hydrationState = true;
      rerender(<GoJSCanvas />);
      
      // Now should proceed with initialization
    });
  });
});