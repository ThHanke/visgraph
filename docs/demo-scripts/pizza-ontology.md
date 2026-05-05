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
5. Sends bare `help({})` call — relay executes it, model reads full manifest from result
6. Runs T0–T9 with `__vgIsStreaming` idle detection between turns
7. Shows before/after caption overlays at each turn

### Caption overlay text (per turn)

| Turn | Before caption | After caption |
|------|---------------|---------------|
| T0 | Asking qwen3: what is a pizza in OWL terms? | Root Pizza class on canvas. Next: its building blocks. |
| T1 | Guide: model sub-categories and arrange the hierarchy. | rdfs:subClassOf edges + layout applied. Next: mutual exclusion. |
| T2 | Guide: declare building blocks mutually exclusive in OWL. | owl:disjointWith asserted. Next: deepen the hierarchy. |
| T3 | Guide: add concrete varieties under each building block. | Third hierarchy level + layout. Next: object property. |
| T4 | Guide: express composition with a formal object property. | owl:ObjectProperty with domain + range. Next: expand node. |
| T5 | Guide: reveal the Pizza class details on canvas. | expandNode shows all properties. Next: ABox individuals. |
| T6 | Guide: switch to individuals view and create a real pizza. | owl:NamedIndividual in ABox view. Next: connect its parts. |
| T7 | Guide: add parts and connect via the object property. | Individual linked to toppings + base. Next: reasoning. |
| T8 | Guide: trigger OWL-RL reasoning. | Reasoner materialised inferred triples. Next: inspect results. |
| T9 | Guide: inspect what the reasoner inferred about the individual. | Pizza ontology complete — built through Socratic questioning. |

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

Questions guide toward OWL **concepts** — not specific class names. qwen3 decides the
ontology structure; we accept whatever it creates as long as the right OWL construct
appears. Expected entries list the concept to look for, not exact IRIs.

---

### Turn 0 — Root class (in pizza-demo-setup.js)
> "I want to learn OWL ontology concepts through a hands-on example. I will guide you through the pizza domain step by step — one concept at a time. Rule: for each question I ask, model exactly the concept I ask about on the canvas, then stop and wait. Do not add anything beyond what I asked. Do not arrange nodes automatically. Use the ex: prefix for all IRIs (ex: maps to http://example.org/). First question: in OWL, what is the most fundamental building block for representing a concept? Create a single Pizza class — just this one node, nothing more. Wait for my next question."

**Concept:** `addNode` with `typeIri=owl:Class` for a single `ex:Pizza` class.
"Use the ex: prefix" prevents qwen3 from anchoring on pizza.owl# training data IRIs.
"just this one node, nothing more" prevents qwen3 from pre-emptively adding the full 3-class hierarchy.

---

### Turn 1 — Hierarchy + layout
> "A pizza is made from two distinct building blocks — a base and a topping. In OWL the predicate rdfs:subClassOf places a class beneath its parent. Add exactly two sub-class edges: one from the base class up to Pizza, one from the topping class up to Pizza. No other triples. Keep using the ex: prefix. Then arrange the hierarchy. Wait for my next question."

**Concept:** `rdfs:subClassOf` edges from two new classes to Pizza, then `runLayout`.
Accept any names (Base/Topping, Crust/Ingredient, etc.).
Explicit direction ("from … up to Pizza") prevents reversed edges. "No other triples" prevents extra unsolicited nodes. "Keep using the ex: prefix" counters pizza.owl# IRI leakage.

---

### Turn 2 — owl:disjointWith
> "In OWL, classes can be declared mutually exclusive — no individual can belong to both at the same time. Should the two building blocks of a pizza be disjoint from each other? If so, express that relationship on the canvas. Wait for my next question."

**Concept:** `addTriple` with `predicateIri=owl:disjointWith` between the two sibling classes.

---

### Turn 3 — Deeper hierarchy + layout
> "Good. Each building block has concrete varieties — for example a dough might be thin-crust or thick-crust. Add two specific sub-types under each building block, then arrange the hierarchy. Wait for my next question."

**Concept:** More `rdfs:subClassOf` edges creating a third level, followed by `runLayout`.

---

### Turn 4 — owl:ObjectProperty with domain + range
> "In OWL, composition is modelled with an owl:ObjectProperty — a named relationship that is itself a first-class node in the ontology, not just an edge. Create an object property called hasPart and declare its domain as Pizza and its range as its two building blocks. Add it to the canvas now. Wait for my next question."

**Concept:** `addNode` with `typeIri=owl:ObjectProperty`, then `addTriple` for `rdfs:domain` and `rdfs:range`.
Naming `hasPart` explicitly prevents the model from deferring the property creation to T7 (observed failure mode: model answers in prose at T4 and only creates hasPart when it needs it at T7).

---

### Turn 5 — expandNode
> "Expand the Pizza class node on the canvas so I can see all its asserted properties. Wait for my next question."

**Concept:** `expandNode(iri=<Pizza IRI>)` — reveals annotation property cards on the node.

---

### Turn 6 — ABox individual
> "Everything so far is the schema — the TBox. I want to see a real pizza instance. In OWL, concrete instances are called Named Individuals. Switch to the individuals view and add one. Wait for my next question."

**Concept:** `setViewMode({mode:"abox"})` then `addNode` with `typeIri=owl:NamedIndividual`.
"Named Individuals" in the question steers qwen3 toward the correct typeIri without naming the tool.

---

### Turn 7 — Connect individual to parts
> "Give your pizza individual one individual topping and one individual base. Connect each part to the pizza individual using only the hasPart object property you defined earlier — no other properties. Wait for my next question."

**Concept:** `addNode` for part individuals + `addTriple` using the hasPart object property from T4.
"pizza individual" (not "Pizza class") prevents triples from the wrong subject. "only the hasPart object property" prevents owl:part/owl:partOf substitutions. "no other properties" prevents extra unsolicited triples.

---

### Turn 8 — OWL-RL reasoning
> "The schema and data are in place. Now apply OWL-RL reasoning to derive everything that can be inferred. Wait for my next question."

**Concept:** `runReasoning({})`.

---

### Turn 9 — Inspect inferred facts
> "What did the reasoner infer about your pizza individual? Fetch its details from the graph and report which types are now attached to it."

**Concept:** `getNodeDetails(iri=<individual IRI>)` — returns both asserted and inferred triples (inferred marked `inferred:true`).
"Fetch its details from the graph" signals a data retrieval action, not an answer from prior context.

---

## Fallback nudges

**Wrong format** (prose, triple-backtick, native tool syntax):
```
Single backtick JSON-RPC 2.0 only — ALL other formats silently ignored.
`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"help","arguments":{}}}`
Call help({}) to review the format and tool list.
```

**Wrong tool name** (`setLayout`, `hierarchical`, `addLink`, etc.):
```
Tool is runLayout (not setLayout). Use addTriple (not addLink). Call help({}) for the full tool list.
```

**subClassOf direction reversed** (child subClassOf parent missing):
```
rdfs:subClassOf points from the more specific class to the more general one.
Example: PizzaBase subClassOf Pizza — not Pizza subClassOf PizzaBase.
```
