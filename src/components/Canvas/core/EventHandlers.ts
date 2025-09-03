/**
 * @fileoverview GoJS Event Handler Manager
 * Manages event handlers for GoJS diagram interactions including selection,
 * mouse events, and diagram changes.
 */

import * as go from 'gojs';
import { DiagramEventHandlers } from '../../../types/canvas';

/**
 * Manages event handlers for GoJS diagrams
 */
export class EventHandlerManager {
  /**
   * Creates a new EventHandlerManager instance
   * 
   * @param eventHandlers - Event handler callbacks
   */
  constructor(private eventHandlers: Partial<DiagramEventHandlers>) {}

  /**
   * Sets up all event handlers for a diagram
   * 
   * @param diagram - The GoJS diagram to set up events for
   */
  public setupEventHandlers(diagram: go.Diagram): void {
    // Selection changed events
    diagram.addDiagramListener('ChangedSelection', (e) => {
      this.handleSelectionChanged(e);
    });

    // Background click event
    diagram.addDiagramListener('BackgroundSingleClicked', (e) => {
      this.handleBackgroundClick(e);
    });

    // Model changed events
    diagram.addModelChangedListener((e) => {
      this.handleModelChanged(e);
    });

    // Double click events for nodes and links
    diagram.addDiagramListener('ObjectDoubleClicked', (e) => {
      this.handleObjectDoubleClick(e);
    });
  }

  /**
   * Handles selection changed events
   * 
   * @param e - Diagram event
   */
  private handleSelectionChanged(e: go.DiagramEvent): void {
    const selection = e.diagram.selection;
    let selectedNode = null;
    let selectedLink = null;

    selection.each((part) => {
      if (part instanceof go.Node) {
        selectedNode = part.data;
      } else if (part instanceof go.Link) {
        selectedLink = part.data;
      }
    });

    // Call appropriate event handlers
    if (this.eventHandlers.onNodeSelectionChanged) {
      this.eventHandlers.onNodeSelectionChanged(selectedNode);
    }

    if (this.eventHandlers.onLinkSelectionChanged) {
      this.eventHandlers.onLinkSelectionChanged(selectedLink);
    }
  }

  /**
   * Handles background click events
   * 
   * @param e - Diagram event
   */
  private handleBackgroundClick(e: go.DiagramEvent): void {
    // Clear selections
    e.diagram.clearSelection();

    if (this.eventHandlers.onBackgroundClick) {
      this.eventHandlers.onBackgroundClick();
    }
  }

  /**
   * Handles model changed events
   * 
   * @param e - Model change event
   */
  private handleModelChanged(e: go.ChangedEvent): void {
    // Only handle completed transactions
    if (e.isTransactionFinished && this.eventHandlers.onModelChanged) {
      // Convert ChangedEvent to a simpler format for the callback
      const incrementalData = {
        modifiedNodeData: e.model?.nodeDataArray || [],
        modifiedLinkData: (e.model as go.GraphLinksModel)?.linkDataArray || [],
        insertedNodeKeys: [],
        removedNodeKeys: [],
        insertedLinkKeys: [],
        removedLinkKeys: []
      };
      this.eventHandlers.onModelChanged(incrementalData as any);
    }
  }

  /**
   * Handles object double click events
   * 
   * @param e - Diagram event
   */
  private handleObjectDoubleClick(e: go.DiagramEvent): void {
    const obj = e.subject as go.Part;

    if (obj instanceof go.Node && this.eventHandlers.onNodeDoubleClick) {
      this.eventHandlers.onNodeDoubleClick(obj.data);
    } else if (obj instanceof go.Link && this.eventHandlers.onLinkDoubleClick) {
      this.eventHandlers.onLinkDoubleClick(obj.data);
    }
  }

  /**
   * Updates event handlers
   * 
   * @param newHandlers - New event handler callbacks
   */
  public updateEventHandlers(newHandlers: Partial<DiagramEventHandlers>): void {
    this.eventHandlers = { ...this.eventHandlers, ...newHandlers };
  }
}