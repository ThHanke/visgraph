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

## More reading

- [AGENT.md](AGENT.md) — detailed tool reference, SPARQL caveats, PMDCO patterns
- [docs/relay-bridge.md](docs/relay-bridge.md) — relay bridge setup guide
- [public/.well-known/mcp.json](public/.well-known/mcp.json) — machine-readable tool manifest
- [README.md](README.md) — full feature docs and quick start
