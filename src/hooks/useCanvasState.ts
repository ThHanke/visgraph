/**
 * @fileoverview Canvas state management hook
 * Provides centralized state management for the knowledge graph canvas,
 * including view modes, loading states, and UI component visibility.
 */

import { useState, useCallback } from 'react';
import { CanvasState, CanvasActions, NodeData, LinkData } from '../types/canvas';
import { toast } from 'sonner';

/**
 * Custom hook for managing canvas state and actions
 * 
 * @returns Object containing canvas state and action functions
 * 
 * @example
 * ```tsx
 * const { state, actions } = useCanvasState();
 * 
 * // Change view mode
 * actions.setViewMode('tbox');
 * 
 * // Show loading state
 * actions.setLoading(true, 50, 'Loading ontology...');
 * ```
 */
export const useCanvasState = () => {
  // Core canvas state
  const [viewMode, setViewMode] = useState<'abox' | 'tbox'>('abox');
  const [showLegend, setShowLegend] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadingProgress, setLoadingProgress] = useState(0);
  const [loadingMessage, setLoadingMessage] = useState('');
  
  // Editor states
  const [selectedNode, setSelectedNode] = useState<NodeData | null>(null);
  const [selectedLink, setSelectedLink] = useState<LinkData | null>(null);
  const [showNodeEditor, setShowNodeEditor] = useState(false);
  const [showLinkEditor, setShowLinkEditor] = useState(false);
  const [showReasoningReport, setShowReasoningReport] = useState(false);

  /**
   * Toggle the namespace legend visibility
   */
  const toggleLegend = useCallback(() => {
    setShowLegend(prev => !prev);
  }, []);

  /**
   * Set loading state with optional progress and message
   * 
   * @param loading - Whether currently loading
   * @param progress - Loading progress (0-100)
   * @param message - Loading message to display
   */
  const handleSetLoading = useCallback((
    loading: boolean, 
    progress = 0, 
    message = ''
  ) => {
    setIsLoading(loading);
    setLoadingProgress(progress);
    setLoadingMessage(message);
  }, []);

  /**
   * Set the selected node and optionally open the editor
   * 
   * @param node - Node data to select (null to deselect)
   * @param openEditor - Whether to open the node editor
   */
  const handleSetSelectedNode = useCallback((
    node: NodeData | null, 
    openEditor = false
  ) => {
    try { console.debug('[VG] useCanvasState.setSelectedNode called', { node: node && (node as any).iri ? (node as any).iri : node, openEditor }); } catch (_) {}
    setSelectedNode(node);
    if (openEditor && node) {
      try { console.debug('[VG] useCanvasState: opening node editor'); } catch (_) {}
      try { toast.info('Opening node editor'); } catch (_) {}
      setShowNodeEditor(true);
    }
  }, []);

  /**
   * Set the selected link and optionally open the editor
   * 
   * @param link - Link data to select (null to deselect)
   * @param openEditor - Whether to open the link editor
   */
  const handleSetSelectedLink = useCallback((
    link: LinkData | null,
    openEditor = false
  ) => {
    try { console.debug('[VG] useCanvasState.setSelectedLink called', { link: link && ((link as any).id || (link as any).key) ? ((link as any).id || (link as any).key) : link, openEditor }); } catch (_) {}
    // Compare by stable identifier (id or key) rather than object identity to avoid
    // repeated updates when equivalent objects are recreated during mapping.
    const incomingId = link ? (String((link as any).id || (link as any).key || "")) : "";
    const currentId = selectedLink ? (String(((selectedLink as any).id || (selectedLink as any).key || ""))) : "";

    // If identifiers match, avoid re-setting selectedLink to prevent update loops.
    if (incomingId && incomingId === currentId) {
      if (openEditor && link && !showLinkEditor) {
        try { console.debug('[VG] useCanvasState: opening link editor (id match)'); } catch (_) {}
        setShowLinkEditor(true);
      }
      return;
    }

    setSelectedLink(link);

    if (openEditor && link) {
      try { console.debug('[VG] useCanvasState: opening link editor'); } catch (_) {}
      try { toast.info('Opening link editor'); } catch (_) {}
      if (!showLinkEditor) setShowLinkEditor(true);
    }
  }, [showLinkEditor, selectedLink]);

  /**
   * Toggle node editor visibility
   * 
   * @param show - Whether to show the editor
   */
  const toggleNodeEditor = useCallback((show: boolean) => {
    try { console.debug('[VG] useCanvasState.toggleNodeEditor', { show }); } catch (_) {}
    setShowNodeEditor(show);
    // Clear selection when closing editor
    if (!show) {
      setSelectedNode(null);
    }
  }, []);

  /**
   * Toggle link editor visibility
   * 
   * @param show - Whether to show the editor
   */
  const toggleLinkEditor = useCallback((show: boolean) => {
    try { console.debug('[VG] useCanvasState.toggleLinkEditor', { show }); } catch (_) {}
    setShowLinkEditor(show);
    // Clear selection when closing editor
    if (!show) {
      setSelectedLink(null);
    }
  }, []);

  /**
   * Toggle reasoning report visibility
   * 
   * @param show - Whether to show the report
   */
  const toggleReasoningReport = useCallback((show: boolean) => {
    setShowReasoningReport(show);
  }, []);

  /**
   * Clear all selections and close all editors
   */
  const clearSelections = useCallback(() => {
    setSelectedNode(null);
    setSelectedLink(null);
    setShowNodeEditor(false);
    setShowLinkEditor(false);
  }, []);

  // Aggregate state object
  const state: CanvasState = {
    viewMode,
    showLegend,
    isLoading,
    loadingProgress,
    loadingMessage,
    selectedNode,
    selectedLink,
    showNodeEditor,
    showLinkEditor,
    showReasoningReport,
  };

  // Aggregate actions object
  const actions: CanvasActions = {
    setViewMode,
    toggleLegend,
    setLoading: handleSetLoading,
    setSelectedNode: handleSetSelectedNode,
    setSelectedLink: handleSetSelectedLink,
    toggleNodeEditor,
    toggleLinkEditor,
    toggleReasoningReport,
  };

  return {
    state,
    actions,
    clearSelections,
  };
};

/**
 * Type for the return value of useCanvasState hook
 */
export type UseCanvasStateReturn = ReturnType<typeof useCanvasState>;
