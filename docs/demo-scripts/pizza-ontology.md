# Demo Script: Pizza Ontology — Socratic AI Teaching Session

A guided recording session where qwen3:4b builds a pizza ontology step-by-step,
driven by Socratic questions from the relay operator (you). The model never receives
direct instructions — only questions that lead it to discover the right tool calls.

---

## Setup (do once before recording)

```bash
# 1. Start aggregated session log
kill $(cat /tmp/session-log-agg.pid 2>/dev/null) 2>/dev/null; true
while true; do cat .playwright-mcp/console-*.log 2>/dev/null > .playwright-mcp/session.log; sleep 2; done &
echo $! > /tmp/session-log-agg.pid

# 2. Verify Ontosphere is up
curl -s -o /dev/null -w "%{http_code}" http://docker-dev.iwm.fraunhofer.de:8080/
```

Browser tabs needed (MCP browser):
- **Tab 0** — Ontosphere at `http://docker-dev.iwm.fraunhofer.de:8080`
- **Tab 1** — OWUI at `https://gpuserver1-sit.iwm.fraunhofer.de` (authenticated)

---

## Bootstrap the session

```
mcp__playwright__browser_run_code_unsafe filename=.playwright/pizza-demo-setup.js
```

Returns `{ ok: true, chatUrl, instrInjected, turn0 }`. Verify all truthy.

**What happened:** qwen3 received:
1. Plain-text seed → establishes `/c/` chat URL
2. Format INSTR (single-backtick JSON-RPC 2.0 only, key tool signatures, pizza IRIs)
3. Turn 0: "Can you teach me how ontologies work using pizzas as a real-world example? Start by adding the most fundamental concept to the graph."

**Expected relay call for Turn 0:**
```json
`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#Pizza","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"Pizza"}}}`
```
Toast: `✓ addNode · Pizza`

---

## Drive the session

After Turn 0 completes (toast visible, model idle):

```
mcp__playwright__browser_run_code_unsafe filename=.playwright/turn-driver.js
```

This injects T1–T6 sequentially, waiting for idle between each turn.
Watch session.log and Ontosphere canvas while it runs.

---

## Turn-by-turn guide

### Turn 0 — The root concept
**Injected by pizza-demo-setup.js**

> "Can you teach me how ontologies work using pizzas as a real-world example? Start by adding the most fundamental concept to the graph."

**Expected call:**
```
addNode(iri="ex:Pizza", typeIri="owl:Class", label="Pizza")
```

**If wrong format** — inject corrective nudge:
```
Single backtick JSON-RPC 2.0 only. Example:
`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#Pizza","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"Pizza"}}}`
```

---

### Turn 1 — PizzaBase + PizzaTopping (hierarchy)

> "Great start! A pizza is made of two main building blocks — its base and its toppings. Could you model those as more specific types of Pizza in the ontology?"

**Expected calls (order flexible):**
```
addNode(iri="ex:PizzaBase",    typeIri="owl:Class", label="PizzaBase")
addNode(iri="ex:PizzaTopping", typeIri="owl:Class", label="PizzaTopping")
addLink(subjectIri="ex:PizzaBase",    predicateIri="rdfs:subClassOf", objectIri="ex:Pizza")
addLink(subjectIri="ex:PizzaTopping", predicateIri="rdfs:subClassOf", objectIri="ex:Pizza")
```

Toast: `✓ addNode · PizzaBase`, `✓ addNode · PizzaTopping`, `✓ addLink · subClassOf` ×2

---

### Turn 2 — DeepPan + ThinAndCrispy (deeper hierarchy)

> "Nice! PizzaBase can be either deep pan or thin and crispy. Can you add those two variants as more specific types of PizzaBase?"

**Expected calls:**
```
addNode(iri="ex:DeepPanBase",        typeIri="owl:Class", label="Deep Pan Base")
addNode(iri="ex:ThinAndCrispyBase",  typeIri="owl:Class", label="Thin And Crispy Base")
addLink(subjectIri="ex:DeepPanBase",       predicateIri="rdfs:subClassOf", objectIri="ex:PizzaBase")
addLink(subjectIri="ex:ThinAndCrispyBase", predicateIri="rdfs:subClassOf", objectIri="ex:PizzaBase")
```

---

### Turn 3 — Concrete toppings (breadth)

> "Now let's add some real toppings. Can you add Mozzarella, TomatoSauce, and Pepperoni as specific types of PizzaTopping?"

**Expected calls:**
```
addNode(iri="ex:Mozzarella",    typeIri="owl:Class", label="Mozzarella")
addNode(iri="ex:TomatoSauce",   typeIri="owl:Class", label="Tomato Sauce")
addNode(iri="ex:Pepperoni",     typeIri="owl:Class", label="Pepperoni")
addLink(subjectIri="ex:Mozzarella",  predicateIri="rdfs:subClassOf", objectIri="ex:PizzaTopping")
addLink(subjectIri="ex:TomatoSauce", predicateIri="rdfs:subClassOf", objectIri="ex:PizzaTopping")
addLink(subjectIri="ex:Pepperoni",   predicateIri="rdfs:subClassOf", objectIri="ex:PizzaTopping")
```

---

### Turn 4 — hasPart object property

> "The graph has the building blocks, but a Pizza isn't linked to its parts yet. Can you express that a Pizza has both a PizzaBase and a PizzaTopping using an addLink call?"

**Expected calls:**
```
addLink(subjectIri="ex:Pizza", predicateIri="ex:hasPart", objectIri="ex:PizzaBase")
addLink(subjectIri="ex:Pizza", predicateIri="ex:hasPart", objectIri="ex:PizzaTopping")
```

**Note:** `ex:hasPart` = `http://www.pizza-ontology.com/pizza.owl#hasPart` — qwen3 may use a different predicate. Both are fine as long as a link exists.

---

### Turn 5 — Layout

> "The graph is getting complex. Can you arrange the nodes so the hierarchy is easy to read?"

**Expected call:**
```
runLayout(algorithm="dagre-tb")
```
or `elk-layered`. Both valid.

**Wrong tool name**: if qwen3 uses `setLayout` or `layout`, those are also registered aliases in relayBridge toast labels but `runLayout` is the canonical tool. The relay will dispatch it correctly.

Toast: `✓ runLayout · dagre-tb`

---

### Turn 6 — Inspect + verify

> "Let's verify what we've built. Can you look up the details of the Pizza concept and tell me what you see?"

**Expected call:**
```
getNodeDetails(iri="ex:Pizza")
```

Toast: `✓ getNodeDetails · Pizza`

Model should describe the types and properties returned from the store.

---

## Fallback nudges

If qwen3 goes off-format at any turn, inject this before retrying the turn question:

```
`{"jsonrpc":"2.0","id":0,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://example.org/X","label":"X"}}}`

Single backtick only. No triple backticks. No prose. Try again.
```

If qwen3 uses correct format but wrong IRI scheme (e.g. `pizza:Pizza` instead of full IRI):
```
Use full IRIs. ex: prefix = http://www.pizza-ontology.com/pizza.owl# — so ex:Pizza = http://www.pizza-ontology.com/pizza.owl#Pizza
```

---

## Monitoring

Session log (live):
```bash
tail -f .playwright-mcp/session.log | grep -E '\[RelayBridge\]|\[TURN'
```

Key log lines to watch:
- `[RelayBridge] BC message received: {"type":"vg-call",...}` — call arrived
- `[RelayBridge] Tool result: addNode ...` — tool executed
- `[RelayBridge] Unknown tool: X` — wrong tool name from qwen3

---

## Complete turn sequence for copy-paste

If driving manually (not via turn-driver.js), inject these in order after each idle:

**T1:** "Great start! A pizza is made of two main building blocks — its base and its toppings. Could you model those as more specific types of Pizza in the ontology?"

**T2:** "Nice! PizzaBase can be either deep pan or thin and crispy. Can you add those two variants as more specific types of PizzaBase?"

**T3:** "Now let's add some real toppings. Can you add Mozzarella, TomatoSauce, and Pepperoni as specific types of PizzaTopping?"

**T4:** "The graph has the building blocks, but a Pizza isn't linked to its parts yet. Can you express that a Pizza has both a PizzaBase and a PizzaTopping using an addLink call?"

**T5:** "The graph is getting complex. Can you arrange the nodes so the hierarchy is easy to read?"

**T6:** "Let's verify what we've built. Can you look up the details of the Pizza concept and tell me what you see?"
