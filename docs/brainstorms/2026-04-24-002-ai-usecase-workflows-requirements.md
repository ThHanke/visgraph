---
date: 2026-04-24
topic: ai-usecase-workflows-and-showcases
---

# AI Agent Workflows: TBox Authoring and ABox Data Entry

## Problem Frame

Visgraph exposes 31 MCP tools, but there is no documented end-to-end AI workflow for its two
primary use cases: **(1) TBox ontology authoring** (classes, properties, axioms from scratch)
and **(2) ABox data entry** (individuals typed to a loaded ontology, linked via its properties).

Without these workflows documented and proven, an AI agent must solve the same discovery
problems every session: which tools to call in what order, which ontologies to pre-load,
which parameters are correct, and which tool combinations produce clean results.

The existing reasoning demo (`docs/mcp-demo/reasoning-demo.md`) proves the TBox authoring
path is functional. No comparable showcase exists for ABox authoring. Several tool-level gaps
cause avoidable friction in both paths that a showcase would expose and motivate fixing.

---

## Workflow Analysis

### Use Case 1: TBox Ontology Authoring

**Canonical tool sequence (agent perspective):**

```
addNamespace(prefix, iri)               # register namespace once per session
addNode(iri, typeIri: owl:Class, label) # one call per class
addNode(iri, typeIri: owl:ObjectProperty, label) # one call per property
addLink(subject, predicate, object)     # rdfs:subClassOf / rdfs:domain / rdfs:range
                                        # owl:inverseOf / owl:SymmetricProperty / etc.
runLayout(algorithm)
runReasoning                            # verify inferences
getNodeDetails(iri)                     # inspect inferred types
exportGraph(format: turtle)
exportImage(format: svg)
```

**Status: tools ready.** The reasoning demo proves the full sequence works for a social-graph
ontology. No new tools are required for a basic TBox.

**Known limits:**
- OWL Restrictions (`owl:someValuesFrom`, `owl:allValuesFrom`, cardinality) require blank
  nodes that `addLink` cannot express — no workaround exists today
- `runReasoning` returns a triple count only, not a diff — agent cannot verify *which*
  axioms fired without a follow-up SPARQL query
- No inconsistency detection — the reasoner silently accepts unsatisfiable class definitions

---

### Use Case 2: ABox Data Entry against a Loaded Ontology

**Canonical tool sequence (observed in PMDCO try-out):**

```
loadOntology(ontology-url)          # returns {success:true} — no manifest
loadOntology(ro.owl)                # agent must KNOW to do this (owl:imports not followed)
loadOntology(bfo.owl)               # same — not discoverable from the tool surface
getNodes(labelContains: 'ClassName')# find type IRI — mixes TBox classes and ABox individuals
getNodes(labelContains: 'propName') # find predicate IRI — second query
addNode(iri, typeIri, label)        # × N — one call per individual
addLink(subjectIri, predicateIri, objectIri) # × N — one call per edge
layoutNodes(iris, algorithm)        # compact subgraph layout — works now
# runReasoning NOT safe on axiom-loop ontologies (e.g. PMDCO)
exportImage(format: svg)            # exports FULL canvas, not viewport — oversized SVG
```

**Status: tools get you there, but with avoidable pain.** Three structural gaps block a
clean showcase:

| Gap | Impact |
|-----|--------|
| `loadOntology` returns no manifest | Agent cannot discover unresolved `owl:imports`; must know the import chain from prior knowledge |
| `getNodes` mixes TBox and ABox | Finding type/property IRIs requires manual inspection; no mode filter |
| `exportImage` always exports full canvas | On a loaded TBox, the export is a large, useless SVG instead of a focused viewport image |

Additional friction:
- `runReasoning` can hang on axiom-loop ontologies — agent has no way to detect this upfront
- 11+ tool calls to author 6 nodes with 5 edges — high per-session latency

---

## Requirements

> **Delivery order:** Tool Enhancements (R8–R11) ship first. Showcase B (R5–R7) is written
> after R8–R11 land so it demonstrates the clean workflow, not the workarounds.
> Showcase A (R1–R4) can be written immediately — it requires no tool changes.

**Showcase A — TBox Authoring**

*Can be written now against current tools.*

- R1. Write a new showcase script `docs/mcp-demo/tbox-materials-demo.md` that authors a small
  Materials ontology: Material, Metal, Steel (subclass chain), plus `hasComponent` and
  `hasQuality` object properties with domain/range. The script must follow the relay session
  log format (TOOL blocks + [Result] blocks).
- R2. The showcase must run end-to-end using only current tools — no tool changes required.
- R3. The showcase must include: namespace registration, class authoring, property authoring,
  subclass + domain/range axioms, `runReasoning`, `getNodeDetails` to verify inference,
  `exportGraph(turtle)`, and `exportImage(svg)`.
- R4. The Showcase A script must document the OWL Restriction limitation as a known boundary:
  add a section noting what the tools *cannot* express (blank-node restrictions, cardinality).
  These are fundamental limits of the `addLink`-based surface, not tool gaps to fix.

**Tool Enhancements (prerequisite for Showcase B)**

*These must ship before Showcase B is written.*

- R8. `loadOntology` must return a manifest: loaded namespace prefixes, class/property counts,
  and a list of `owl:imports` IRIs that were found but NOT auto-loaded. This lets the agent
  discover that BFO and RO must be loaded explicitly without prior knowledge.
- R9. `getNodes` must accept a `mode` parameter: `tbox` (classes and properties only), `abox`
  (individuals only — subjects with a non-OWL/RDFS type), `all` (current default). This
  eliminates the need to manually filter TBox results when searching for types or predicates.
- R10. `exportImage` must accept a `scope` parameter: `canvas` (current behaviour) or
  `viewport` (export only the currently visible area). `viewport` is the new default — `canvas`
  must be passed explicitly to export the full diagram. An agent calling `exportImage()` after
  `layoutNodes` will get a focused viewport SVG without specifying any scope parameter.
- R11. `runReasoning` must include a configurable timeout (default: 30 s) and return a
  structured result on timeout: `{ success: false, error: 'timeout', triplesBeforeAbort: N }`.
  This prevents silent hangs on axiom-loop ontologies like PMDCO. The planner must verify
  during implementation that the OWL-RL reasoner supports external interruption (or implement
  a `Promise.race` wrapper if it does not).

**Showcase B — ABox Data Entry (steel rod instance)**

*Written after R8–R11 land, demonstrating the clean post-fix workflow.*

- R5. Write a showcase script `docs/mcp-demo/abox-pmdco-demo.md` using the relay session
  log format. The scenario: load PMDCO (manifest reveals BFO + RO imports), load BFO + RO,
  use `getNodes(mode: 'tbox')` to find type and property IRIs, create a SteelRod individual
  with its composition (SteelAlloy, FePortion, CPortion) and qualities (FeMassFraction,
  CMassFraction), link using `has-part` (BFO_0000051) and `has-quality` (RO_0000086), lay
  out the 6-node subgraph with `layoutNodes`, and export a focused viewport image via
  `exportImage()` (default `viewport` scope).
- R6. The showcase must be fully executable end-to-end with no workaround commentary —
  R8–R11 having eliminated the gaps. It demonstrates the target AI workflow, not the
  current painful one.
- R7. The Showcase B script must end with a "What the tools still cannot do" section noting
  the remaining known limits (e.g., no reasoning on axiom-loop ontologies, no OWL Restrictions).

---

## Success Criteria

- An AI agent following Showcase A end-to-end produces a valid Materials ontology Turtle file
  with correct subclass and domain/range axioms, verifiable by `runReasoning` inference.
- An AI agent following Showcase B end-to-end produces a focused SVG showing only the 6-node
  ABox subgraph (not the full PMDCO TBox) after a single `layoutNodes` + `exportImage` call.
- R8–R11 are verified: `loadOntology` manifest present, `getNodes` mode filter working,
  `exportImage` viewport scope working, `runReasoning` timeout working.
- A new AI agent starting a session can follow Showcase B from scratch in one relay session
  with no prior knowledge of PMDCO, BFO, or RO — the manifest (R8) and mode filter (R9)
  provide all required discoverability.

---

## Scope Boundaries

- **Not in scope:** OWL Restriction authoring (blank nodes) — separate issue; no tool change
  proposed here.
- **Not in scope:** `owl:imports` auto-follow in `loadOntology` — deferred; risk of circular
  imports and large transitive closures. The manifest (R8) is the safer alternative.
- **Not in scope:** `addIndividual` high-level scaffolding tool — in ideation, deferred.
- **Not in scope:** Batch transaction tool — in ideation, deferred.
- **Not in scope:** SPARQL auto-PREFIX injection — in ideation, deferred.
- Showcase scripts are narrative relay logs, not automated tests. They are documentation, not
  executable specs. Separate E2E tests may be added later.

---

## Key Decisions

- **Showcase B ships after R8–R11, not before:** Writing the showcase before tool gaps are
  fixed would produce a workaround-heavy script that would need rewriting anyway. Instead, the
  PMDCO try-out cycle (already run) documented the pain; Showcase B demonstrates the target
  clean workflow after fixes land.
- **R8 manifest over `owl:imports` auto-follow:** Manifest is additive (zero risk of loops
  or network cascade), whereas auto-follow requires depth limits and cycle detection.
- **`viewport` as new default for exportImage scope:** On a loaded TBox, no user or agent
  would want a 2+ MB SVG. The focused viewport is almost always the intended export.
- **`runReasoning` timeout, not a skip flag:** Timeout is less footgun-prone than an
  explicit `skipReasoning` flag; agents that encounter a timeout can simply omit the step.

---

## Dependencies / Assumptions

- Showcase B depends on PMDCO, RO, and BFO being accessible at their published URLs.
  If those URLs change, the script needs updating.
- R11 (reasoning timeout) assumes the reasoning loop runs in a way that can be interrupted
  — verify during planning that the N3 reasoner in use supports timeout/abort.

---

## Outstanding Questions

### Resolve Before Planning

_(none — requirements are clear enough to plan)_

### Deferred to Planning

- [Affects R10][Technical] How does `exportImage` currently determine the SVG viewport?
  Verify whether `canvas.zoomToFitRect` state is readable or whether a separate
  viewport-bounds call exists on the Reactodia canvas API.
- [Affects R11][Needs research] Does the current OWL-RL reasoner (N3.js or similar) support
  external interruption, or must a timeout wrap the entire async call with a `Promise.race`?
- [Affects R8][Technical] `owl:imports` IRIs may appear in the TBox graph after load — verify
  by SPARQL query during planning: `SELECT ?i WHERE { ?s owl:imports ?i }`.

---

## Next Steps

1. **Now:** Write Showcase A (`docs/mcp-demo/tbox-materials-demo.md`) — no tool changes needed.
2. **Next:** `/ce-plan` for R8–R11 tool enhancements.
3. **After R8–R11 land:** Write Showcase B (`docs/mcp-demo/abox-pmdco-demo.md`).
