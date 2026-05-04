# Demo Script: Pizza Ontology — Socratic AI Teaching Session

A small local AI model (qwen3:4b) is guided to discover and build a pizza ontology
through Socratic questions. The model never receives direct instructions — only leading
questions that lead it to apply the right OWL concepts and relay tool calls.

---

## Two ways to reproduce

| Method | When to use |
|--------|-------------|
| [**A. Automated Playwright spec**](#a-automated-playwright-spec) | Clean reproducible recording via `npm run demo:owui:video` |
| [**B. Interactive MCP session**](#b-interactive-mcp-session) | Live exploration / debugging / one-off demos |

---

## A. Automated Playwright spec

Produces a side-by-side video (OWUI chat left, Ontosphere canvas right) with caption
overlays explaining each turn. Output: `docs/demo-videos/openwebui-socratic.mp4`.

### Prerequisites

```bash
# 1. OWUI authentication — do once, saves .playwright/owui-auth.json
OWUI_URL=https://gpuserver1-sit.iwm.fraunhofer.de npm run demo:owui:auth

# 2. Ontosphere dev server running
npm run dev
```

### Record

```bash
OWUI_URL=https://gpuserver1-sit.iwm.fraunhofer.de npm run demo:owui:video
```

This runs `e2e/demo-openwebui-socratic.spec.ts` inside Xvfb (headless with a virtual
display), records at 1920×1080, then converts to MP4 via ffmpeg.

### What the spec does

1. Opens `demo-stage-owui.html` — OWUI on the left, Ontosphere on the right
2. Selects `qwen3:4b`, navigates to a fresh chat
3. Sends plain-text seed → establishes `/c/` URL
4. Injects relay bookmarklet (fetched from Ontosphere frame, bypasses mixed-content)
5. Sends format INSTR message (single-backtick JSON-RPC 2.0 + key tool signatures)
6. Runs T0–T6 with `__vgIsStreaming` idle detection between turns
7. Shows before/after caption overlays at each turn

### Caption overlay text (per turn)

| Turn | Before caption | After caption |
|------|---------------|---------------|
| T0 | Asking qwen3 to add the most fundamental concept: what is a pizza? | qwen3 added the root Pizza class. Next: its two building blocks. |
| T1 | Guiding the model to split Pizza into base and toppings. | Pizza → PizzaBase and PizzaTopping via rdfs:subClassOf. Next: specific base types. |
| T2 | Asking for concrete PizzaBase specialisations. | DeepPanBase and ThinAndCrispyBase added. Next: real toppings. |
| T3 | Populating the topping hierarchy with real ingredients. | Mozzarella, TomatoSauce, Pepperoni linked as PizzaTopping sub-classes. Next: composition. |
| T4 | Introducing object properties: how does a Pizza relate to its parts? | Pizza hasPart PizzaBase and PizzaTopping. Next: visual layout. |
| T5 | Asking the model to arrange the hierarchy for readability. | dagre-tb layout applied. Next: inspecting what was built. |
| T6 | Asking the model to verify its own work via getNodeDetails. | Pizza ontology complete — built entirely through Socratic questioning. |

---

## B. Interactive MCP session

Drive the session manually via Claude Code + Playwright MCP browser.
Use this for live demos, debugging, or exploring model behaviour.

### Prerequisites

1. MCP browser open with two tabs:
   - **Tab 0** — Ontosphere at `http://docker-dev.iwm.fraunhofer.de:8080`
   - **Tab 1** — OWUI at `https://gpuserver1-sit.iwm.fraunhofer.de` (authenticated)

2. Start aggregated session log:

```bash
kill $(cat /tmp/session-log-agg.pid 2>/dev/null) 2>/dev/null; true
while true; do cat .playwright-mcp/console-*.log 2>/dev/null > .playwright-mcp/session.log; sleep 2; done &
echo $! > /tmp/session-log-agg.pid
```

### Bootstrap

```
mcp__playwright__browser_run_code_unsafe filename=.playwright/pizza-demo-setup.js
```

Returns `{ ok: true, chatUrl, instrInjected, turn0 }`. Verify all truthy.

**What this does:**
1. Selects qwen3:4b, clears input
2. Sends plain-text seed → establishes `/c/` URL
3. Injects relay bookmarklet (cross-tab fetch from Ontosphere tab, bypasses HTTPS mixed-content)
4. Waits for seed response to finish
5. Sends format INSTR (single-backtick JSON-RPC 2.0 only, key tool signatures, pizza IRIs)
6. Waits for INSTR response + 1s for `injectInProgress` flag to reset
7. Injects Turn 0: "Can you teach me how ontologies work…"

### Drive turns T1–T6

After Turn 0 completes (relay toast visible, model idle):

```
mcp__playwright__browser_run_code_unsafe filename=.playwright/turn-driver.js
```

Injects T1–T6 sequentially. Waits up to 3 min per turn for model to finish.

### Monitor while running

```bash
tail -f .playwright-mcp/session.log | grep -E '\[RelayBridge\] Tool result:|Unknown tool:'
```

Key log lines:
- `[RelayBridge] Tool result: addNode {"success":true,...}` — tool executed
- `[RelayBridge] Unknown tool: X` — qwen3 used wrong tool name
- `[RelayBridge] BC message received: {"type":"vg-call",...}` — relay received call

---

## Turn-by-turn reference

### Turn 0 — Root concept
> "Can you teach me how ontologies work using pizzas as a real-world example? Start by adding the most fundamental concept to the graph."

Expected: `addNode(iri="ex:Pizza", typeIri="owl:Class", label="Pizza")`

---

### Turn 1 — Two building blocks
> "Great start! A pizza is made of two main building blocks — its base and its toppings. Could you model those as more specific types of Pizza in the ontology?"

Expected:
```
addNode(iri="ex:PizzaBase",    typeIri="owl:Class", label="PizzaBase")
addNode(iri="ex:PizzaTopping", typeIri="owl:Class", label="PizzaTopping")
addLink(subjectIri="ex:PizzaBase",    predicateIri="rdfs:subClassOf", objectIri="ex:Pizza")
addLink(subjectIri="ex:PizzaTopping", predicateIri="rdfs:subClassOf", objectIri="ex:Pizza")
```

---

### Turn 2 — Base variants
> "Nice! PizzaBase can be either deep pan or thin and crispy. Can you add those two variants as more specific types of PizzaBase?"

Expected:
```
addNode(iri="ex:DeepPanBase",        typeIri="owl:Class", label="Deep Pan Base")
addNode(iri="ex:ThinAndCrispyBase",  typeIri="owl:Class", label="Thin And Crispy Base")
addLink(subjectIri="ex:DeepPanBase",       predicateIri="rdfs:subClassOf", objectIri="ex:PizzaBase")
addLink(subjectIri="ex:ThinAndCrispyBase", predicateIri="rdfs:subClassOf", objectIri="ex:PizzaBase")
```

---

### Turn 3 — Concrete toppings
> "Now let's add some real toppings. Can you add Mozzarella, TomatoSauce, and Pepperoni as specific types of PizzaTopping?"

Expected:
```
addNode(iri="ex:Mozzarella",  typeIri="owl:Class", label="Mozzarella")
addNode(iri="ex:TomatoSauce", typeIri="owl:Class", label="Tomato Sauce")
addNode(iri="ex:Pepperoni",   typeIri="owl:Class", label="Pepperoni")
addLink(subjectIri="ex:Mozzarella",  predicateIri="rdfs:subClassOf", objectIri="ex:PizzaTopping")
addLink(subjectIri="ex:TomatoSauce", predicateIri="rdfs:subClassOf", objectIri="ex:PizzaTopping")
addLink(subjectIri="ex:Pepperoni",   predicateIri="rdfs:subClassOf", objectIri="ex:PizzaTopping")
```

---

### Turn 4 — Object property: hasPart
> "The graph has the building blocks, but a Pizza isn't linked to its parts yet. Can you express that a Pizza has both a PizzaBase and a PizzaTopping using an addLink call?"

Expected:
```
addLink(subjectIri="ex:Pizza", predicateIri="ex:hasPart", objectIri="ex:PizzaBase")
addLink(subjectIri="ex:Pizza", predicateIri="ex:hasPart", objectIri="ex:PizzaTopping")
```

qwen3 may choose a different predicate IRI — acceptable as long as a link exists.

---

### Turn 5 — Layout
> "The graph is getting complex. Can you arrange the nodes so the hierarchy is easy to read?"

Expected: `runLayout(algorithm="dagre-tb")` or `elk-layered`

---

### Turn 6 — Introspection
> "Let's verify what we've built. Can you look up the details of the Pizza concept and tell me what you see?"

Expected: `getNodeDetails(iri="ex:Pizza")`

---

## Fallback nudges

**Wrong format** (prose, triple-backtick, etc.):
```
Single backtick JSON-RPC 2.0 only. Example:
`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#Pizza","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"Pizza"}}}`
Try again.
```

**Wrong IRI prefix** (`pizza:Pizza` instead of full IRI):
```
Use full IRIs. ex: = http://www.pizza-ontology.com/pizza.owl# so ex:Pizza = http://www.pizza-ontology.com/pizza.owl#Pizza
```

**Wrong tool name** (`setLayout`, `hierarchical`, etc.):
```
Tool is runLayout. Valid algorithms: dagre-tb | elk-layered | dagre-lr
`{"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"dagre-tb"}}}`
```
