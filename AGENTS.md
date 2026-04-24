# VisGraph — Agent Guide

VisGraph is a browser-based RDF/ontology knowledge graph editor with a full
[Model Context Protocol (MCP)](https://modelcontextprotocol.io) tool surface.
AI agents can build, query, reason over, and export knowledge graphs through
natural-language chat — no backend required.

## Live instance

```
https://thhanke.github.io/visgraph/
```

Local dev (after `npm install && npm run dev`):

```
http://localhost:8080/
```

Verify the app is running:

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080
# 200 = ready
```

## MCP tool surface

The manifest is served at `/.well-known/mcp.json` — a W3C-compatible MCP
discovery document with full JSON Schema input declarations for every tool.

```
https://thhanke.github.io/visgraph/.well-known/mcp.json
```

**Key tools** (30+ total — see manifest for full schemas):

| Tool | Purpose |
|------|---------|
| `loadOntology` | Load TBox (schema/classes) — no canvas nodes |
| `loadRdf` | Load ABox (individuals) — subjects appear as canvas nodes |
| `addNode` / `removeNode` | Add/remove individual canvas nodes |
| `addLink` / `removeLink` | Add/remove object-property triples |
| `queryGraph` | SPARQL SELECT / CONSTRUCT against the RDF store |
| `runReasoning` | OWL-RL inference — inferred triples in `urn:vg:inferred` |
| `runLayout` | Layout: `dagre-lr`, `dagre-tb`, `elk-layered`, `elk-force`, … |
| `focusNode` / `fitCanvas` | Pan/zoom viewport |
| `exportImage` | Export full canvas as SVG or PNG |
| `exportGraph` | Export RDF store as Turtle / JSON-LD / RDF-XML |
| `getNodes` / `getLinks` | Inspect current canvas state |
| `getNeighbors` / `findPath` | Graph traversal queries |
| `loadShacl` / `validateGraph` | SHACL constraint validation |
| `getCapabilities` / `help` | Discover tools at runtime |

## How to call tools

### Option A — Claude Code / Playwright (full automation)

Tools are exposed as `window.__mcpTools` in the browser page:

```js
// Playwright browser_evaluate:
await page.evaluate(async () => {
  return await window.__mcpTools['addNode']({
    iri: 'https://example.org/Alice',
    label: 'Alice',
    typeIri: 'http://xmlns.com/foaf/0.1/Person',
  });
});
```

### Option B — AI Relay Bridge (ChatGPT, Claude.ai, Gemini, …)

Any AI chat that can emit inline JSON-RPC 2.0 tool calls can control VisGraph
via the **relay bookmarklet** — no browser extension, no server.

1. Open VisGraph and drag the **"⚡ VisGraph Relay"** button from the left
   sidebar → **AI Relay** section to your bookmark bar.
2. Open your AI chat tab and click the bookmarklet.
3. Paste the starter prompt below; the relay intercepts tool calls and injects
   results back automatically.

Full setup: [docs/relay-bridge.md](docs/relay-bridge.md)

**Relay starter prompt:**

```
You are connected to VisGraph via a relay. A script in this tab intercepts
your JSON-RPC 2.0 tool calls (wrapped in backtick fences), runs them in
VisGraph, and injects results back as a user message. All computation runs
client-side. Full tool list: https://thhanke.github.io/visgraph/.well-known/mcp.json
```

## Graph architecture (read before building)

| Layer | How loaded | Appears on canvas | Indexed by getNodes |
|-------|-----------|-------------------|---------------------|
| **TBox** — classes, properties | `loadOntology` | No | Yes |
| **ABox** — individuals | `addNode` / `loadRdf` | Yes | Yes |

Canvas nodes are **not** created automatically when triples are added — you
must call `addNode`. After adding triples, canvas links refresh automatically.

OWL-RL inferred triples go to the `urn:vg:inferred` named graph and render as
amber dashed edges. Clear them with `clearInferred`.

## Recommended workflow

```
loadOntology(url)           # TBox — classes/properties searchable, no canvas nodes
  ↓
getNodes({ labelContains: '…' })   # IRI lookup from TBox
  ↓
addNode × N (typeIri from lookup)  # ABox individuals on canvas
  ↓
addLink × N                        # subjectIri / predicateIri / objectIri
  ↓
runLayout({ algorithm: 'dagre-lr' })
  ↓
runReasoning({})                   # OWL-RL → urn:vg:inferred
  ↓
focusNode({ iri }) → browser_take_screenshot   # show the user
  ↓
exportGraph({ format: 'turtle' })  # persist
```

**Never call `expandAll` after loading a large ontology** — it floods the
canvas with thousands of TBox nodes.

## Common parameter mistakes

| Tool | Wrong | Right |
|------|-------|-------|
| `addLink` | `{ s, p, o }` | `{ subjectIri, predicateIri, objectIri }` |
| SPARQL | bare `owl:Class` | declare `PREFIX owl: <…>` in every query |

## Example sessions (rendered demos)

Rendered agent sessions with SVG snapshots at each step:

| Demo | What it shows |
|------|--------------|
| [FOAF Social Network](docs/mcp-demo/foaf-social-network.md) | Build a social + employment graph; extend FOAF with custom classes; run OWL-RL reasoning to infer types |
| [OWL Reasoning](docs/mcp-demo/reasoning-demo.md) | Disjointness, transitivity, domain/range inference — step-by-step with visual diffs |
| [Scene Ontology](docs/mcp-demo/scene-ontology.md) | Load an external ontology; author individuals; export Turtle |

Re-run any demo against a live server:

```bash
node scripts/run-demo.mjs docs/mcp-demo/seeds/foaf-social-network.md
```

## URL startup parameters

Agents can deep-link VisGraph with pre-loaded data:

| Parameter | Description |
|-----------|-------------|
| `rdfUrl` / `url` | HTTP(S) URL of an RDF file to load on startup |
| `ontology` | Comma-separated ontology short names or URIs to pre-load |
| `reasoning=true` | Run OWL-RL reasoning automatically after load |

Example:
```
https://thhanke.github.io/visgraph/?rdfUrl=https://example.org/data.ttl&reasoning=true
```

## Discovering property IRIs

Do **not** assume property names from ontology labels. Query first:

```sparql
PREFIX owl: <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?prop ?label WHERE {
  ?prop a owl:ObjectProperty .
  OPTIONAL { ?prop rdfs:label ?label }
} LIMIT 50
```

## SPARQL caveats

- Every query needs explicit `PREFIX` declarations — there are no implicit prefixes.
- `FILTER(STRSTARTS(STR(?s), '...'))` in SELECT/CONSTRUCT does **not** reliably filter triples (N3.js limitation) — returns full store. Use named graphs or check `urn:vg:inferred` instead.
- Inferred triples are stored in the `urn:vg:inferred` named graph.

## Showing the user the graph

| Method | What it captures | Note |
|--------|-----------------|------|
| `browser_take_screenshot` | Current visible viewport | Small PNG, best for chat |
| `exportImage({ format: 'svg' })` | Full canvas (all nodes, ignores zoom) | Can be large |
| `exportGraph({ format: 'turtle' })` | Full RDF store (incl. loaded ontologies) | Can be large |

To show a subgraph: call `focusNode({ iri })` first, then `browser_take_screenshot`.

## PMDCO chemical composition pattern

Key IRIs for modeling material compositions with PMDCO v3:

| Concept | IRI |
|---------|-----|
| portion of matter | `https://w3id.org/pmd/co/PMD_0000001` |
| object (BFO) | `http://purl.obolibrary.org/obo/BFO_0000030` |
| quality (BFO) | `http://purl.obolibrary.org/obo/BFO_0000019` |
| has part | `http://purl.obolibrary.org/obo/BFO_0000051` |
| has quality | `http://purl.obolibrary.org/obo/RO_0000086` |
| iron atom | `http://purl.obolibrary.org/obo/CHEBI_18248` |
| carbon atom | `http://purl.obolibrary.org/obo/CHEBI_27594` |

After `loadOntology`, `pmd:` registers as `https://w3id.org/pmd/co/`. Check with `listNamespaces({})`. All SPARQL queries still need full `PREFIX` declarations.

## More reading

- [docs/relay-bridge.md](docs/relay-bridge.md) — relay bridge setup guide
- [public/.well-known/mcp.json](public/.well-known/mcp.json) — machine-readable tool manifest
- [README.md](README.md) — full feature docs and quick start
