// Timing constants shared between MCP tools and the canvas layout system.

// How long addNode waits for the RDF→canvas pipeline to settle before calling
// navigateToIri. The layout debounce must exceed this so rapid sequential
// addNode calls coalesce into a single layout run.
export const ADD_NODE_PIPELINE_DELAY_MS = 400;

// How long loadRdf waits for the RDF worker change event to propagate to
// dataProvider.allSubjects before querying newly loaded entities.
export const LOAD_RDF_PROPAGATION_DELAY_MS = 600;

// Debounce window for overlap-triggered auto-layout. Must be > ADD_NODE_PIPELINE_DELAY_MS
// so back-to-back addNode calls share one layout run instead of firing N times.
export const LAYOUT_DEBOUNCE_MS = ADD_NODE_PIPELINE_DELAY_MS + 100;

// Default overlap detection threshold (px). Matches the default layoutSpacing so
// overlap detection and layout spacing stay in sync when the user hasn't customised spacing.
export const DEFAULT_OVERLAP_THRESHOLD_PX = 120;
