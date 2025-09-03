/**
 * @fileoverview Type definitions for canvas and diagram-related components
 * Provides TypeScript interfaces for GoJS diagrams, nodes, links, and canvas interactions.
 */

import * as go from 'gojs';
import { LiteralProperty, AnnotationPropertyValue, EntityType, RDFType } from './ontology';

/**
 * Represents a node in the GoJS diagram
 */
export interface GoJSNodeData {
  /** Unique identifier for the node */
  key: string;
  /** URI of the entity this node represents */
  uri: string;
  /** Display label for the node */
  label: string;
  /** Namespace prefix */
  namespace: string;
  /** Class type of the entity */
  classType: string;
  /** Entity type (class, individual, etc.) */
  entityType: EntityType;
  /** Primary RDF type */
  rdfType: RDFType;
  /** All RDF types for this entity */
  rdfTypes?: string[];
  /** Literal properties (data properties) */
  literalProperties: LiteralProperty[];
  /** Annotation properties */
  annotationProperties: AnnotationPropertyValue[];
  /** Node position */
  loc?: string;
  /** Whether the node is visible */
  visible?: boolean;
  /** Node color */
  color?: string;
  /** Background color */
  backgroundColor?: string;
  /** Primary color for the header */
  primaryColor?: string;
  /** Whether the node has reasoning errors */
  hasReasoningError?: boolean;
  /** Reasoning error messages */
  reasoningErrors?: string[];
  /** Custom node size */
  size?: { width: number; height: number };
}

/**
 * Represents a link/edge in the GoJS diagram
 */
export interface GoJSLinkData {
  /** Unique identifier for the link */
  key?: string;
  /** Source node key */
  from: string;
  /** Target node key */
  to: string;
  /** Property URI this link represents */
  propertyUri: string;
  /** Property type */
  propertyType: string;
  /** Display label for the link */
  label: string;
  /** Namespace of the property */
  namespace: string;
  /** RDF type of the property */
  rdfType: string;
  /** Link color */
  color?: string;
  /** Whether the link has reasoning errors */
  hasReasoningError?: boolean;
  /** Reasoning error messages */
  reasoningErrors?: string[];
  /** Link routing points */
  points?: number[];
}

/**
 * Canvas toolbar configuration
 */
export interface CanvasToolbarProps {
  /** Callback for adding a new node */
  onAddNode: (entityUri: string) => void;
  /** Callback for toggling the namespace legend */
  onToggleLegend: () => void;
  /** Whether the legend is currently shown */
  showLegend: boolean;
  /** Callback for exporting the graph */
  onExport: (format: 'turtle' | 'owl-xml' | 'json-ld') => void;
  /** Callback for loading a file */
  onLoadFile?: (file: File | string) => void;
  /** Current view mode */
  viewMode: 'abox' | 'tbox';
  /** Callback for changing view mode */
  onViewModeChange: (mode: 'abox' | 'tbox') => void;
  /** Available entities for autocomplete */
  availableEntities: Array<{
    uri: string;
    label: string;
    namespace: string;
    rdfType: string;
    description?: string;
  }>;
}

/**
 * Node property editor configuration
 */
export interface NodePropertyEditorProps {
  /** Whether the editor is open */
  open: boolean;
  /** Callback for opening/closing the editor */
  onOpenChange: (open: boolean) => void;
  /** Node data being edited */
  nodeData: GoJSNodeData | null;
  /** Available annotation properties */
  availableProperties: Array<{
    uri: string;
    label: string;
    namespace: string;
    rdfType: string;
  }>;
  /** Callback for saving node properties */
  onSave: (nodeKey: string, properties: AnnotationPropertyValue[]) => void;
}

/**
 * Link property editor configuration
 */
export interface LinkPropertyEditorProps {
  /** Whether the editor is open */
  open: boolean;
  /** Callback for opening/closing the editor */
  onOpenChange: (open: boolean) => void;
  /** Link data being edited */
  linkData: GoJSLinkData | null;
  /** Source node data */
  sourceNode: GoJSNodeData | null;
  /** Target node data */
  targetNode: GoJSNodeData | null;
  /** Callback for saving link properties */
  onSave: (linkKey: string, propertyUri: string) => void;
}

/**
 * Canvas state management
 */
export interface CanvasState {
  /** Current view mode */
  viewMode: 'abox' | 'tbox';
  /** Whether the legend is visible */
  showLegend: boolean;
  /** Whether currently loading */
  isLoading: boolean;
  /** Loading progress (0-100) */
  loadingProgress: number;
  /** Loading message */
  loadingMessage: string;
  /** Selected node data */
  selectedNode: GoJSNodeData | null;
  /** Selected link data */
  selectedLink: GoJSLinkData | null;
  /** Whether node editor is open */
  showNodeEditor: boolean;
  /** Whether link editor is open */
  showLinkEditor: boolean;
  /** Whether reasoning report is open */
  showReasoningReport: boolean;
}

/**
 * Canvas actions
 */
export interface CanvasActions {
  /** Set the view mode */
  setViewMode: (mode: 'abox' | 'tbox') => void;
  /** Toggle legend visibility */
  toggleLegend: () => void;
  /** Set loading state */
  setLoading: (loading: boolean, progress?: number, message?: string) => void;
  /** Set selected node */
  setSelectedNode: (node: GoJSNodeData | null) => void;
  /** Set selected link */
  setSelectedLink: (link: GoJSLinkData | null) => void;
  /** Toggle node editor */
  toggleNodeEditor: (show: boolean) => void;
  /** Toggle link editor */
  toggleLinkEditor: (show: boolean) => void;
  /** Toggle reasoning report */
  toggleReasoningReport: (show: boolean) => void;
}

/**
 * GoJS diagram configuration options
 */
export interface DiagramConfig {
  /** Whether to allow horizontal scrolling */
  allowHorizontalScroll?: boolean;
  /** Whether to allow vertical scrolling */
  allowVerticalScroll?: boolean;
  /** Whether to allow zooming */
  allowZoom?: boolean;
  /** Initial content alignment */
  contentAlignment?: go.Spot;
  /** Grid configuration */
  grid?: {
    visible: boolean;
    gridCellSize: go.Size;
    gridOrigin: go.Point;
  };
  /** Undo manager configuration */
  undoManager?: {
    isEnabled: boolean;
    maxHistoryLength: number;
  };
}

/**
 * Node template configuration
 */
export interface NodeTemplateConfig {
  /** Default node size */
  defaultSize: { width: number; height: number };
  /** Header height */
  headerHeight: number;
  /** Color scheme */
  colors: {
    background: string;
    headerBackground: string;
    headerText: string;
    bodyText: string;
    border: string;
  };
  /** Font configuration */
  fonts: {
    header: string;
    body: string;
  };
}

/**
 * Link template configuration
 */
export interface LinkTemplateConfig {
  /** Default stroke width */
  strokeWidth: number;
  /** Arrow size */
  arrowSize: number;
  /** Label configuration */
  label: {
    font: string;
    background: string;
    offset: go.Point;
  };
  /** Color scheme */
  colors: {
    default: string;
    hover: string;
    selected: string;
    error: string;
  };
}

/**
 * Namespace legend configuration
 */
export interface NamespaceLegendProps {
  /** Namespace mappings to display */
  namespaces: Record<string, string>;
  /** Additional CSS classes */
  className?: string;
  /** Whether to show entity counts */
  showCounts?: boolean;
  /** Callback for namespace selection */
  onNamespaceSelect?: (namespace: string) => void;
}

/**
 * Canvas context type
 */
export interface CanvasContextType {
  /** Canvas state */
  state: CanvasState;
  /** Canvas actions */
  actions: CanvasActions;
  /** GoJS diagram instance */
  diagram: go.Diagram | null;
  /** Set diagram instance */
  setDiagram: (diagram: go.Diagram | null) => void;
}

/**
 * Event handler types for GoJS diagram
 */
export interface DiagramEventHandlers {
  /** Node selection changed */
  onNodeSelectionChanged: (node: GoJSNodeData | null) => void;
  /** Link selection changed */
  onLinkSelectionChanged: (link: GoJSLinkData | null) => void;
  /** Node double clicked */
  onNodeDoubleClick: (node: GoJSNodeData) => void;
  /** Link double clicked */
  onLinkDoubleClick: (link: GoJSLinkData) => void;
  /** Background clicked */
  onBackgroundClick: () => void;
  /** Diagram model changed */
  onModelChanged: (changes: go.IncrementalData) => void;
}

/**
 * Graph layout configuration
 */
export interface GraphLayoutConfig {
  /** Layout type */
  type: 'force' | 'hierarchical' | 'circular' | 'grid';
  /** Layout-specific options */
  options: Record<string, any>;
  /** Whether to animate layout changes */
  animate: boolean;
  /** Animation duration in milliseconds */
  animationDuration: number;
}