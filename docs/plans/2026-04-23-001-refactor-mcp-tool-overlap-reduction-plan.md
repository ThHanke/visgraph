---
title: "refactor: Reduce MCP tool overlap — merge search into getNodes, sharpen descriptions"
type: refactor
status: active
date: 2026-04-23
---

# refactor: Reduce MCP tool overlap — merge search into getNodes, sharpen descriptions

## Overview

Three lookup tools (`searchEntities`, `autocomplete`, `getNodes`) do semantically overlapping work — models can't reliably pick between them. We remove `searchEntities` and `autocomplete`, promote `getNodes` as the single discovery tool (adding optional auto-focus when a match is on canvas), and sharpen descriptions on the remaining overlapping pairs so each tool's decision rule is unambiguous.

## Problem Frame

Models picking the wrong tool waste tokens and produce wrong results. The root overlaps are:

- `searchEntities` vs `autocomplete` vs `getNodes` — all do substring-lookup → {iri, label}
- `getNeighbors` vs `findPath` — both BFS-traverse; purpose distinction is blurry from names alone
- `runReasoning` vs `queryGraph CONSTRUCT` — both derive new triples; when to use which is unclear
- `expandNode` vs `expandAll` — models loop single-node call instead of using batch
- `focusNode` vs `fitCanvas` — viewport ops with overlapping mental model
- `loadRdf` vs `loadOntology` — both load from URL; canvas-node side-effect not obvious

## Requirements Trace

- R1. Remove `searchEntities` and `autocomplete` — no new tool fills their slot; `getNodes` absorbs their function
- R2. `getNodes` gains optional auto-focus: when `focusFirst: true` (default false), pan viewport to first canvas match
- R2b. `getNodes` gains internal fuzzy fallback: when `labelContains` returns no results, internally run the prefix-lookup logic (previously in `autocomplete`) and return the first match, annotating the response with `fuzzyFallback: true` so the model knows the result is approximate
- R3. All remaining overlapping tool descriptions updated so each carries an explicit "use this when / not that" decision rule
- R4. `help` tool manifest updated to reflect removals
- R5. README updated to reflect tool surface change

## Scope Boundaries

- No changes to RDF store logic, canvas rendering, or layout
- No new tools added
- Description rewrites are prose-only — parameter names/types unchanged except `getNodes` gaining one boolean param

## Context & Research

### Relevant Code and Patterns

- `src/mcp/tools/search.ts` — `searchEntities` and `autocomplete` implementations; `searchEntities` calls `focusElementOnCanvas()` after lookup
- `src/mcp/tools/nodes.ts` — `getNodes` calls `dataProvider.lookupAll()`, no canvas focus currently
- `src/mcp/manifest.ts` — all tool description strings registered with the MCP server; edit here for model-facing text
- `src/mcp/visgraphMcpServer.ts` — tool registration; remove `searchEntities`/`autocomplete` entries here

### Institutional Learnings

- When adding/changing tools, audit all tools for duplicate code (see memory: feedback_mcp_tool_redundancy.md)
- `focusElementOnCanvas()` already exists in `search.ts` — import into `nodes.ts` for reuse

## Key Technical Decisions

- **Remove, not merge**: `autocomplete` and `searchEntities` are deleted entirely. `getNodes` already covers the lookup; folding two tool names into one reduces the decision space.
- **`focusFirst` default false**: Auto-focus is opt-in so `getNodes` used for inventory listing doesn't surprise with viewport jumps.
- **Description rewrites target the decision rule, not the implementation**: Each description gets a "Use this when X, not when Y" sentence.

## Open Questions

### Resolved During Planning

- Keep `getNodeDetails` separate from `getNodes`? Yes — `getNodes` returns summary (iri, label, types); `getNodeDetails` returns all asserted triples. Distinction is load-on-demand vs full dump.
- Should `focusFirst` auto-focus the first result or only when exactly one result? First canvas match, consistent with old `searchEntities` behaviour.

### Deferred to Implementation

- Whether `focusElementOnCanvas` needs to be moved to a shared util or can be imported from `search.ts` before that file is deleted — resolve at implementation time.

## Implementation Units

- [ ] **Unit 1: Remove `searchEntities` and `autocomplete`**

**Goal:** Delete the two tools from code and registration so models no longer see them.

**Requirements:** R1

**Dependencies:** None (do this first so Unit 2 has a clean baseline)

**Files:**
- Delete: `src/mcp/tools/search.ts`
- Modify: `src/mcp/visgraphMcpServer.ts` — remove registration of `searchEntities`, `autocomplete`
- Modify: `src/mcp/manifest.ts` — remove both tool schema entries

**Approach:**
- Verify nothing else imports from `search.ts` before deleting
- Remove the two tool handler registrations in `visgraphMcpServer.ts`
- Remove schema blocks in `manifest.ts`

**Test scenarios:**
- Integration: calling `searchEntities` or `autocomplete` via MCP returns "unknown tool" error
- Smoke: remaining tools still register and respond correctly

**Verification:** `visgraphMcpServer.ts` imports no symbol from `search.ts`; tool list no longer includes the two names.

---

- [ ] **Unit 2: Enhance `getNodes` with `focusFirst` param**

**Goal:** Give `getNodes` the viewport-focus side-effect from `searchEntities` and the fuzzy fallback from `autocomplete`, so models have one discovery tool that handles the full lookup lifecycle.

**Requirements:** R1, R2, R2b

**Dependencies:** Unit 1

**Files:**
- Modify: `src/mcp/tools/nodes.ts` — add `focusFirst` boolean param; add fuzzy fallback branch; call `focusElementOnCanvas()` on first canvas match when `focusFirst` is true
- Modify: `src/mcp/manifest.ts` — add `focusFirst` to `getNodes` schema; update description

**Approach:**
- Add optional `focusFirst: boolean` (default `false`) to `getNodes` input schema
- Lookup flow when `labelContains` is provided:
  1. Run existing `lookupAll()` + label-substring filter
  2. If zero results, re-run lookup using the prefix-lookup path (same as old `autocomplete` — `dataProvider.lookup({ text, limit: 1 })`) and return first hit
  3. Annotate response with `fuzzyFallback: true` when step 2 was used, so the model knows the match is approximate
- After filtering/fallback, if `focusFirst` is true and any result is on the canvas, call focus helper on the first such canvas result
- Port `focusElementOnCanvas` logic (was in `search.ts`) — move to `iriUtils.ts` or inline before `search.ts` is deleted
- Fix the existing description bug: implementation returns all graph entities (TBox + ABox), not just canvas nodes

**Patterns to follow:**
- `focusElementOnCanvas()` pattern from the deleted `search.ts`
- `dataProvider.lookup()` call pattern from the deleted `autocomplete`
- Existing `getNodes` filter/map pattern in `nodes.ts`

**Test scenarios:**
- Happy path: `getNodes({ labelContains: "Person" })` returns matching entities, `fuzzyFallback` absent
- Happy path: `getNodes({ labelContains: "Person", focusFirst: true })` with a canvas match pans viewport to it
- Happy path: `getNodes({ labelContains: "Persn" })` (typo, no exact match) → falls back to prefix lookup, returns closest match, `fuzzyFallback: true`
- Edge case: `focusFirst: true` but no canvas match — no error, returns results without focusing
- Edge case: `labelContains` provided but no results even from fuzzy — returns empty list, `fuzzyFallback: true`
- Edge case: no `labelContains` provided — no fuzzy fallback runs (nothing to approximate)

**Verification:** `getNodes` with `focusFirst: true` triggers viewport pan on canvas match; failed exact match triggers fuzzy fallback with `fuzzyFallback: true` in response.

---

- [ ] **Unit 3: Rewrite descriptions for remaining overlapping pairs**

**Goal:** Each overlapping tool pair gets an explicit decision rule in its manifest description so models don't have to guess.

**Requirements:** R3

**Dependencies:** Unit 1 (searchEntities/autocomplete gone, no need to contrast against them)

**Files:**
- Modify: `src/mcp/manifest.ts` — rewrite descriptions for the tools below

**Approach — per tool pair:**

| Tool | New description focus |
|------|----------------------|
| `getNodes` | "Discover or filter all known entities. Use `labelContains` to find by name (falls back to fuzzy match if exact string finds nothing — response includes `fuzzyFallback: true` when this happens), `typeIri` to filter by class, `focusFirst: true` to also pan the viewport to the first match. Use this before `addNode`/`addLink` to resolve IRIs." |
| `getNodeDetails` | "Fetch every asserted triple for one entity. Use when you need property values, not just the IRI — call `getNodes` first to find the IRI." |
| `getNeighbors` | "Explore the graph around one node — returns all reachable nodes and edges up to `depth` hops. Use when you don't know what's connected. For a direct connection between two known nodes, use `findPath` instead." |
| `findPath` | "Find the shortest route between two specific nodes. Use when you know both endpoints and want the connecting hop sequence. For open-ended neighbourhood exploration, use `getNeighbors` instead." |
| `runReasoning` | "Apply OWL-RL inference to derive implicit types and relationships from the loaded ontology. Use after loading an ontology to materialise inferred triples. For explicit one-off derived triples, use `queryGraph` with CONSTRUCT instead." |
| `queryGraph` | "Run SPARQL SELECT or CONSTRUCT against asserted data. CONSTRUCT adds new asserted triples to the store. Use SELECT to read; use CONSTRUCT for explicit derivations. For full OWL-RL inference, use `runReasoning` instead." |
| `expandNode` | "Expand one canvas node to show its annotation property card. Use when you need to reveal properties on a specific node. To expand every node at once, use `expandAll` — do not loop this tool." |
| `expandAll` | "Expand every canvas node in one call. Use instead of looping `expandNode` when you want all property cards visible." |
| `focusNode` | "Pan and zoom to one specific node. Use when you know which node to highlight. To fit all nodes into view, use `fitCanvas` instead." |
| `fitCanvas` | "Zoom out to fit all nodes in the viewport. Use before `exportImage` or for a full overview. To centre on one node, use `focusNode` instead." |
| `loadRdf` | "Load ABox instance data — subjects appear as canvas nodes. Use for individual/data triples. To load a schema or ontology without adding canvas nodes, use `loadOntology` instead." |
| `loadOntology` | "Load TBox ontology for type hints and reasoning support. Does NOT add canvas nodes. Use for schema/class definitions. To load instance data as canvas nodes, use `loadRdf` instead." |

**Test scenarios:**
- Test expectation: none — pure prose change, no behaviour change. Verified by reading the manifest and confirming each description contains an explicit cross-reference to its contrast tool.

**Verification:** Each description in `manifest.ts` for the listed tools contains a "use X instead" or "not when Y" phrase pointing to its counterpart.

---

- [ ] **Unit 4: Update `help` tool response and README**

**Goal:** Remove references to deleted tools so `help` output and docs stay accurate.

**Requirements:** R4, R5

**Dependencies:** Unit 1

**Files:**
- Modify: `src/mcp/manifest.ts` or wherever `help` tool builds its tool list — confirm `searchEntities`/`autocomplete` are not listed
- Modify: `README.md` — update MCP tools section to reflect removals and `getNodes` enhancement

**Approach:**
- If `help` dynamically reflects registered tools, no change needed beyond Unit 1
- If `help` has a hardcoded list, remove the two entries
- README: remove `searchEntities`/`autocomplete` rows; add `focusFirst` to `getNodes` row; update descriptions column for all tools updated in Unit 3

**Test scenarios:**
- Happy path: `help {}` response does not mention `searchEntities` or `autocomplete`
- Happy path: `help { tool: "getNodes" }` returns schema including `focusFirst` param

**Verification:** `README.md` Table of Contents and MCP tool table match the live tool surface after Units 1–3.

## System-Wide Impact

- **Tool surface reduced by 2**: models will see 36 tools instead of 38
- **No breaking change to callers that used `getNodes`** — new param is optional with safe default
- **Breaking change for any caller using `searchEntities` or `autocomplete`** — intentional; these are AI-facing tools, no human SDK callers expected
- **`search.ts` file deleted** — nothing else should import from it; verify before deleting

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Something imports `focusElementOnCanvas` from `search.ts` | Check imports before deleting; move helper to `iriUtils.ts` if needed |
| `help` tool has hardcoded tool list | Read `help` implementation before finalising Unit 4 scope |
| Description rewrites too long for model context window | Keep each description under 2 sentences; decision rule is one clause, not a paragraph |

## Sources & References

- Related code: `src/mcp/tools/search.ts`, `src/mcp/tools/nodes.ts`, `src/mcp/manifest.ts`, `src/mcp/visgraphMcpServer.ts`
