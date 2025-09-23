/**
 * DiagramManager (stub)
 *
 *  has been removed from the project. This lightweight stub preserves the
 * DiagramManager API surface so any remaining imports continue to work but it
 * does not depend on  or create real diagrams.
 *
 * If you prefer to delete this file entirely, remove imports referencing it.
 */

import { DiagramConfig, DiagramEventHandlers } from '../../../types/canvas';

export class DiagramManager {
  private container: HTMLElement | null = null;
  private config: DiagramConfig = {};
  private handlers: Partial<DiagramEventHandlers> = {};

  constructor(container?: HTMLElement | null, config?: DiagramConfig, handlers?: Partial<DiagramEventHandlers>) {
    this.container = container || null;
    this.config = config || {};
    this.handlers = handlers || {};
  }

  /**
   * createDiagram
   * Returns a lightweight placeholder object that mimics the minimal API used
   * elsewhere in the repo (startTransaction/commitTransaction, model, nodes, etc.)
   */
  public createDiagram() {
    const mockDiagram: any = {
      startTransaction: () => {},
      commitTransaction: () => {},
      nodes: { each: (_fn: any) => {} },
      model: { nodeDataArray: [], linkDataArray: [], setDataProperty: () => {} },
      addDiagramListener: (_name: string, _fn?: any) => {},
      addDiagramListenerOnce: (_name: string, _fn?: any) => {},
      requestUpdate: () => {},
      layoutDiagram: (_b?: boolean) => {},
      findNodeForKey: (_k: any) => null,
      findLinkForKey: (_k: any) => null,
      skipsUndoManager: false,
      div: this.container || null,
      toolManager: { linkingTool: { temporaryLink: {} }, relinkingTool: { isEnabled: false } },
      nodesCount: 0,
      dispose: () => { /* noop */ }
    };

    return mockDiagram;
  }

  public setConfig(cfg: DiagramConfig) {
    this.config = { ...this.config, ...cfg };
  }

  public setEventHandlers(handlers: Partial<DiagramEventHandlers>) {
    this.handlers = { ...this.handlers, ...handlers };
  }

  public teardown() {
    // no-op for stub
  }
}

export default DiagramManager;
