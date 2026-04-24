---
title: "feat: AI canvas control — cluster membership in getNodes, cluster guard, layoutNodes tool"
type: feat
status: active
date: 2026-04-24
---

# AI Canvas Control Improvements

## Overview

Three targeted improvements that give an AI agent better control over a large
canvas when working with domain ontologies:

1. **`getNodes` exposes cluster membership** — AI knows upfront which nodes are
   already grouped before attempting cluster operations
2. **Cluster creation hard-rejects pre-clustered nodes** — prevents silent
   partial clusters; AI must resolve conflicts explicitly
3. **New `layoutNodes` tool** — lay out a named subset of nodes in a free area
   of the canvas, enabling a focused working view without disturbing other content

## Problem Frame

During hands-on exploration with PMDCO (a 1380-class materials ontology), the
AI agent had no way to know which canvas nodes were inside clusters, and no way
to create a compact, focused view of a small ABox subgraph (6 nodes) without
either running layout on the entire canvas or navigating fresh. This produced
unwieldy 2+ MB SVGs and made it hard to present a clean result to the user.

## Requirements Trace

- R1. `getNodes` response includes `clusterId` (IRI of the owning EntityGroup, or `null`) per node
- R2. Creating a cluster that includes any already-clustered node returns an error listing the conflicts — no partial cluster is created
- R3. `layoutNodes({ iris, algorithm })` lays out the given subset using the requested algorithm, places the result in a free area (no overlap with other canvas content), pans the viewport to the result, and returns a bounding box + suggested focus IRI
- R4. `layoutNodes` rejects non-canvas IRIs and IRIs inside clusters (agent must expand cluster first)
- R5. `mcp.json` manifest updated for all changed/new tools

## Scope Boundaries

- No changes to clustering algorithms (louvain, label-propagation, k-means)
- No changes to `expandNode` / `expandAll` behaviour
- `layoutNodes` does not create clusters — it only positions nodes
- Free-space placement is a simple right-of-all-existing-content heuristic; no bin-packing

### Deferred to Separate Tasks

- `exportImage` viewport-only fix: separate issue
- SPARQL FILTER reliability: separate investigation
- `exportGraph` ABox-only mode: separate task

## Learnings from Session 1 (PMDCO Hands-On)

These were captured during the first exploration run and directly motivated this plan.

### What worked

- `loadOntology` loaded PMDCO cleanly — 1380 classes, CHEBI atom library, BFO + RO properties all present
- `pmd:` namespace auto-registered as `https://w3id.org/pmd/co/` after `loadOntology`
- `addNode` works correctly; `addLink` works once you use the right param names (see gotchas)
- `focusNode({ iri })` pans/zooms viewport to a specific node reliably
- `browser_take_screenshot` captures the visible viewport — good for showing the user subgraphs

### Gotchas discovered

| Gotcha | Detail |
|--------|--------|
| `addLink` silent failure | Wrong params `{s,p,o}` return `success: false` with no helpful error. Correct params: `subjectIri`, `predicateIri`, `objectIri` |
| SPARQL needs explicit PREFIX | Every query must declare `PREFIX owl: <...>` etc. — no built-in prefixes |
| SPARQL `FILTER(STRSTARTS(...))` unreliable | Both SELECT and CONSTRUCT ignored the filter and returned the full store. Root cause unknown (N3.js limitation). Do not rely on IRI-prefix filters |
| `exportImage` exports full canvas | Despite the tool description implying viewport, it always renders the entire canvas. `focusNode` does not affect what gets exported. Fix tracked as separate issue |
| `exportGraph` dumps full store | Includes the loaded PMDCO ontology (~678 KB Turtle). There is no ABox-only export yet |
| `expandAll` + large ontology = flooded canvas | After `loadOntology` + 6 `addNode` calls, `expandAll` somehow resulted in 1288 nodes on canvas. Exact cause not confirmed — possible interaction with TBox index. **Never call `expandAll` after `loadOntology` until this is understood** |
| `getNodes` returns TBox + ABox mixed | It searches the full index — classes, properties, and individuals. Returns no cluster info (this plan fixes that) |
| Playwright browser is headless | User cannot see the browser session live. Use `browser_take_screenshot` to show state; screenshots render as `output_image` in tool results |

### PMDCO key IRIs (confirmed via SPARQL)

| Concept | IRI |
|---------|-----|
| portion of matter | `https://w3id.org/pmd/co/PMD_0000001` |
| BFO object | `http://purl.obolibrary.org/obo/BFO_0000030` |
| BFO quality | `http://purl.obolibrary.org/obo/BFO_0000019` |
| has part | `http://purl.obolibrary.org/obo/BFO_0000051` |
| has quality | `http://purl.obolibrary.org/obo/RO_0000086` |
| iron atom (CHEBI) | `http://purl.obolibrary.org/obo/CHEBI_18248` |
| carbon atom (CHEBI) | `http://purl.obolibrary.org/obo/CHEBI_27594` |

### Open questions from session 1

- Why did canvas show 1288 nodes after `loadOntology` + 6 `addNode` + `expandAll`? `expandAll` only iterates `model.elements` (confirmed in code), so these nodes came from somewhere else. Possibly `loadOntology` adds some canvas nodes under certain conditions.
- Is `exportImage` viewport-only a bug or a feature gap? Deferred to separate fix.

## Context & Research

### Relevant Code and Patterns

- `src/mcp/tools/nodes.ts` — `getNodes` tool (lines ~144–212); response builds `{iri, label, types}[]`
- `src/mcp/tools/layout.ts` — `runLayout` tool; calls `ctx.performLayout({ layoutFunction, animate })`; Reactodia `performLayout` accepts optional `selectedElements` param
- `src/components/Canvas/core/clusteringService.ts` — `applyCanvasClustering`; produces `ClusterResult.claimedNodes: Set<string>`; uses `model.group(members[])` to create EntityGroups
- `Reactodia.getContentFittingBox(elements, links, renderingState)` — global bbox (used in `layout.ts:27`)
- `Reactodia.boundsOf(element, renderingState)` — per-element bbox (used in `clusteringService.ts:115`)
- `canvas.zoomToFitRect({ x, y, width, height })` — pan/zoom viewport
- `element.setPosition({ x, y })` inside `canvas.animateGraph(fn)` — animated position write
- `ctx.performLayout({ layoutFunction, animate, selectedElements })` — subset layout is already supported by Reactodia; not yet exposed at MCP tool level

### Institutional Learnings

- `addLink` param mismatch (`s/p/o` vs `subjectIri/predicateIri/objectIri`) caused silent failure — new tools must document params clearly and return actionable errors

## Key Technical Decisions

- **`clusterId` field type:** Use the EntityGroup's element IRI (string) or `null`. Avoids introducing a new ID scheme; agents can pass it back to future cluster tools.
- **Cluster guard location:** Check membership at the MCP tool layer (in `clusteringService.ts` or a wrapper), not deep in the algorithm. Keeps rejection logic close to the API surface.
- **Free-space heuristic:** Compute bbox of all canvas elements *except* the subset, then place the subset at `(existingBbox.x + existingBbox.width + gap, existingBbox.y)`. Simple, predictable, easy to document.
- **`layoutNodes` uses `ctx.performLayout({ selectedElements })`:** The Reactodia API already supports subset layout; the tool is a thin wrapper that adds validation + placement translation.
- **No `layoutNodes` for nodes inside clusters:** A clustered node's position is owned by the group. Agent must call a future `expandCluster` tool first. Return clear error listing which IRIs are clustered.

## Open Questions

### Resolved During Planning

- **Does `ctx.performLayout` support `selectedElements`?** Yes — confirmed in `ReactodiaCanvas.tsx:744` and `clusteringService.ts:150`.
- **How to get all cluster memberships?** Iterate `ctx.model.elements`, filter for `EntityGroup` instances, read `group.items` to get member IRIs.

### Deferred to Implementation

- **Why did the canvas show 1288 nodes after `loadOntology` + 6 `addNode` calls?** Investigate whether `loadOntology` silently populates canvas under certain conditions. Does not block this plan.
- **Exact gap value between existing content and placed subset:** Discover at implementation time based on typical node sizes (probably 80–160px).

## Implementation Units

- [ ] **Unit 1: Expose cluster membership in `getNodes` response**

  **Goal:** Each node in the `getNodes` array gains a `clusterId: string | null` field.

  **Requirements:** R1, R5

  **Dependencies:** None

  **Files:**
  - Modify: `src/mcp/tools/nodes.ts`
  - Modify: `public/.well-known/mcp.json`
  - Test: `e2e/` (existing getNodes test or new test)

  **Approach:**
  - Before building the response array, iterate `ctx.model.elements` to build a lookup: `Map<entityIri, groupIri>` from all `EntityGroup` instances and their `items`
  - For each result entry, attach `clusterId: groupIri ?? null`
  - Update `mcp.json` description and schema to document the new field

  **Patterns to follow:** Existing response shape in `nodes.ts` `getNodes` handler

  **Test scenarios:**
  - Happy path: node not in any cluster → `clusterId: null`
  - Happy path: node inside a cluster → `clusterId` equals the group's IRI
  - Edge case: canvas has no clusters → all entries return `clusterId: null`
  - Edge case: `getNodes` with `typeIri` filter still includes `clusterId` on filtered results

  **Verification:** `getNodes` response for a canvas with one cluster returns correct `clusterId` values for members and `null` for non-members

---

- [ ] **Unit 2: Hard-reject cluster creation when any node is pre-clustered**

  **Goal:** Any attempt to create a cluster that includes a node already in another cluster returns an error — no cluster is created at all.

  **Requirements:** R2

  **Dependencies:** Unit 1 (cluster membership lookup pattern)

  **Files:**
  - Modify: `src/components/Canvas/core/clusteringService.ts` (or the MCP cluster tool if one exists — verify location)
  - Modify: `public/.well-known/mcp.json` (update tool description / error contract)
  - Test: `e2e/` or unit test

  **Approach:**
  - At the entry point for cluster creation, build the same `Map<entityIri, groupIri>` lookup from Unit 1
  - If any requested IRI is present in the map, return `{ success: false, error: 'Some nodes are already in clusters', conflicts: [{ iri, clusterId }] }`
  - Only proceed if zero conflicts

  **Patterns to follow:** Error return pattern in existing MCP tools (`return { success: false, error: '...' }`)

  **Test scenarios:**
  - Happy path: all requested nodes unclusterd → cluster created successfully
  - Error path: one node already in a cluster → full rejection, no cluster created, `conflicts` lists the offending node with its `clusterId`
  - Error path: multiple nodes in different clusters → all conflicts listed in one rejection
  - Edge case: requesting a node that is not on canvas at all → separate "not on canvas" error (existing behaviour preserved)

  **Verification:** Attempting to cluster `[nodeA (in cluster X), nodeB (free)]` returns error with `conflicts: [{iri: nodeA, clusterId: X}]` and canvas is unchanged

---

- [ ] **Unit 3: New `layoutNodes` MCP tool**

  **Goal:** Layout a named subset of canvas nodes together in a free area, pan viewport to them, return bounding box.

  **Requirements:** R3, R4, R5

  **Dependencies:** Unit 1 (cluster membership check)

  **Files:**
  - Modify: `src/mcp/tools/layout.ts`
  - Modify: `public/.well-known/mcp.json`
  - Test: `e2e/`

  **Approach:**

  *Validation (reject early):*
  - All IRIs must resolve to `EntityElement` on canvas (not `EntityGroup`, not TBox-only) → error listing non-canvas IRIs
  - None of the IRIs may be inside a cluster → error listing clustered IRIs and their `clusterId`

  *Layout execution:*
  - Collect `EntityElement` instances for the given IRIs as `selectedElements`
  - Call `ctx.performLayout({ layoutFunction, animate: true, selectedElements })`

  *Free-space placement:*
  - Compute bbox of all canvas elements NOT in the subset: `Reactodia.getContentFittingBox(otherElements, otherLinks, renderingState)`
  - Compute bbox of the newly laid-out subset: `Reactodia.getContentFittingBox(subsetElements, subsetLinks, renderingState)`
  - Translate subset so its left edge = `otherBbox.x + otherBbox.width + GAP`; align tops
  - Apply translation via `canvas.animateGraph(() => el.setPosition(...))` for each subset element

  *Viewport:*
  - Call `canvas.zoomToFitRect(subsetBbox)` to pan/zoom to the placed subset

  *Return:*
  - `{ placed: iris[], boundingBox: {x,y,width,height}, suggestedFocusIri: iris[0] }`

  **Technical design:**
  > *Directional guidance, not specification.*
  ```
  layoutNodes({ iris, algorithm }) →
    validate → performLayout(selectedElements) →
    translate to free area → zoomToFitRect → return bbox
  ```

  **Patterns to follow:**
  - Layout algorithm resolution: `src/mcp/tools/layout.ts` (alias handling, `createDagreLayout`)
  - Position write pattern: `clusteringService.ts` (`canvas.animateGraph` + `el.setPosition`)
  - Bbox computation: `layout.ts:27` (`Reactodia.getContentFittingBox`)

  **Test scenarios:**
  - Happy path: 6 unclusterd canvas nodes + `dagre-lr` → subset laid out, placed to right of other content, viewport panned, bbox returned
  - Happy path: canvas has only the subset nodes (nothing else) → placed at origin, no translation needed
  - Error path: one IRI not on canvas → rejected with list of bad IRIs, canvas unchanged
  - Error path: one IRI inside a cluster → rejected with `clusterId`, canvas unchanged
  - Edge case: `iris` list has 1 node → single-node layout, placed in free area
  - Edge case: all canvas nodes are in the subset → no "other content" bbox; place at origin

  **Verification:** After `layoutNodes({ iris: [6 steel ABox IRIs], algorithm: 'dagre-lr' })`, the 6 nodes are compactly grouped in a free region, the viewport is focused on them, and `exportImage` produces a small SVG of just that region

## System-Wide Impact

- **`getNodes` contract change:** Additive — new `clusterId` field. Existing callers unaffected.
- **Cluster creation contract change:** New rejection path. Any agent script that assumed partial success must be updated.
- **`layoutNodes` is new:** No existing callers.
- **`mcp.json` must be updated** for all three changes or MCP clients will not see the new tool or new fields.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `ctx.performLayout` with `selectedElements` moves other nodes | Verify in implementation that non-selected elements remain stationary |
| Free-space heuristic places subset off-screen on small canvases | Clamp placement to a minimum x/y of 0; test with empty canvas |
| Cluster membership iteration is O(n×m) for large canvases | Acceptable for current scale; pre-build the lookup map once per tool call |

## Documentation / Operational Notes

- Update `AGENT.md` after each exploration cycle with new learnings
- Do not write `AGENT.md` until at least one full try-out cycle completes cleanly

---

## Iterative Try-Out Cycle

This plan is not done when the code is merged. It is done when the PMDCO
exploration runs cleanly end-to-end and the learnings are captured. The cycle is:

```
implement → try out → capture learnings → identify gaps → fix → try out again
```

Repeat until: the steel rod ABox is built, laid out, viewport-focused, and a
clean screenshot or SVG is produced with no manual intervention.

---

## Continuation Prompt (use after each implementation round)

```
We just implemented MCP improvements to visgraph (getNodes returns clusterId,
cluster creation rejects pre-clustered nodes, new layoutNodes tool). The app is
at http://localhost:8080. Previous session learnings are in AGENT.md.

Run the PMDCO steel-rod hands-on cycle:

1. loadOntology('https://raw.githubusercontent.com/materialdigital/core-ontology/main/pmdco.ttl')
2. getNodes({ labelContains: 'portion of matter' }) — verify clusterId field present, confirm IRI
3. getNodes({ labelContains: 'has part' }) — confirm obo:BFO_0000051
4. getNodes({ labelContains: 'has quality' }) — confirm obo:RO_0000086
5. addNode × 6 (SteelRod, SteelAlloy, FePortion, CPortion, FeMassFraction, CMassFraction)
6. addLink × 5 using subjectIri/predicateIri/objectIri
7. layoutNodes({ iris: [all 6 IRIs], algorithm: 'dagre-lr' })
8. browser_take_screenshot — show the user
9. runReasoning — note what gets inferred
10. exportImage({ format: 'svg' }) — check size; should be small (viewport only)

After each step: note what worked, what was unexpected, what errored.
After the full cycle: update AGENT.md with new learnings.
If anything is still broken or clunky: open a new plan for the next fix round.
```

## Documentation Update (post all improvement cycles)

Only after all iterative try-out cycles complete cleanly, update `README.md` to reflect:
- `getNodes` now returns `clusterId` per node
- Cluster creation rejects pre-clustered nodes (new error contract)
- New `layoutNodes` tool: params, behaviour, return value

Check whether the Table of Contents in `README.md` needs updating after any section changes.
