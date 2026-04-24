---
title: "What AI agents need to build correct knowledge graphs in visgraph"
date: 2026-04-24
status: ranked
focus: "AI agent capability for TBox authoring and ABox data entry in visgraph"
---

# AI Agent Knowledge Graph Authoring — Ideation

**Date:** 2026-04-24  
**Focus:** What information, workflows, and tool capabilities does an AI agent need to build concise, correct knowledge graphs in visgraph without repeated lookups?  
**Use cases:** (1) TBox ontology authoring (classes, properties, restrictions), (2) ABox data entry (individuals typed to ontology classes, linked via properties)

---

## Grounding Summary

**Codebase:** visgraph — browser-based RDF/OWL editor, 23 MCP tools, Reactodia canvas, N3 triple store  
**Workflow today:** loadOntology → getNodes (IRI lookup) → addNode×N → addLink×N → runLayout → runReasoning → focusNode → screenshot — full manual chaining, every step a separate call  
**Key pain points observed in PMDCO try-out cycle:**
- `owl:imports` not followed → BFO/RO missing → domain/range absent → link suggestions empty
- IRI opacity: agents must query labels to find IRIs, then use IRIs to write triples
- `expandAll` after `loadOntology` flooded canvas with 1288 nodes
- `layoutNodes` returned before positions stabilised (`animate:true` was async)
- `runReasoning` returns only a count — no diff, no breakdown
- SPARQL requires full PREFIX declarations per query — no built-in prefixes
- `exportImage` always exports full canvas, not viewport
- ABox authoring = 2 calls per node (addNode + addLink) × N nodes — multiplied latency
- No way to validate a triple before committing it
- Canvas state wipes on every HMR reload during dev
- Tools are stateless between calls — no session memory

**External context:** Schema-driven MCP achieving 98% accuracy on domain QA; Graphiti temporal KG tracks fact provenance; InfraNodus lets agents reason in natural language; MCP becoming standard AI-data connector layer

---

## Ranked Survivors

### Tier 1 — Highest Impact, Low Complexity

---

**1. `loadOntology` Response Manifest**  
*Frame: Pain removal*

`loadOntology` currently returns only `{ success: true }`. Extend to return a manifest: loaded namespace prefixes, class count, property count, detected `owl:imports` that were NOT auto-followed (with load URLs). Agent gets actionable information — knows to call `loadOntology` again for each import — without any prior knowledge of OWL semantics.

> Rejected alternatives: Auto-follow `owl:imports` (scope too large; circular imports risk; network policy). The manifest approach gives agents the same power with zero framework risk.

---

**2. `getNodes` Mode Filter (TBox / ABox / All)**  
*Frame: Pain removal + leverage*

`getNodes` today returns canvas elements mixed across TBox classes, properties, and ABox individuals. Add a `mode` param: `tbox | abox | all`. `abox` returns only individuals (subjects with a non-OWL type). `tbox` returns only classes and properties. Eliminates the agent's need to post-filter by type prefix.

---

**3. Auto-PREFIX SPARQL Injection**  
*Frame: Pain removal*

`queryGraph` already accepts SPARQL. Add `autoPrefixes: true` (default true) that prepends PREFIX declarations from the loaded namespace map before execution. Agents write bare SPARQL. The namespace map is already maintained in `listNamespaces` — zero new state required.

---

**4. `expandAll` Safety Guard**  
*Frame: Constraint-flip*

`expandAll` after `loadOntology` on a large TBox floods canvas with thousands of nodes. Add a `maxNodes` guard (default: 50) — if canvas exceeds limit, return an error listing the count and suggest `expandNode` per IRI instead. Also add a canvas-population warning to `loadOntology`: "TBox has N classes — call `expandAll` only on small canvases."

---

**5. Synchronous `layoutNodes` — Confirmed Stable**  
*Frame: Reliability*

`layoutNodes` already uses `animate: false` + spinner polling, but the polling depends on a global (`__VG_LAST_CANVAS_LOADING`) that may not always be set. Add a deterministic post-layout wait: `renderingState.syncUpdate()` is already called, but add a settled check that verifies all positioned elements have non-zero sizes before returning. Return `{ placed, boundingBox, layoutStable: true }` so agents know the bbox is reliable.

---

### Tier 2 — High Impact, Medium Complexity

---

**6. `getOntologyProfile` / TBox Slice Tool**  
*Frame: Leverage + compounding*

One tool call that returns: loaded namespaces, classes (IRI + label), object properties with domain/range (IRI + label), datatype properties — all from the TBox graph. Replaces the current workflow of `getNodes(typeIri: owl:Class)` + `getNodes(typeIri: owl:ObjectProperty)` + SPARQL domain/range queries. Agent loads an ontology and immediately has its complete vocabulary.

---

**7. Agent Context Header on Every Tool Response**  
*Frame: Compounding*

Append a small JSON block to every tool response: `{ canvasNodeCount, loadedPrefixes, reasoningState, lastLayout }`. Agent never needs `getGraphState()` as a separate call — context arrives passively. Eliminates a class of "what state am I in?" preflight calls.

---

**8. `addIndividual` — Typed Authoring Scaffold**  
*Frame: Assumption-breaking (agent authors triples)*

High-level write primitive: `addIndividual({ typeLabel, label, properties: [{ predicateLabel, value }] })`. Internally: generates a well-formed IRI (`mint`), asserts `rdf:type`, resolves property labels to IRIs via TBox, adds to canvas. Collapses 4-6 tool calls into 1. Pairs with `getOntologyProfile` to make the vocabulary available upfront.

---

**9. `mintIri` Tool**  
*Frame: Pain removal*

Agents currently invent IRI strings ad hoc — often malformed, often namespace-inconsistent. `mintIri({ namespace, localName?, label? })` generates a well-formed IRI in the specified namespace, optionally minting a UUID-based local name. Returns the IRI and registers it in the namespace map. Removes the "what IRI do I use?" decision entirely.

---

**10. Schema-Aware Error Messages**  
*Frame: Cross-domain (compiler diagnostics)*

When `addLink` fails (wrong predicate, missing domain/range), return: `{ success: false, error: "...", suggestion: { validPredicates: [{iri, label, domain, range}] } }`. The error is actionable — agent picks from the suggestion list. Mirrors how TypeScript shows valid overloads on a type error.

---

**11. `getSessionContext` Tool**  
*Frame: Compounding*

Returns structured session state: loaded ontologies (namespace → IRI count), canvas nodes (IRI + label + type), pending reasoning (stale/fresh), recent errors. First call by any agent bootstraps full situational awareness. Pairs with agent context header (idea 7) — the header is passive delivery, this is on-demand.

---

**12. Canvas-Independent Read Path**  
*Frame: Assumption-breaking (canvas is primary state)*

`getNodes`, `getNodeDetails`, `getLinks`, `findPath` all require nodes to be on canvas. Decouple: add `storeQuery: true` param that queries the RDF store directly. Agents inspect individuals without `addNode`-ing them first, eliminating exploratory canvas pollution.

---

**13. Reasoning Diff**  
*Frame: Pain removal + cross-domain (version control)*

Extend `runReasoning` to return `{ addedTriples: N, removedTriples: N, diff: [{ subject, predicate, object, direction }] }`. Agent verifies expected inferences ("did my individual get typed as the right subclass?") without a follow-up SPARQL query. A `maxDiffLines` param prevents giant diffs on large TBox loads.

---

**14. `getWorkflowGuide` Tool — Machine-Readable AGENT.md**  
*Frame: Leverage*

`getWorkflowGuide(topic?: 'pmdco' | 'abox' | 'sparql' | 'layout')` returns the relevant AGENT.md section as structured JSON: recommended workflow steps, known gotchas, IRI patterns. Agent's first call in any session retrieves the guide; subsequent calls amortize it. AGENT.md is the richest institutional document in the repo but currently invisible to agents without filesystem access.

---

### Tier 3 — Valuable but Higher Effort

---

**15. `owl:imports` Auto-Follow in `loadOntology`**  
*Frame: Assumption-breaking*

Parse `owl:imports` triples after loading and queue follow-up loads automatically. Returns manifest of imports found and which succeeded/failed. Eliminates the entire "must load BFO and RO separately" class of errors. Risk: circular imports, large transitive closures — needs a depth limit and a visited-URL guard.

---

**16. Session Snapshot / Restore**  
*Frame: Constraint-flip (stateless tools)*

`saveSession(name)` serialises canvas state (nodes, positions, clusters) + RDF store to a named slot. `restoreSession(name)` reloads it. Survives HMR reloads. Agents working on long multi-step authoring sessions can checkpoint at each stable state without re-running the full sequence.

---

**17. Continuous SHACL Validation**  
*Frame: Assumption-breaking (validation is on-demand)*

After each write batch, automatically run loaded SHACL shapes against the affected individuals and append a `validationWarnings` array to the tool response. Agents discover constraint violations immediately, not on a separate `validateGraph` call.

---

**18. Label-Native API Layer**  
*Frame: Assumption-breaking (IRI is primary identity)*

`addNodeByLabel`, `addLinkByLabel`, `getNodeByLabel` resolve human-readable names to IRIs via the loaded TBox. IRI surface stays for power use; label surface is the default. The 90% ABox-against-known-ontology case becomes nearly error-free.

---

**19. Dry-Run Mode**  
*Frame: Cross-domain (database transactions)*

`dryRun: true` param on write tools: validates the operation (IRI exists, domain/range compatible, SHACL passes) and returns what would happen — without committing. Agent verifies intent before any state change. Pairs with schema-aware errors (idea 10).

---

**20. Viewport-Only `exportImage`**  
*Frame: Pain removal*

`exportImage` always exports full canvas, producing 2+ MB SVGs on large graphs. Add `scope: 'viewport' | 'canvas' | 'selection'`. `viewport` exports only the visible area (already known from `zoomToFitRect`). Resolves the PMDCO session problem directly.

---

**21. Batch Transaction Tool**  
*Frame: Constraint-flip*

`commitGraph(operations[])` — array of `{type: 'addNode'|'addLink'|..., params}` — executes atomically with a single reasoning pass and single SHACL validation at end. Agents compose the full graph intent and submit once. Eliminates N-call latency for ABox entry.

---

**22. Git-Style Staging Area**  
*Frame: Cross-domain (version control)*

Three-area model: RDF store (committed) → staging area (validated but not reasoned) → workspace (in-progress). `stage(operations[])`, `commit()`, `rollback()`. Agents stage tentative triples, inspect the staged state, then commit. Eliminates the "I committed a wrong triple — now what?" problem.

---

## Cross-Cutting Combinations

| Combo | Ideas | Synergy |
|-------|-------|---------|
| C1 — Zero-boilerplate ABox authoring | 2 + 8 + 9 + 10 | Mode filter surfaces vocabulary; `addIndividual` uses it; `mintIri` generates clean IRIs; schema errors close the loop |
| C2 — Informed session start | 1 + 6 + 14 | Manifest on load → TBox profile → workflow guide = agent knows exactly what it loaded and how to use it |
| C3 — Reactive validation | 17 + 13 + 10 | Continuous SHACL + reasoning diff + schema-aware errors = every write immediately surfaces consequences |
| C4 — Stateless-agent-friendly | 7 + 11 + 16 | Context header + session context + snapshot = agent never loses situational awareness across calls |

---

## Next Step

Pick one idea to define precisely with `ce-brainstorm` before planning.

**Highest-impact immediate candidates** (directly motivated by PMDCO session pain):
1. `loadOntology` response manifest (#1)
2. `getOntologyProfile` / TBox slice (#6)
3. Agent context header on every response (#7)
4. `getNodes` mode filter (#2)
5. `addIndividual` typed scaffold (#8)
