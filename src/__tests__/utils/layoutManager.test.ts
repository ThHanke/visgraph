import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock GoJS
const mockLayoutInstance = { mock: 'layout' };
const mockMake = vi.fn().mockReturnValue(mockLayoutInstance);

vi.mock('gojs', () => ({
  default: {
    GraphObject: {
      make: mockMake
    },
    ForceDirectedLayout: vi.fn(),
    LayeredDigraphLayout: vi.fn(),
    TreeLayout: vi.fn(),
    CircularLayout: vi.fn(),
    GridLayout: vi.fn(),
    Size: vi.fn()
  }
}));

// Test the layout creation logic that would be in GoJSCanvas
describe('Layout Manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const createLayoutByType = (layoutType: string) => {
    const go = require('gojs').default;
    const $ = go.GraphObject.make;
    
    try {
      switch (layoutType) {
        case 'force':
          return $(go.ForceDirectedLayout, {
            defaultSpringLength: 120,
            defaultElectricalCharge: 200,
            maxIterations: 200,
            epsilonDistance: 0.5,
            infinityDistance: 1000
          });
        case 'layered':
          return $(go.LayeredDigraphLayout, {
            direction: 0,
            layerSpacing: 50,
            columnSpacing: 20
          });
        case 'hierarchical':
          return $(go.TreeLayout, {
            angle: 90,
            layerSpacing: 50,
            nodeSpacing: 20
          });
        case 'tree':
          return $(go.TreeLayout, {
            angle: 0,
            layerSpacing: 50,
            nodeSpacing: 20
          });
        case 'circular':
          return $(go.CircularLayout, {
            radius: 200,
            spacing: 50
          });
        case 'grid':
          return $(go.GridLayout, {
            cellSize: { width: 200, height: 150 },
            spacing: { width: 10, height: 10 }
          });
        default:
          console.warn(`Unknown layout type: ${layoutType}, falling back to layered`);
          return $(go.LayeredDigraphLayout, {
            direction: 0,
            layerSpacing: 50,
            columnSpacing: 20
          });
      }
    } catch (error) {
      console.error('Error creating layout:', error);
      return $(go.ForceDirectedLayout, {
        defaultSpringLength: 120,
        defaultElectricalCharge: 200,
        maxIterations: 200
      });
    }
  };

  describe('Layout Creation', () => {
    it('should create force directed layout', () => {
      const layout = createLayoutByType('force');
      expect(mockMake).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          defaultSpringLength: 120,
          defaultElectricalCharge: 200,
          maxIterations: 200
        })
      );
      expect(layout).toBe(mockLayoutInstance);
    });

    it('should create layered digraph layout', () => {
      const layout = createLayoutByType('layered');
      expect(mockMake).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          direction: 0,
          layerSpacing: 50,
          columnSpacing: 20
        })
      );
      expect(layout).toBe(mockLayoutInstance);
    });

    it('should create hierarchical tree layout', () => {
      const layout = createLayoutByType('hierarchical');
      expect(mockMake).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          angle: 90,
          layerSpacing: 50,
          nodeSpacing: 20
        })
      );
      expect(layout).toBe(mockLayoutInstance);
    });

    it('should create tree layout', () => {
      const layout = createLayoutByType('tree');
      expect(mockMake).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          angle: 0,
          layerSpacing: 50,
          nodeSpacing: 20
        })
      );
      expect(layout).toBe(mockLayoutInstance);
    });

    it('should create circular layout', () => {
      const layout = createLayoutByType('circular');
      expect(mockMake).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          radius: 200,
          spacing: 50
        })
      );
      expect(layout).toBe(mockLayoutInstance);
    });

    it('should create grid layout', () => {
      const layout = createLayoutByType('grid');
      expect(mockMake).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          cellSize: { width: 200, height: 150 },
          spacing: { width: 10, height: 10 }
        })
      );
      expect(layout).toBe(mockLayoutInstance);
    });

    it('should fall back to layered layout for unknown types', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      const layout = createLayoutByType('unknown');
      
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        'Unknown layout type: unknown, falling back to layered'
      );
      expect(layout).toBe(mockLayoutInstance);
      
      consoleWarnSpy.mockRestore();
    });

    it('should handle layout creation errors', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      
      // Mock make to throw an error
      mockMake.mockImplementationOnce(() => {
        throw new Error('Layout creation failed');
      });
      
      const layout = createLayoutByType('force');
      
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error creating layout:',
        expect.any(Error)
      );
      // Should still return a layout (fallback)
      expect(layout).toBe(mockLayoutInstance);
      
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Layout Type Validation', () => {
    const validLayouts = ['force', 'layered', 'hierarchical', 'tree', 'circular', 'grid'];
    
    validLayouts.forEach(layoutType => {
      it(`should handle ${layoutType} layout type`, () => {
        const layout = createLayoutByType(layoutType);
        expect(layout).toBe(mockLayoutInstance);
        expect(mockMake).toHaveBeenCalled();
      });
    });

    it('should handle empty string gracefully', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      const layout = createLayoutByType('');
      
      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(layout).toBe(mockLayoutInstance);
      
      consoleWarnSpy.mockRestore();
    });

    it('should handle null/undefined gracefully', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      
      const layout = createLayoutByType(null as any);
      
      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(layout).toBe(mockLayoutInstance);
      
      consoleWarnSpy.mockRestore();
    });
  });
});