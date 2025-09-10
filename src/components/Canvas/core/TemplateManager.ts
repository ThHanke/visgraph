/**
 * TemplateManager (stub)
 *
 *  has been removed from the project. This lightweight stub preserves the
 * TemplateManager API used by tests/code but avoids any dependency on .
 *
 * It implements:
 * - constructor(...)
 * - computeDisplayType(data): string
 * - createNodeTemplate(): any (returns null — React Flow renders nodes)
 * - createLinkTemplate(): any (returns null)
 *
 * Tests that relied on TemplateManager's computeDisplayType can continue to call it.
 */

import { NodeTemplateConfig, LinkTemplateConfig } from '../../../types/canvas';
import { computeDisplayInfoMemo } from './nodeDisplay';
import { useOntologyStore } from '../../../stores/ontologyStore';

export class TemplateManager {
  private nodeConfig: NodeTemplateConfig;
  private linkConfig: LinkTemplateConfig;

  constructor(nodeConfig: Partial<NodeTemplateConfig> = {}, linkConfig: Partial<LinkTemplateConfig> = {}) {
    this.nodeConfig = {
      defaultSize: { width: 200, height: 120 },
      headerHeight: 40,
      colors: {
        background: '#FFFFFF',
        headerBackground: '#2E8B57',
        headerText: '#ffffff',
        bodyText: '#333333',
        border: '#888888'
      },
      fonts: {
        header: 'bold 12px Inter, sans-serif',
        body: '11px Inter, sans-serif'
      },
      ...nodeConfig
    } as NodeTemplateConfig;

    this.linkConfig = {
      strokeWidth: 2,
      arrowSize: 8,
      label: {
        font: '10px Inter, sans-serif',
        background: 'rgba(255,255,255,0.9)',
        offset: { x: 0, y: -10 } as any
      },
      colors: {
        default: '#64748b',
        hover: '#7c3aed',
        selected: '#7c3aed',
        error: '#ef4444'
      },
      ...linkConfig
    } as LinkTemplateConfig;
  }

  /**
   * Compute a display type (prefixed or short) for a node payload using existing helpers.
   * This mirrors the previous TemplateManager.computeDisplayType behavior but avoids .
   */
  public computeDisplayType(data: any): string {
    if (!data) return '';
    try {
      const state = useOntologyStore.getState();
      const mgr = typeof state.getRdfManager === 'function' ? state.getRdfManager() : state.rdfManager;
      const classes = state.availableClasses;
      const info = computeDisplayInfoMemo(data, mgr, classes);
      return info?.prefixed || info?.short || '';
    } catch {
      return '';
    }
  }

  /**
   * createNodeTemplate
   * Return a placeholder (null) because React Flow is used for rendering.
   * Tests should not rely on  node templates; they can call computeDisplayType instead.
   */
  public createNodeTemplate(): any {
    return null;
  }

  /**
   * createLinkTemplate
   * Return a placeholder (null) because React Flow is used for rendering.
   */
  public createLinkTemplate(): any {
    return null;
  }
}

export default TemplateManager;
