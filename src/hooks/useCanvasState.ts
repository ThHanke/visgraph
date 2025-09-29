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
  
  // Editor / modal states (only store UI flags that are global to the app)
  // NOTE: selected node/link objects are intentionally NOT stored here. React Flow
  // is the source of truth for node/edge data; editors will receive node/edge
  // objects directly from the canvas component.
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
    // Note: selected node / selected link and editor-open flags are intentionally
    // excluded from the centralized canvas state. React Flow holds node/edge objects,
    // and KnowledgeCanvas manages editor visibility locally.
    showReasoningReport,
  };

  // Aggregate actions object
  const actions: CanvasActions = {
    setViewMode,
    toggleLegend,
    setLoading: handleSetLoading,
    // Removed setSelectedNode / setSelectedLink / toggleNodeEditor / toggleLinkEditor
    // to keep node/edge payloads exclusively in React Flow state.
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
