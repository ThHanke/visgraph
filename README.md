VisGraph — interactive RDF / ontology canvas
=============================================
[![DOI](https://zenodo.org/badge/1049705027.svg)](https://doi.org/10.5281/zenodo.19605270)

Overview
--------
VisGraph is an interactive editor for RDF knowledge graphs and ontologies built on the [Reactodia](https://github.com/reactodia/reactodia-workspace) canvas. It visualises RDF subjects as nodes and predicates as edges, provides full authoring (add nodes, create and edit links, rename namespaces), applies OWL-RL reasoning with visual differentiation of inferred knowledge, and automatically clusters large graphs for readability — all directly in the browser against an in-memory RDF store backed by Web Workers.

Key capabilities
----------------
- Load RDF/Turtle/JSON-LD/RDF-XML/N-Triples from local files or remote URLs (including SPARQL endpoints and Fuseki datasets).
- Startup URL support: auto-load an RDF file via URL query parameter (see "Startup / URL usage" below).
- **Reactodia canvas**: pan, zoom, minimap, fit-view, with entity group (cluster) support and smooth animations.
- **Authoring mode**: add nodes, draw edges, edit node annotation properties and link predicates directly on the canvas. Entity auto-complete uses scored domain/range tiers derived from loaded ontologies.
- **TBox / ABox views**: toggle between ontology-level classes/properties (TBox) and data-level individuals (ABox).
- **Layout engine**: multiple algorithms — Dagre (horizontal/vertical), ELK (layered, force, stress, radial), and Reactodia-default — all running in Web Workers so the UI stays responsive. Spacing is adjustable via a slider; re-layout triggers automatically when spacing changes.
- **Clustering**: automatic grouping of large graphs on load. Three algorithms available — SLPA (default), K-means, and Louvain. Threshold is configurable (default 100 nodes). Expand/collapse individual clusters or all at once from the toolbar.
- **OWL-RL reasoning**: run inference in the browser and see inferred triples rendered as amber dashed edges; inferred types/annotations appear in amber italic. A reasoning report lists all inferred triples grouped by rule. Clear inferred triples any time without affecting asserted data.
- **Namespace management**: edit namespace URIs directly in the legend (rename propagates across all stored triples). Colour-coded namespace badges on nodes and edges.
- Export the current graph as Turtle, RDF/XML (OWL), or JSON-LD.
- Developer-friendly diagnostics and a global initialiser exposed on `window` for scripted startup.

Quick start (development)
-------------------------
1. Install dependencies:
   ```sh
   npm install
   ```
2. Start the Vite dev server:
   ```sh
   npm run dev
   ```
3. Open in your browser:
   ```text
   http://localhost:8080/
   ```

Startup / URL parameters
------------------------
VisGraph supports several URL query parameters that control what is loaded on startup.

### RDF data URL

| Parameter | Aliases        | Description |
|-----------|----------------|-------------|
| `rdfUrl`  | `url`, `vg_url` | HTTP(S) URL of an RDF resource to load on startup. |

**Supported sources:**

1. **Plain RDF files** — Turtle (.ttl), N-Triples (.nt), N3, RDF/XML, JSON-LD. Format is detected from `Content-Type` and file extension.
   ```
   ?rdfUrl=https://example.org/mydata.ttl
   ```

2. **SPARQL endpoints** — URLs whose path ends with `/sparql` or `/query` are recognised automatically. VisGraph issues a `CONSTRUCT { ?s ?p ?o } WHERE { { ?s ?p ?o } UNION { GRAPH ?g { ?s ?p ?o } } }` query.
   ```
   ?rdfUrl=https://example.org/fuseki/$/sparql
   ```

3. **Fuseki dataset root** — Returns the full dataset; named-graph quads are flattened into the data graph.
   ```
   ?rdfUrl=https://docker-dev.iwm.fraunhofer.de/dataset/<uuid>/fuseki/$/
   ```

### Authentication (API key)

| Parameter      | Default         | Description |
|----------------|-----------------|-------------|
| `apiKey`       | —               | Value sent as an authentication header with the RDF fetch. |
| `apiKeyHeader` | `Authorization` | Name of the HTTP header. |

```text
?rdfUrl=https://private-endpoint.example.org/data.ttl
&apiKey=Bearer+my-token
&apiKeyHeader=Authorization
```

The API key is sent only with the RDF fetch request. CORS: the server must allow the VisGraph origin with credentials (wildcard `*` origins are incompatible with authenticated requests).

### Full example (CKAN private dataset via Fuseki SPARQL)

```text
http://docker-dev.iwm.fraunhofer.de:8080/
  ?rdfUrl=https://docker-dev.iwm.fraunhofer.de/dataset/<uuid>/fuseki/$/sparql
  &apiKey=<ckan-api-jwt-token>
```

### Other startup mechanisms

- `window.__VG_STARTUP_TTL` — inline Turtle string loaded before any URL parameter.
- `window.__VG_STARTUP_URL` — programmatic URL override (takes precedence over `rdfUrl`).
- `VITE_STARTUP_URL` environment variable — build-time default startup URL.

Reasoning demo
--------------
The reasoning demo ontology showcases OWL-RL inference directly in the browser:

https://thhanke.github.io/visgraph/?rdfUrl=https://raw.githubusercontent.com/ThHanke/visgraph/refs/heads/main/public/reasoning-demo.ttl

The demo (`public/reasoning-demo.ttl`) defines a small employee hierarchy (Person → Employee → Manager → Executive) with ABox assertions that drive five inference patterns:

1. **rdfs:subPropertyOf** — `ex:hasFriend` is a sub-property of `ex:knows`, so `alice hasFriend bob` infers `alice knows bob`.
2. **owl:inverseOf** — `ex:isManagedBy` is the inverse of `ex:manages`, so `alice manages carol` infers `carol isManagedBy alice`.
3. **owl:SymmetricProperty** — `ex:isColleagueOf` is symmetric, so `bob isColleagueOf carol` infers the reverse direction.
4. **owl:TransitiveProperty** — `ex:hasSupervisor` is transitive, so `bob → alice` and `alice → dave` infers `bob → dave`.
5. **rdfs:domain** — `ex:dave` has no explicit type, but because he is the subject of `ex:manages` (domain `ex:Manager`), the reasoner infers `dave rdf:type ex:Manager`.

Click **Run reasoning** in the toolbar. Inferred triples appear as amber dashed edges. Running again is idempotent. Use **Clear inferred** to remove all inferred triples without affecting asserted data.

CORS and proxies
----------------
VisGraph fetches remote RDF directly from the browser. If the remote host does not allow cross-origin requests, the fetch will be blocked.

Workarounds:
- Use CORS-enabled hosting for the RDF file.
- Configure a local dev proxy in your Vite config to forward the request.

Using the UI
------------
The annotated diagram below identifies the numbered UI elements described in this section.

![VisGraph UI overview](public/ui-overview.svg)

### Toolbar (top bar, full width)

① **Add Node** — opens a dialog to create a new RDF node by full IRI or prefixed name (e.g. `ex:Alice`). The RDF manager expands known prefixes automatically. New nodes default to the class selected in the dialog.

② **A-Box view** — switches the canvas to show ABox individuals (data instances). Active by default.

③ **T-Box view** — switches the canvas to show TBox entities: classes and properties.

④ **Legend** — toggles the namespace colour key. Click a namespace entry's edit icon to rename its URI; the rename propagates across all stored triples.

⑤ **Cluster / Expand All** — cluster the visible nodes using the selected algorithm, or expand all existing clusters at once. The badge shows the number of currently collapsed clusters.

⑥ **Clustering algorithm selector** — choose between SLPA (community detection), K-means, and Louvain. The threshold (large-graph threshold, default 100) controls when auto-clustering activates on load.

⑦ **Ontologies** — shows loaded ontologies and configured sources. Click to open the ontology manager.

⑧ **Layout** — opens the layout popover where you can pick the algorithm (Dagre horizontal/vertical, ELK layered/force/stress/radial, Reactodia-default) and adjust spacing. Clicking the button without the popover triggers a quick re-layout with current settings. Auto-layout re-runs on every graph update when enabled.

⑨ **Reasoning indicator** — shows whether OWL-RL reasoning has been applied. Click to open the reasoning report (inferred triples grouped by rule).

⑩ **Run reasoning** — triggers the OWL-RL reasoner. Inferred triples are added to the store and rendered as amber dashed edges. Idempotent.

⑪ **Clear inferred** — removes all inferred triples from the store and canvas without touching asserted data.

### Sidebar icon buttons (left panel)

⑫ **Onto** — opens the ontology loader. Enter any HTTP(S) URL or pick from pre-configured sources in settings.

⑬ **File** — opens a file picker for local RDF files. Supported: Turtle (.ttl), JSON-LD (.jsonld), RDF/XML (.rdf/.owl), N-Triples (.nt).

⑭ **Clear** — removes all loaded graphs and resets the canvas.

⑮ **Export** — exports the current graph as Turtle, OWL-XML, or JSON-LD. Generated entirely in the browser.

⑯ **Settings** — opens the settings panel for default layout, clustering algorithm, large-graph threshold, ontology URLs, and other preferences.

### Sidebar content

⑰ **Workflows panel** — lists reusable workflow templates. Drag a template card onto the canvas to instantiate it as a connected subgraph.

### Canvas elements

⑱ **Cluster node** — represents a group of RDF nodes collapsed into one. The badge shows the member count. Click the cluster handle to expand or collapse it.

⑲ **Individual node** — represents an RDF subject. The header shows the local name, a coloured namespace badge, and the OWL class. Annotation properties (rdfs:label, custom annotations) are shown in a table below. Double-click to open the node editor.

⑳ **Edge / predicate** — an arrow connecting two nodes, labelled with the RDF predicate (local name). Amber dashed edges are inferred triples. Double-click to edit the predicate or link properties.

㉑ **Minimap** — bottom-right overview. Click to jump, drag to pan.

### Canvas interactions
- Double-click a node to open the node editor (edit labels and annotation properties).
- Double-click an edge to edit its predicate or link properties. The link property editor uses scored auto-complete from loaded ontologies.
- Drag from a node handle to another node to create a new edge (a dialog confirms the predicate).
- Scroll to zoom; drag the background to pan.
- Use the fit-view button in the controls panel to reset the viewport.

Developer utilities (window globals)
------------------------------------
- `window.__VG_INIT_APP()` — initialise loading programmatically.
- `window.__VG_APPLY_LAYOUT('horizontal'|'vertical')` — apply a programmatic layout.
- `window.__VG_ALLOW_PERSISTED_AUTOLOAD` — opt in to persisted autoload behaviour.
- `window.__VG_STARTUP_TTL` — inline TTL content loaded on startup.
- `window.__VG_STARTUP_URL` — explicit startup URL override.

Troubleshooting
---------------
- **rdfUrl doesn't load on open:**
  - Confirm the URL is percent-encoded in the address bar.
  - Open DevTools → Network and check the fetch request and response headers.
  - Look for CORS errors (`Access-Control-Allow-Origin`).
  - Check the console for RDF parser errors or application diagnostics.
- **403 when using certain query parameter names:**
  - Some servers intercept reserved query names. Use `?rdfUrl=...` to avoid conflicts.
- **Graph is very large / slow:**
  - Increase the large-graph threshold in Settings or reduce the number of loaded triples.
  - Clustering activates automatically above the threshold; use Expand All sparingly on huge graphs.

Contributing / Development notes
---------------------------------
- Canvas: [src/components/Canvas/](src/components/Canvas/)
- Clustering: [src/services/clustering/](src/services/clustering/)
- Layout functions: [src/layout/](src/layout/)
- RDF worker and protocol: [src/workers/](src/workers/)
- Tests: [src/__tests__/](src/__tests__/) — run with `npm test`.

License & authors
-----------------
Check the repository root for licence and contributor information.
