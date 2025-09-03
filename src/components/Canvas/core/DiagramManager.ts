/**
 * @fileoverview GoJS Diagram Manager
 * Handles the creation, configuration, and lifecycle management of GoJS diagrams
 * for knowledge graph visualization.
 */

import * as go from 'gojs';
import { DiagramConfig, DiagramEventHandlers } from '../../../types/canvas';
import { TemplateManager } from './TemplateManager';
import { EventHandlerManager } from './EventHandlers';

/**
 * Manages GoJS diagram instances and their configuration
 */
export class DiagramManager {
  private diagram: go.Diagram | null = null;
  private templateManager: TemplateManager;
  private eventHandlerManager: EventHandlerManager;

  /**
   * Creates a new DiagramManager instance
   * 
   * @param divElement - The HTML div element to attach the diagram to
   * @param config - Diagram configuration options
   * @param eventHandlers - Event handler callbacks
   */
  constructor(
    private divElement: HTMLDivElement,
    private config: DiagramConfig = {},
    private eventHandlers: Partial<DiagramEventHandlers> = {}
  ) {
    this.templateManager = new TemplateManager();
    this.eventHandlerManager = new EventHandlerManager(eventHandlers);
  }

  /**
   * Creates and initializes a new GoJS diagram
   * 
   * @returns The created diagram instance
   */
  public createDiagram(): go.Diagram {
    // Create the diagram with default configuration
    this.diagram = new go.Diagram(this.divElement, {
      // Layout configuration
      layout: new go.ForceDirectedLayout({
        defaultSpringLength: 100,
        defaultElectricalCharge: 150,
        arrangementSpacing: new go.Size(50, 50),
        maxIterations: 200,
        infinityDistance: 1000,
        randomNumberGenerator: null
      }),

      // Interaction settings
      allowHorizontalScroll: this.config.allowHorizontalScroll ?? true,
      allowVerticalScroll: this.config.allowVerticalScroll ?? true,
      allowZoom: this.config.allowZoom ?? true,
      allowSelect: true,
      allowMove: true,
      allowCopy: false,
      allowDelete: true,

      // Content alignment
      contentAlignment: this.config.contentAlignment ?? go.Spot.Center,
      initialContentAlignment: go.Spot.Center,
      
      // Grid configuration
      'grid.visible': this.config.grid?.visible ?? false,
      'grid.gridCellSize': this.config.grid?.gridCellSize ?? new go.Size(10, 10),
      'grid.gridOrigin': this.config.grid?.gridOrigin ?? new go.Point(0, 0),

      // Animation settings
      animationManager: {
        isEnabled: true,
        isInitial: false,
        duration: 250
      },

      // Auto scaling
      initialAutoScale: go.Diagram.UniformToFill,
      autoScale: go.Diagram.Uniform,
      
      // Tool configuration
      toolManager: {
        hoverDelay: 200,
        holdDelay: 500
      },

      // Model configuration
      'undoManager.isEnabled': this.config.undoManager?.isEnabled ?? true,
      'undoManager.maxHistoryLength': this.config.undoManager?.maxHistoryLength ?? 50,

      // Visual styling
      'animationManager.isEnabled': true,
      'SelectionMoved': this.handleSelectionMoved.bind(this),
    });

    // Set up templates
    this.setupTemplates();

    // Set up event handlers
    this.setupEventHandlers();

    // Initialize with empty model
    this.diagram.model = new go.GraphLinksModel([], []);

    return this.diagram;
  }

  /**
   * Sets up node and link templates
   */
  private setupTemplates(): void {
    if (!this.diagram) return;

    // Set node template
    this.diagram.nodeTemplate = this.templateManager.createNodeTemplate();

    // Set link template
    this.diagram.linkTemplate = this.templateManager.createLinkTemplate();

    // Set group template (for future use)
    this.diagram.groupTemplate = this.templateManager.createGroupTemplate();
  }

  /**
   * Sets up diagram event handlers
   */
  private setupEventHandlers(): void {
    if (!this.diagram) return;

    this.eventHandlerManager.setupEventHandlers(this.diagram);
  }

  /**
   * Handles selection moved events
   */
  private handleSelectionMoved(e: go.DiagramEvent): void {
    // Update node positions in the model
    e.diagram.selection.each((part) => {
      if (part instanceof go.Node) {
        const nodeData = part.data;
        if (nodeData) {
          const model = e.diagram.model as go.GraphLinksModel;
          model.setDataProperty(nodeData, 'loc', go.Point.stringify(part.location));
        }
      }
    });
  }

  /**
   * Updates the diagram with new data
   * 
   * @param nodeDataArray - Array of node data
   * @param linkDataArray - Array of link data
   */
  public updateModel(nodeDataArray: any[], linkDataArray: any[]): void {
    if (!this.diagram) return;

    this.diagram.startTransaction('update model');
    try {
      // Create new model with the data
      const model = new go.GraphLinksModel(nodeDataArray, linkDataArray);
      this.diagram.model = model;
      
      // Auto-layout if no positions are set
      const hasPositions = nodeDataArray.some(node => node.loc);
      if (!hasPositions) {
        this.performLayout();
      }
    } catch (error) {
      console.error('Error updating diagram model:', error);
    } finally {
      this.diagram.commitTransaction('update model');
    }
  }

  /**
   * Performs automatic layout of the diagram
   * 
   * @param layoutType - Type of layout to perform
   */
  public performLayout(layoutType: 'force' | 'hierarchical' | 'circular' = 'force'): void {
    if (!this.diagram) return;

    let layout: go.Layout;

    switch (layoutType) {
      case 'hierarchical':
        layout = new go.TreeLayout({
          arrangement: go.TreeLayout.ArrangementVertical,
          angle: 90,
          nodeSpacing: 50,
          layerSpacing: 100
        });
        break;
      case 'circular':
        layout = new go.CircularLayout({
          spacing: 50,
          aspectRatio: 1,
          startAngle: 0
        });
        break;
      case 'force':
      default:
        layout = new go.ForceDirectedLayout({
          defaultSpringLength: 100,
          defaultElectricalCharge: 150,
          maxIterations: 200
        });
        break;
    }

    this.diagram.startTransaction('layout');
    this.diagram.layout = layout;
    this.diagram.layoutDiagram(true);
    this.diagram.commitTransaction('layout');
  }

  /**
   * Focuses the diagram on a specific node
   * 
   * @param nodeKey - Key of the node to focus on
   */
  public focusNode(nodeKey: string): void {
    if (!this.diagram) return;

    const node = this.diagram.findNodeForKey(nodeKey);
    if (node) {
      this.diagram.select(node);
      this.diagram.centerRect(node.actualBounds);
    }
  }

  /**
   * Fits the entire diagram content in the viewport
   */
  public fitContent(): void {
    if (!this.diagram) return;
    this.diagram.zoomToFit();
  }

  /**
   * Resets the diagram zoom to 100%
   */
  public resetZoom(): void {
    if (!this.diagram) return;
    this.diagram.scale = 1.0;
  }

  /**
   * Exports the diagram as an image
   * 
   * @param format - Image format ('png' or 'svg')
   * @returns Promise resolving to the image data URL
   */
  public async exportImage(format: 'png' | 'svg' = 'png'): Promise<string> {
    if (!this.diagram) throw new Error('Diagram not initialized');

    return new Promise((resolve, reject) => {
      try {
        if (format === 'svg') {
          const svg = this.diagram!.makeSvg({
            scale: 1,
            background: 'white'
          });
          const svgString = new XMLSerializer().serializeToString(svg);
          const dataUrl = 'data:image/svg+xml;base64,' + btoa(svgString);
          resolve(dataUrl);
        } else {
          const imgData = this.diagram!.makeImageData({
            scale: 2,
            background: 'white',
            type: 'image/png'
          });
          resolve(imgData as string);
        }
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Cleans up the diagram and releases resources
   */
  public dispose(): void {
    if (this.diagram) {
      this.diagram.div = null;
      this.diagram = null;
    }
  }

  /**
   * Gets the current diagram instance
   * 
   * @returns The diagram instance or null if not initialized
   */
  public getDiagram(): go.Diagram | null {
    return this.diagram;
  }

  /**
   * Checks if the diagram is initialized
   * 
   * @returns True if diagram is initialized
   */
  public isInitialized(): boolean {
    return this.diagram !== null;
  }
}