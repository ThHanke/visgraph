VisGraph — Browser-based RDF Knowledge Graph Editor
====================================================

[![DOI](https://zenodo.org/badge/1049705027.svg)](https://doi.org/10.5281/zenodo.19605270)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

## Table of Contents

- [Overview](#overview)
- [Key capabilities](#key-capabilities)
- [Quick start (development)](#quick-start-development)
- [Startup / URL parameters](#startup--url-parameters)
- [Reasoning demo](#reasoning-demo)
- [CORS and proxies](#cors-and-proxies)
- [Using the UI](#using-the-ui)
- [Developer utilities](#developer-utilities-window-globals)
- [Troubleshooting](#troubleshooting)
- [AI / MCP Integration](#ai--mcp-integration)
  - [How it works](#how-it-works)
  - [Setup (Playwright / headless)](#setup-playwright--headless)
  - [Recommended workflow](#recommended-workflow)
  - [Using VisGraph with any AI](#using-visgraph-with-any-ai)
    - [Claude Code / Playwright](#claude-code--playwright-full-automation)
    - [AI Relay Bridge (ChatGPT, Gemini, Claude.ai)](#chatgpt-gemini-claudeai--ai-relay-bridge)
- [Contributing](#contributing--development-notes)
- [License & authors](#license--authors)

Overview
--------
VisGraph is a browser-based [RDF](https://www.w3.org/RDF/)/ontology knowledge graph editor. It loads RDF from local files, remote URLs, or SPARQL/Fuseki endpoints; lets users author nodes and edges directly on the canvas; runs [OWL-RL](https://www.w3.org/TR/owl2-profiles/#OWL_2_RL) reasoning with visual differentiation of inferred triples; and applies multi-algorithm layout ([Dagre](https://github.com/dagrejs/dagre), [ELK](https://github.com/kieler/elkjs)) and automatic clustering for large graphs. Additional features include namespace management with live URI renaming, a drag-and-drop workflow template catalog, and a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for AI-agent integration. All computation runs entirely client-side in the browser against an in-memory RDF store backed by Web Workers — no backend required.

Key capabilities
----------------
- Load RDF/Turtle/JSON-LD/RDF-XML/N-Triples from local files or remote URLs (including SPARQL endpoints and Fuseki datasets).
- Startup URL support: auto-load an RDF file via URL query parameter (see "Startup / URL usage" below).
- **Reactodia canvas**: pan, zoom, minimap, fit-view, with entity group (cluster) support and smooth animations.
- **Authoring mode** (always on): add nodes via search, draw edges by dragging the halo "Establish Link" handle, edit node annotation properties and link predicates directly on the canvas. Undo/Redo support. Entity auto-complete uses scored domain/range tiers derived from loaded ontologies.
- **Search**: type in the search box to find entities by label or IRI; press Enter to cycle through matches on the canvas.
- **TBox / ABox views**: toggle between ontology-level classes/properties (TBox) and data-level individuals (ABox).
- **Layout engine**: multiple algorithms — Dagre (horizontal/vertical), ELK (layered, force, stress, radial), and Reactodia-default — all running in Web Workers so the UI stays responsive. Spacing is adjustable via a slider; re-layout triggers automatically when spacing changes.
- **Clustering**: automatic grouping of large graphs on load. Three algorithms available — Label Propagation (default), Louvain, and K-Means. Threshold is configurable (default 100 nodes). Expand/collapse individual clusters or all at once from the toolbar.
- **OWL-RL reasoning**: run inference in the browser and see inferred triples rendered as amber dashed edges; inferred types/annotations appear in amber italic. A reasoning report lists all inferred triples grouped by rule. Clear inferred triples any time without affecting asserted data.
- **Namespace management**: edit namespace URIs directly in the legend panel (rename propagates across all stored triples). Colour-coded namespace badges on nodes and edges.
- Export the current graph as Turtle, RDF/XML, or JSON-LD.
- **Workflow catalog**: drag reusable workflow template cards from the sidebar onto the canvas to instantiate connected subgraphs.
- **MCP support**: exposes a Model Context Protocol server (via the browser's `navigator.modelContext` API) for AI-agent integration. Tools: `loadRdf`, `loadOntology`, `queryGraph`, `exportGraph`, `exportImage`, `addNode`, `removeNode`, `getNodes`, `addLink`, `removeLink`, `getLinks`, `searchEntities`, `autocomplete`, `runLayout`, `runReasoning`, `clearInferred`, `getCapabilities`. MCP manifest at `/.well-known/mcp.json`.

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

### Ontology pre-loading

| Parameter   | Alias        | Description |
|-------------|--------------|-------------|
| `ontology`  | `ontologies` | Comma-separated list of ontologies to load on startup, in addition to any configured autoload and `owl:imports` discovery. Each value is either a well-known short name (see table below) or an arbitrary HTTPS/HTTP URI. |

```text
?ontology=bfo,dcat
?ontology=bfo2020,https://example.org/myontology.ttl
```

**Well-known short names:**

| Short name | Ontology |
|------------|----------|
| `rdf`      | RDF Concepts Vocabulary |
| `rdfs`     | RDF Schema |
| `owl`      | OWL |
| `skos`     | SKOS |
| `prov`     | PROV-O – The PROV Ontology |
| `p-plan`   | P-Plan Ontology |
| `bfo`      | BFO 2.0 – Basic Formal Ontology 2.0 |
| `bfo2020`  | BFO 2020 – Basic Formal Ontology 2020 |
| `dcat`     | DCAT – Data Catalog Vocabulary |
| `foaf`     | FOAF |
| `dcterms`  | Dublin Core Terms |
| `qudt`     | QUDT |
| `iof-core` | IOF Core |

### Import discovery

| Parameter     | Default | Description |
|---------------|---------|-------------|
| `loadImports` | `true`  | Set to `false` to disable automatic loading of `owl:imports` referenced in the loaded RDF. Overrides the per-session app setting without persisting it. |

```text
?rdfUrl=https://example.org/data.ttl&loadImports=false
```

### Full example (CKAN private dataset via Fuseki SPARQL)

```text
http://docker-dev.iwm.fraunhofer.de:8080/
  ?rdfUrl=https://docker-dev.iwm.fraunhofer.de/dataset/<uuid>/fuseki/$/sparql
  &apiKey=<ckan-api-jwt-token>
```

### Startup loading order

All startup mechanisms are additive and run in this order:

1. Configured additional ontologies (app settings → *persistedAutoload*)
2. RDF data graph (`rdfUrl` / `url` / `vg_url`)
3. Ontologies from `?ontology=` URL parameter
4. `owl:imports` discovery (runs after each load unless `?loadImports=false`)

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

### Top bar — left group

**1** **☰ View menu** — dropdown: Export canvas as PNG, Export as SVG, Print, Show/Hide Legend (toggles the namespace colour key panel).

**2** **Search** — type to find entities by label or IRI. ↑↓ arrows or **Enter** cycle through matches on the canvas. The badge shows current match / total count.

### Top bar — right group (action toolbar)

**3** **Layout** — opens the layout popover: choose algorithm (Dagre horizontal/vertical, ELK layered/force/stress/radial, Reactodia-default), adjust spacing via a slider, toggle auto-layout (re-runs after every graph update).

**4** **Clustering algorithm selector** — choose between None, Label Propagation, Louvain, or K-Means. The large-graph threshold (default 100 nodes, configurable in Settings) controls when auto-clustering runs on load.

**5** **Cluster** — cluster visible nodes with the selected algorithm. Disabled when already clustered or algorithm is None.

**6** **Expand All** — expand all collapsed cluster groups at once.

**7** **A-Box / T-Box** — switch between instance-level individuals (A-Box, highlighted when active) and ontology-level classes/properties (T-Box).

**8** **Ontologies** — shows the count of loaded ontologies. Click to open a popover listing each ontology with options to add/remove from autoload.

**9** **Reasoning status** — shows the current OWL-RL state: Ready / ✓ Valid / ⚠ Warnings / Errors / spinner while running. Click to open the reasoning report (inferred triples grouped by rule).

**10** **Clear inferred** (🗑) — removes all inferred triples without touching asserted data.

**11** **Run reasoning** (▶) — triggers the OWL-RL reasoner. Inferred triples appear as amber dashed edges. Idempotent.

### Authoring toolbar (bottom left)

**12** **Undo** — undo last authoring change.

**13** **Redo** — redo last undone change.

**14** **Save** — commit all pending authoring edits to the RDF store in a single batch.

**15** **Re-layout** — re-apply the current layout algorithm in-place.

### Left sidebar

**16** **Onto** — open the ontology loader. Enter any HTTP(S) URL or pick from pre-configured sources in Settings.

**17** **File** — open a file picker for local RDF files. Supported: Turtle (.ttl), JSON-LD (.jsonld), RDF/XML (.rdf/.owl), N-Triples (.nt).

**18** **Clear** — remove all loaded graphs and reset the canvas.

**19** **Export** — export as Turtle, JSON-LD, or RDF/XML (dropdown). Generated entirely in the browser.

**20** **Settings** — open the settings panel for default layout, clustering algorithm, large-graph threshold, ontology autoload URLs, workflow catalog, and other preferences.

### Sidebar content (expanded)

When the sidebar is expanded (click the **›** toggle), the file operation buttons are shown in a compact grid. A **Workflows** accordion appears below when the workflow catalog is enabled in Settings. Drag a template card onto the canvas to instantiate it as a connected subgraph.

### Node authoring halo (visible on selected node)

**21** **Edit / Delete** — buttons that appear above a selected node. **Edit** opens the property editor (IRI, annotation properties, custom fields). **Delete** permanently removes the entity from the RDF store.

**22** **Remove** (✕) — removes the node from the canvas view without deleting it from the RDF store.

**23** **Establish Link** (plug icon, right side) — drag to another node to create a new edge. A dialog confirms the predicate with scored autocomplete from loaded ontologies.

**24** **Expand neighbours** (∧, bottom) — load and show all RDF neighbours of the node on the canvas.

### Canvas elements

**25** **Individual node** — represents an RDF subject. The header shows the local name, a coloured namespace badge, and the OWL class. Properties (IRI, annotations, custom fields) are shown in an editable table on selection.

**26** **Edge / predicate** — labelled arrow between two nodes. Amber dashed edges are inferred triples. Double-click to open the link property editor (scored autocomplete from ontologies).

**27** **Minimap** — overview panel at bottom-right. Click to jump to a region, drag to pan.

### Canvas interactions
- **Add a node**: type in **2** Search and press Enter to search the ontology; select a match to place it on the canvas.
- **Authoring mode** is always active: hover a node to reveal the halo (**21**–**24**).
- Drag the **23** Establish Link handle to another node to create a new edge.
- Double-click an edge (**26**) to open the link property editor.
- Scroll to zoom; drag the background to pan.
- Namespace legend panel: enable via **1** View menu → Show Legend. Click a namespace entry's pencil icon to rename its URI; renames propagate across all stored triples.
- Use the fit-view button in the canvas controls (left side, zoom icon group) to reset the viewport.

Developer utilities (window globals)
------------------------------------
The following debug flags can be set in the browser console to enable diagnostic output. All are gated — they only activate when `window.__VG_DEBUG__` is truthy (or `config.debugAll` is enabled in Settings):

- `window.__VG_DEBUG__` — master debug gate. Set to `true` to enable all `[VG_*]` diagnostic console output.
- `window.__VG_LOG_RDF_WRITES` — log RDF triple writes to the console.
- `window.__VG_DEBUG_STACKS__` — capture stack traces in debug messages.
- `window.__VG_DEBUG_SUMMARY__` — read-only object populated by the startup debug harness with fallback and timing data.

All flags are also persisted from `config.debugAll` (toggleable in Settings → Debug). Setting `config.debugAll = true` via Settings is the recommended way to enable diagnostics without console access.

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

AI / MCP Integration
--------------------

VisGraph exposes a full [Model Context Protocol](https://modelcontextprotocol.io) tool surface so AI agents can build and reason over knowledge graphs through natural-language chat.

### How it works

The app has two coupled layers:

- **N3 RDF store** — source of truth. `addNode` / `addLink` write triples here.
- **Reactodia canvas** — visual mirror. Nodes are *not* created automatically from triples; you must call `addNode` to place a subject on canvas. After adding triples, canvas links refresh automatically. Nodes start collapsed — call `expandNode` or `expandAll` to reveal annotation property cards.

OWL-RL reasoning writes inferred triples back to the store and refreshes the canvas.

### Setup (Playwright / headless)

`navigator.modelContext` does not exist in headless Chromium. Inject the polyfill **before** the page loads using `page.addInitScript`:

```js
await page.addInitScript(() => {
  const tools = {};
  Object.defineProperty(navigator, 'modelContext', {
    value: { registerTool: async (n, _d, _s, h) => { tools[n] = h; } },
    configurable: true,
  });
  window.__mcpTools = tools;
});

// After page load:
await page.evaluate(async () => {
  const mod = await import('/src/mcp/visgraphMcpServer.ts');
  await mod.registerMcpTools();
});

// Call a tool:
await page.evaluate(async ([name, params]) => window.__mcpTools[name](params),
  ['addNode', { iri: 'ex:alice', typeIri: 'foaf:Person', label: 'Alice' }]);
```

In a browser with native `navigator.modelContext`, tools register automatically on app load.

### Recommended workflow

```text
loadOntology (TBox)
  → addNode ×N  (ABox individuals, rdf:type set)
  → addLink ×N  (object-property triples, edges appear on canvas)
  → runLayout   (dagre-lr recommended)
  → expandAll   (reveal annotation property cards)
  → runReasoning (infer subClass / domain / range entailments)
  → fitCanvas + exportImage   (SVG snapshot, token-efficient)
  → exportGraph(turtle)       (final deliverable)
```

### URL parameters

| Parameter | Effect |
|-----------|--------|
| `?url=<encoded-url>` | Load RDF from URL on startup |
| `?ontology=foaf` | Pre-load FOAF ontology |
| `?loadImports=false` | Skip owl:imports auto-loading |

### Demo

| Demo | Description |
|------|-------------|
| [FOAF social network](docs/mcp-demo/foaf-social-network.md) | Build a social network from scratch, run reasoning, add people |
| [OWL-RL reasoning](docs/mcp-demo/reasoning-demo.md) | Build a full TBox + ABox, then watch the reasoner infer types and relationships |

Regenerate:

```sh
node scripts/mcp-demo-foaf.mjs
node scripts/mcp-demo-reasoning.mjs
```

Full tool declarations with input schemas: [public/.well-known/mcp.json](public/.well-known/mcp.json)

### Using VisGraph with any AI

The demo scripts work against the **live deployment** — no local server needed. Any AI that can drive a browser (Claude Code, headless Playwright, computer-use agents) can use VisGraph directly via its MCP tools.

#### Claude Code / Playwright (full automation)

Point the demo scripts at the deployed app:

```sh
node scripts/mcp-demo-reasoning.mjs --url https://thhanke.github.io/visgraph
node scripts/mcp-demo-foaf.mjs       --url https://thhanke.github.io/visgraph
```

The script opens a headless browser, navigates to the URL, registers the MCP tools, then drives the full workflow — building TBox + ABox, running reasoning, taking snapshots, exporting Turtle — exactly as shown in the demo documents.

#### ChatGPT, Gemini, Claude.ai — AI Relay Bridge

The **AI Relay Bridge** connects any AI chat tab to VisGraph with no server, extension, or copy-paste. A bookmarklet watches the AI's output for `TOOL:` / `PARAMS:` blocks, executes them in VisGraph via a BroadcastChannel popup, and injects results back into the chat input automatically.

➡️ **[Full setup guide: docs/relay-bridge.md](docs/relay-bridge.md)**

**Setup (one time):**
1. Open VisGraph, expand the **AI Relay** sidebar panel
2. Drag the **VisGraph Relay** button to your browser bookmark bar
3. Go to your AI chat tab and click the bookmark — a small relay popup opens

**Starter prompt** (paste into your AI chat after clicking the bookmarklet):

```text
You are connected to VisGraph via a relay. A script in your browser tab scans your responses for MCP tool calls, executes them in VisGraph, and injects the combined result back as a user message.

OUTPUT FORMAT — one MCP JSON-RPC 2.0 request per line, each wrapped in single backticks:
`{"jsonrpc":"2.0","id":<N>,"method":"tools/call","params":{"name":"<toolName>","arguments":{...}}}`

Rules:
1. You may output multiple tool calls in one response. They run sequentially in order.
2. Use a different integer id for each call.
3. Wait for the injected result message before issuing more calls.
4. Never output a tool call unless you intend it to run — the relay executes everything it finds.
5. addLink requires both nodes to already exist on canvas — never issue addNode and addLink for the same node in one response.

Reading results:
The relay injects a message like:
[VisGraph — N tools ✓]
`{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"<summary>"}]}}`

- Parse each backtick-wrapped line as a JSON-RPC 2.0 response. id matches your request id.
- result means success; error means failure (check error.message).
- A Canvas summary line and SVG may follow after the responses.

Common prefixes you can use in argument values: rdf: rdfs: owl: xsd: foaf: skos: dc: dcterms: schema: ex:

Fetch https://thhanke.github.io/visgraph/.well-known/mcp.json for the full tool list with parameter names.

Now build a knowledge graph. What would you like to model?
```

The relay handles execution and result feedback automatically — no manual copy-paste needed.

Contributing / Development notes
---------------------------------
- Canvas & top bar: [src/components/Canvas/](src/components/Canvas/)
- Cluster algorithms: [src/components/Canvas/core/clusterAlgorithms/](src/components/Canvas/core/clusterAlgorithms/)
- Layout functions: [src/components/Canvas/layout/](src/components/Canvas/layout/)
- Search widget: [src/components/Canvas/search/](src/components/Canvas/search/)
- RDF worker and protocol: [src/workers/](src/workers/)
- MCP server and tools: [src/mcp/](src/mcp/)
- Tests: [src/__tests__/](src/__tests__/) — run with `npm test`.

License & authors
-----------------
Check the repository root for licence and contributor information.
