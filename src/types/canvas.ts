/**
 * @fileoverview Type definitions for canvas and diagram-related components
 * Provides TypeScript interfaces for diagram nodes, links, and canvas interactions.
 */

import { LiteralProperty, AnnotationPropertyValue, EntityType, RDFType } from './ontology';

/**
 * Represents a node in the diagram payload used across the app.
 *
 * Canonical shape: diagram nodes must be driven by RDF. `rdfTypes` is authoritative
 * and required. Legacy fields such as `classType` and `namespace` are optional and
 * kept only for compatibility; UI should compute labels from `rdfTypes`.
 */
export interface NodeData {
  [key: string]: any;
  /** Unique identifier for the node */
  key: string;
  /** URI/IRI of the entity this node represents (canonical identifier) */
  uri: string;
  /** All RDF types for this entity (canonical - must be present) */
  rdfTypes: string[];
  /** Optional display label computed from rdfTypes (may be present for convenience) */
  label?: string;
  /** Deprecated: Namespace prefix (kept for compatibility only) */
  namespace?: string;
  /** Deprecated: Class local name (kept for compatibility only) */
  classType?: string;
  /** Entity type (class, individual, etc.) */
  entityType?: EntityType;
  /** Literal properties (data properties) */
  literalProperties?: LiteralProperty[];
  /** Annotation properties */
  annotationProperties?: AnnotationPropertyValue[];
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
 * Represents a link/edge in the diagram payload
 */
export interface LinkData {
  [key: string]: any;
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
  nodeData: NodeData | null;
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
  linkData: LinkData | null;
  /** Source node data */
  sourceNode: NodeData | null;
  /** Target node data */
  targetNode: NodeData | null;
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
  selectedNode: NodeData | null;
  /** Selected link data */
  selectedLink: LinkData | null;
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
  /** Set selected node (optionally open editor) — accepts any to accommodate partial node payloads */
  setSelectedNode: (node: any, openEditor?: boolean) => void;
  /** Set selected link (optionally open editor) — accepts any to accommodate partial link payloads */
  setSelectedLink: (link: any, openEditor?: boolean) => void;
  /** Toggle node editor */
  toggleNodeEditor: (show: boolean) => void;
  /** Toggle link editor */
  toggleLinkEditor: (show: boolean) => void;
  /** Toggle reasoning report */
  toggleReasoningReport: (show: boolean) => void;
}

/**
 * Diagram configuration options
 */
export interface DiagramConfig {
  /** Whether to allow horizontal scrolling */
  allowHorizontalScroll?: boolean;
  /** Whether to allow vertical scrolling */
  allowVerticalScroll?: boolean;
  /** Whether to allow zooming */
  allowZoom?: boolean;
  /** Initial content alignment */
  contentAlignment?: any;
  /** Grid configuration */
  grid?: {
    visible: boolean;
    gridCellSize: any;
    gridOrigin: any;
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
    offset: any;
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
  /** Diagram instance */
  diagram: any;
  /** Set diagram instance */
  setDiagram: (diagram: any) => void;
}

/**
 * Event handler types for diagram interactions
 */
export interface DiagramEventHandlers {
  /** Node selection changed */
  onNodeSelectionChanged: (node: NodeData | null) => void;
  /** Link selection changed */
  onLinkSelectionChanged: (link: LinkData | null) => void;
  /** Node double clicked */
  onNodeDoubleClick: (node: NodeData) => void;
  /** Link double clicked */
  onLinkDoubleClick: (link: LinkData) => void;
  /** Background clicked */
  onBackgroundClick?: () => void;
  /** Diagram model changed */
  onModelChanged?: (changes: any) => void;
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

/**
 * Backwards-compatible aliases (temporary)
 *
 * These keep existing imports that referenced `NodeData` / `LinkData`
 * working until all references are renamed. They will be removed as part of
 * the purge sweep.
 */
export type NodeData = NodeData;
export type LinkData = LinkData;
