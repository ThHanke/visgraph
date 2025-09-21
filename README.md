VisGraph — interactive RDF / ontology canvas

Overview
---------
VisGraph is a lightweight interactive editor for RDF knowledge graphs and ontologies. It visualizes RDF subjects as nodes and predicates as edges, provides simple editing (add nodes, create links, edit node/link properties), and integrates basic reasoning to surface inconsistencies. The canvas is implemented with React Flow and connects to an in-browser RDF manager so you can load, inspect, and persist triples directly from the UI.

Key capabilities
----------------
- Load RDF/Turtle/JSON-LD content from local files or remote URLs.
- Startup URL support: open the app with a URL parameter to auto-load an RDF file (see "Startup / URL usage" below).
- Editable canvas: add nodes, create edges, edit node annotation properties and link predicates.
- TBox / ABox views: toggle between ontology-level (TBox) entities and data-level (ABox) entities.
- Layout controls: apply deterministic Dagre layouts (horizontal / vertical) and fit view.
- Export the current graph as Turtle, RDF/XML (OWL) or JSON-LD.
- Developer-friendly diagnostics and an initializer exposed on window for scripted startup.

Quick start (development)
-------------------------
1. Install dependencies (if not already):
   npm install
2. Start the Vite dev server:
   npm run dev
3. Open the app in your browser:
   http://localhost:8080/

Startup / URL usage
-------------------
You can open the app with a URL parameter to make it load a remote RDF file on startup (developer-friendly feature):

- Preferred query parameter: rdfUrl
  Example (encoded):
  http://localhost:8080/?rdfUrl=https%3A%2F%2Fraw.githubusercontent.com%2FMat-O-Lab%2FIOFMaterialsTutorial%2Frefs%2Fheads%2Fmain%2FLengthMeasurement.ttl

Notes about startup loading
- The application will accept:
  1) an inline TTL string via the window flag __VG_STARTUP_TTL
  2) the rdfUrl query parameter (preferred)
  3) legacy url or vg_url query params
  4) explicit window overrides (window.__VG_STARTUP_URL) or environment VITE_STARTUP_URL
- For safety the loader only accepts http(s) URLs or inline TTL. Local filesystem paths are not automatically loaded.
- If startup loading fails, check the browser console for parse errors and the Network tab for CORS issues.

CORS and proxies
----------------
- The app fetches remote RDF directly from the browser. If the remote host does not allow cross-origin requests (CORS), the browser will block the fetch.
- If you encounter CORS errors, one of these workarounds helps:
  - Use a CORS-enabled hosting for the TTL file.
  - Use a local dev proxy that forwards the request (configure your dev server if needed).

Using the UI
------------
Top toolbar (left → right):
- Add Node: create a new node by IRI (supports prefixed form that the RDF manager can expand).
- Load Ontology: load one or more ontologies configured in application settings.
- A-Box / T-Box: switch between data-level (individuals) and ontology-level (classes/properties).
- Legend: show/hide namespace legend (colors and prefixes).
- Layout selector: choose horizontal / vertical layouts.
- Load File: open a local RDF file from disk (TTL/JSON-LD/RDF/XML).
- Export: export current graph (Turtle / OWL-XML / JSON-LD).

Canvas interactions:
- Double-click a node to open node editor (edit labels, annotation properties).
- Double-click an edge to edit its predicate or properties.
- Drag from a node handle to another node to start creating an edge (the editor will open to confirm predicate).
- Use Controls to zoom, fit view, and reset.

Developer utilities (window globals)
------------------------------------
- window.__VG_INIT_APP() — initialize loading programmatically.
- window.__VG_APPLY_LAYOUT('horizontal'|'vertical') — apply programmatic layout.
- window.__VG_ALLOW_PERSISTED_AUTOLOAD — opt in to persisted autoload behavior.
- window.__VG_STARTUP_TTL — inline TTL content to load on startup.
- window.__VG_STARTUP_URL — explicit startup URL override.

Troubleshooting
---------------
- If rdfUrl doesn't load on open:
  - Confirm the URL is percent-encoded in the browser address bar.
  - Open DevTools → Network and check the fetch request and response headers.
  - Look for CORS errors (Access-Control-Allow-Origin).
  - Check console logs for RDF parser errors or application diagnostics.
- If you see server-side 403 when you include certain query param names:
  - Some dev servers may intercept/reserve certain query names. Using ?rdfUrl=... avoids common reserved names.

Contributing / Development notes
-------------------------------
- Source files: src/components/Canvas/ReactFlowCanvas.tsx and related components in src/components/Canvas/.
- Tests are in src/__tests__ (unit & e2e).
- Use "npm run dev" to run locally, and run test scripts with npm test (project tests may be configured in package.json).

License & authors
-----------------
Check the repository root for license and contributor information.
