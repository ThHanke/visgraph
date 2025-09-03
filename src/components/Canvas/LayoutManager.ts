/**
 * @fileoverview Layout Manager for GoJS Canvas
 * Provides comprehensive layout algorithms and management for knowledge graphs
 */

import * as go from 'gojs';

export type LayoutType = 
  | 'force-directed'
  | 'hierarchical'
  | 'circular'
  | 'grid'
  | 'layered-digraph'
  | 'tree';

export interface LayoutOptions {
  /** Animation duration in milliseconds */
  animationDuration?: number;
  /** Whether to animate the layout transition */
  animated?: boolean;
  /** Spacing between nodes */
  nodeSpacing?: number;
  /** Additional layout-specific options */
  layoutSpecific?: Record<string, any>;
}

export interface LayoutConfig {
  type: LayoutType;
  options: LayoutOptions;
  label: string;
  description: string;
  icon: string;
}

export class LayoutManager {
  private diagram: go.Diagram;
  private originalLayout: go.Layout;

  constructor(diagram: go.Diagram) {
    this.diagram = diagram;
    this.originalLayout = diagram.layout;
  }

  /**
   * Get all available layout configurations
   */
  getAvailableLayouts(): LayoutConfig[] {
    return [
      {
        type: 'force-directed',
        options: { nodeSpacing: 120, animationDuration: 500 },
        label: 'Force Directed',
        description: 'Nodes repel each other and connected nodes attract',
        icon: 'GitBranch'
      },
      {
        type: 'hierarchical',
        options: { nodeSpacing: 100, animationDuration: 600 },
        label: 'Hierarchical',
        description: 'Tree-like structure with clear parent-child relationships',
        icon: 'TreePine'
      },
      {
        type: 'circular',
        options: { nodeSpacing: 80, animationDuration: 700 },
        label: 'Circular',
        description: 'Nodes arranged in a circular pattern',
        icon: 'Circle'
      },
      {
        type: 'grid',
        options: { nodeSpacing: 150, animationDuration: 400 },
        label: 'Grid',
        description: 'Nodes arranged in a regular grid pattern',
        icon: 'Grid3X3'
      },
      {
        type: 'layered-digraph',
        options: { nodeSpacing: 100, animationDuration: 600 },
        label: 'Layered Graph',
        description: 'Directed graph with nodes in distinct layers',
        icon: 'Layers'
      },
      {
        type: 'tree',
        options: { nodeSpacing: 120, animationDuration: 500 },
        label: 'Tree',
        description: 'Traditional tree layout with root at top',
        icon: 'TreeDeciduous'
      }
    ];
  }

  /**
   * Apply a specific layout to the diagram
   */
  async applyLayout(layoutType: LayoutType, options: LayoutOptions = {}): Promise<void> {
    if (!this.diagram) {
      throw new Error('Diagram not initialized');
    }

    // Merge default options with provided options
    const config = this.getAvailableLayouts().find(l => l.type === layoutType);
    const mergedOptions = { ...config?.options, ...options };

    try {
      this.diagram.startTransaction('apply layout');
      
      // Store current positions for potential undo
      this.storeCurrentPositions();

      const layout = this.createLayout(layoutType, mergedOptions);
      
      if (layout) {
        this.diagram.layout = layout;
        
        if (mergedOptions.animated !== false) {
          await this.animateLayoutChange(mergedOptions.animationDuration || 500);
        } else {
          this.diagram.layoutDiagram(true);
        }
      }

      this.diagram.commitTransaction('apply layout');
    } catch (error) {
      this.diagram.rollbackTransaction();
      throw new Error(`Failed to apply ${layoutType} layout: ${error}`);
    }
  }

  /**
   * Create a GoJS layout instance based on type and options
   */
  private createLayout(layoutType: LayoutType, options: LayoutOptions): go.Layout | null {
    const $ = go.GraphObject.make;
    const spacing = options.nodeSpacing || 100;

    switch (layoutType) {
      case 'force-directed':
        return $(go.ForceDirectedLayout, {
          defaultSpringLength: spacing,
          defaultElectricalCharge: 200,
          maxIterations: 200,
          epsilonDistance: 0.5,
          infinityDistance: spacing * 10,
          ...options.layoutSpecific
        });

      case 'hierarchical':
        return $(go.TreeLayout, {
          angle: 90,
          layerSpacing: spacing,
          nodeSpacing: spacing * 0.8,
          arrangement: go.TreeLayout.ArrangementHorizontal,
          ...options.layoutSpecific
        });

      case 'circular':
        return $(go.CircularLayout, {
          radius: spacing * 2,
          spacing: spacing * 0.5,
          direction: go.CircularLayout.Clockwise,
          ...options.layoutSpecific
        });

      case 'grid':
        return $(go.GridLayout, {
          cellSize: new go.Size(spacing, spacing),
          spacing: new go.Size(spacing * 0.3, spacing * 0.3),
          arrangement: go.GridArrangement.LeftToRight,
          ...options.layoutSpecific
        });

      case 'layered-digraph':
        return $(go.LayeredDigraphLayout, {
          direction: 0, // 0 = right, 90 = down, 180 = left, 270 = up
          layerSpacing: spacing,
          columnSpacing: spacing * 0.7,
          setsPortSpots: false,
          ...options.layoutSpecific
        });

      case 'tree':
        return $(go.TreeLayout, {
          angle: 270, // Top-down tree
          layerSpacing: spacing,
          nodeSpacing: spacing * 0.6,
          arrangement: go.TreeLayout.ArrangementVertical,
          ...options.layoutSpecific
        });

      default:
        console.warn(`Unknown layout type: ${layoutType}`);
        return null;
    }
  }

  /**
   * Animate the layout transition
   */
  private async animateLayoutChange(duration: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.diagram.animationManager.isEnabled) {
        this.diagram.layoutDiagram(true);
        resolve();
        return;
      }

      // Enable animations temporarily if needed
      const wasEnabled = this.diagram.animationManager.isEnabled;
      this.diagram.animationManager.isEnabled = true;

      // Create animation
      const animation = new go.Animation();
      animation.duration = duration;
      animation.easing = go.Animation.EaseInOutQuad;

      // Store initial positions
      const initialPositions = new Map();
      this.diagram.nodes.each(node => {
        initialPositions.set(String(node.key), node.location.copy());
      });

      // Calculate target positions by temporarily laying out
      this.diagram.layoutDiagram(true);

      // Store target positions
      const targetPositions = new Map();
      this.diagram.nodes.each(node => {
        targetPositions.set(String(node.key), node.location.copy());
      });

      // Reset to initial positions
      this.diagram.nodes.each(node => {
        const initial = initialPositions.get(String(node.key));
        if (initial) {
          node.location = initial;
        }
      });

      // Animate to target positions
      this.diagram.nodes.each(node => {
        const initial = initialPositions.get(String(node.key));
        const target = targetPositions.get(String(node.key));
        
        if (initial && target) {
          animation.add(node, 'location', initial, target);
        }
      });

      animation.finished = () => {
        this.diagram.animationManager.isEnabled = wasEnabled;
        resolve();
      };

      animation.start();
    });
  }

  /**
   * Store current node positions for undo functionality
   */
  private storeCurrentPositions(): void {
    // This could be enhanced to store in a history stack for undo/redo
    const positions = new Map();
    this.diagram.nodes.each(node => {
      positions.set(String(node.key), node.location.copy());
    });
    
    // Store in diagram for potential restoration
    (this.diagram as any)._lastPositions = positions;
  }

  /**
   * Restore previously stored positions
   */
  restoreLastPositions(): void {
    const positions = (this.diagram as any)._lastPositions;
    if (!positions) return;

    this.diagram.startTransaction('restore positions');
    this.diagram.nodes.each(node => {
      const storedPos = positions.get(String(node.key));
      if (storedPos) {
        node.location = storedPos;
      }
    });
    this.diagram.commitTransaction('restore positions');
  }

  /**
   * Auto-select the best layout based on graph characteristics
   */
  suggestOptimalLayout(): LayoutType {
    const nodeCount = this.diagram.nodes.count;
    const linkCount = this.diagram.links.count;
    const ratio = linkCount / Math.max(nodeCount, 1);

    // Determine if graph has hierarchical structure
    const hasHierarchy = this.detectHierarchicalStructure();
    
    // Determine if graph is tree-like
    const isTreeLike = this.isTreeLike();

    if (isTreeLike) {
      return 'tree';
    } else if (hasHierarchy) {
      return 'hierarchical';
    } else if (nodeCount < 10) {
      return 'circular';
    } else if (ratio < 0.5) {
      return 'grid';
    } else if (ratio > 2) {
      return 'layered-digraph';
    } else {
      return 'force-directed';
    }
  }

  /**
   * Detect if the graph has a hierarchical structure
   */
  private detectHierarchicalStructure(): boolean {
    let rootNodes = 0;
    let leafNodes = 0;

    this.diagram.nodes.each(node => {
      const incoming = node.findLinksInto().count;
      const outgoing = node.findLinksOutOf().count;

      if (incoming === 0 && outgoing > 0) rootNodes++;
      if (incoming > 0 && outgoing === 0) leafNodes++;
    });

    // Heuristic: if we have clear roots and leaves, it's likely hierarchical
    return rootNodes > 0 && leafNodes > 0 && (rootNodes + leafNodes) > this.diagram.nodes.count * 0.3;
  }

  /**
   * Check if the graph is tree-like (connected, acyclic)
   */
  private isTreeLike(): boolean {
    const nodeCount = this.diagram.nodes.count;
    const linkCount = this.diagram.links.count;

    // Tree property: edges = nodes - 1 (for connected tree)
    if (linkCount !== nodeCount - 1) return false;

    // Check for cycles using DFS
    const visited = new Set();
    const recursionStack = new Set();

    const hasCycle = (nodeKey: string, parent: string | null): boolean => {
      visited.add(nodeKey);
      recursionStack.add(nodeKey);

      const node = this.diagram.findNodeForKey(nodeKey);
      if (!node) return false;

      node.findLinksOutOf().each(link => {
        const targetKey = String(link.toNode?.key);
        if (!targetKey || targetKey === parent) return;

        if (!visited.has(targetKey)) {
          if (hasCycle(targetKey, nodeKey)) return true;
        } else if (recursionStack.has(targetKey)) {
          return true;
        }
      });

      recursionStack.delete(nodeKey);
      return false;
    };

    // Start DFS from first node
    const firstNode = this.diagram.nodes.first();
    if (!firstNode) return true; // Empty graph is tree-like

    return !hasCycle(String(firstNode.key), null);
  }

  /**
   * Get current layout information
   */
  getCurrentLayoutInfo(): { type: string; options: any } {
    const layout = this.diagram.layout;
    
    if (layout instanceof go.ForceDirectedLayout) {
      return { 
        type: 'force-directed', 
        options: {
          springLength: layout.defaultSpringLength,
          electricalCharge: layout.defaultElectricalCharge
        }
      };
    } else if (layout instanceof go.TreeLayout) {
      return { 
        type: layout.angle === 270 ? 'tree' : 'hierarchical',
        options: {
          angle: layout.angle,
          layerSpacing: layout.layerSpacing,
          nodeSpacing: layout.nodeSpacing
        }
      };
    } else if (layout instanceof go.CircularLayout) {
      return { 
        type: 'circular',
        options: {
          radius: layout.radius,
          spacing: layout.spacing
        }
      };
    } else if (layout instanceof go.GridLayout) {
      return { 
        type: 'grid',
        options: {
          cellSize: layout.cellSize,
          spacing: layout.spacing
        }
      };
    } else if (layout instanceof go.LayeredDigraphLayout) {
      return { 
        type: 'layered-digraph',
        options: {
          direction: layout.direction,
          layerSpacing: layout.layerSpacing,
          columnSpacing: layout.columnSpacing
        }
      };
    }

    return { type: 'unknown', options: {} };
  }

  /**
   * Reset to the original layout
   */
  resetToOriginal(): void {
    if (this.originalLayout) {
      this.diagram.startTransaction('reset layout');
      this.diagram.layout = this.originalLayout;
      this.diagram.layoutDiagram(true);
      this.diagram.commitTransaction('reset layout');
    }
  }
}