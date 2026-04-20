---
title: "feat: Ontology Import Auto-Loading with URL Override"
type: feat
status: active
date: 2026-04-20
origin: docs/brainstorms/2026-04-20-ontology-import-loading-requirements.md
---

# feat: Ontology Import Auto-Loading with URL Override

## Overview

Wire up ontology import auto-loading so it works reliably across all trigger points (URL load, file upload, ontology dialog), add a `?loadImports=false` URL param override, clarify the settings toggle label, and fix canvas refresh after ontology dialog loads.

## Problem Frame

`discoverReferencedOntologies()` exists and already fires after URL-based RDF loads, but three gaps remain: (1) file upload does not trigger it at all, (2) there is no URL-param override for embedding/sharing use cases, and (3) the ontology dialog (`loadAdditionalOntologies`) does not call `emitAllSubjects` after loading, so the canvas does not update. The settings toggle label is also ambiguous.

(see origin: docs/brainstorms/2026-04-20-ontology-import-loading-requirements.md)

## Requirements Trace

- R1. Auto-load `owl:imports` after file upload
- R2. `?loadImports=false` URL param disables auto-loading session-wide, overriding the persisted setting
- R3. Canvas updates after ontology dialog loads (single ontology or batch)
- R4. Settings toggle label is clear to non-expert users
- R5. Single-level import depth is preserved (no recursive traversal)

## Scope Boundaries

- No `?loadImports=true` URL param — no identified use case
- No per-ontology include/exclude UI
- No import discovery log or status panel
- No recursive / transitive import following
- Pre-existing error behavior in `discoverReferencedOntologies` (throws on first candidate failure) is not changed in this plan

### Deferred to Separate Tasks

- Fix `discoverReferencedOntologies` to continue loading remaining candidates after a single failure: separate fix PR

## Context & Research

### Relevant Code and Patterns

- `src/stores/ontologyStore.ts` — `discoverReferencedOntologies()` (lines ~1254–1480): reads `autoDiscoverOntologies` from store at call time to guard early exit; calls `emitAllSubjects("urn:vg:data")` at line 1475 after all candidates load
- `src/stores/ontologyStore.ts` — `loadAdditionalOntologies()` (lines ~1088–1168): iterates URIs serially, does NOT call `emitAllSubjects` after batch
- `src/stores/ontologyStore.ts` — `loadOntology()` line 822: calls `emitAllSubjects()` only when `autoload` is false; since `loadAdditionalOntologies` passes `autoload: true`, no emission fires
- `src/components/Canvas/ReactodiaCanvas.tsx` lines 978–991 — `handleFileChange()`: calls `rdfManager.loadRDFIntoGraph()` directly, no discovery call
- `src/components/Canvas/ReactodiaCanvas.tsx` lines 779–836 — startup `useEffect`: parses `url`, `rdfUrl`, `vg_url`, `apiKey`, `apiKeyHeader` from `window.location.href` via `new URL(...).searchParams.get(...)`
- `src/stores/appConfigStore.ts` line 131 — `autoDiscoverOntologies` defaults to `true`
- `src/components/Canvas/ConfigurationPanel.tsx` line 466 — current toggle label: "Auto-discover ontologies"

### Institutional Learnings

- None documented yet (`docs/solutions/` does not exist)

## Key Technical Decisions

- **URL override propagation**: Pass a `forceDisabled?: boolean` option to `discoverReferencedOntologies()` rather than writing to the store. The store default is already `true`; the URL param is session-only and must not persist. All three call sites (URL load, file upload, and the new file-upload call) read the parsed `loadImports` ref and pass `forceDisabled: true` when applicable.
- **Ref for URL param**: Parse `?loadImports` inside the startup `useEffect` alongside existing params. Store the resolved value in a `React.useRef` so both call sites (URL load inside `useEffect`, and file upload in `handleFileChange`) can read it without prop-drilling.
- **Single-level invariant**: `discoverReferencedOntologies` already scans only `urn:vg:data`, not `urn:vg:ontologies`. Fetched imports land in `urn:vg:ontologies`. This is the existing mechanism — no code change needed, but the invariant must be preserved in any future changes to graph scanning scope.
- **`emitAllSubjects` in `loadAdditionalOntologies`**: Add a single `emitAllSubjects()` call after the serial loop completes. Mirrors the pattern already used at line 1475 of `discoverReferencedOntologies`.

## Open Questions

### Resolved During Planning

- *Does `discoverReferencedOntologies` already call `emitAllSubjects`?* Yes — line 1475, after all candidates load. The canvas update gap is only in `loadAdditionalOntologies` (ontology dialog).
- *Is the `autoDiscoverOntologies` default already `true`?* Yes — `appConfigStore.ts` line 131. No store default change needed.
- *Is `discoverReferencedOntologies` called after file upload today?* No — `handleFileChange` bypasses `loadKnowledgeGraph` entirely.

### Deferred to Implementation

- Whether `handleFileChange` needs progress reporting during discovery (consistent with existing file-load progress pattern) — implementer judgment
- Exact ref name and placement in `ReactodiaCanvas.tsx`

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
Startup useEffect (ReactodiaCanvas.tsx)
  parse ?loadImports → loadImportsRef = (value === "false" ? false : true)

URL load path (existing):
  loadKnowledgeGraph(url)
    → discoverReferencedOntologies({ load: "async", forceDisabled: !loadImportsRef.current })
    → emitAllSubjects (already fires inside discoverReferencedOntologies line 1475)

File upload path (new):
  handleFileChange()
    → rdfManager.loadRDFIntoGraph(text, ...)
    → discoverReferencedOntologies({ load: "async", forceDisabled: !loadImportsRef.current })
    → emitAllSubjects (fires inside discoverReferencedOntologies)

Ontology dialog path (fix):
  loadAdditionalOntologies([url])
    → [serial load loop]
    → emitAllSubjects()  ← ADD THIS
```

## Implementation Units

- [ ] **Unit 1: Add `forceDisabled` option to `discoverReferencedOntologies`**

**Goal:** Allow call sites to bypass the `autoDiscoverOntologies` store guard without writing to the store.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `src/stores/ontologyStore.ts`

**Approach:**
- Add `forceDisabled?: boolean` to the options type for `discoverReferencedOntologies`
- At the top of the function body, if `forceDisabled === true`, return `{ candidates: [] }` early (same as the `autoDiscoverOntologies === false` path)
- Existing behavior unchanged when `forceDisabled` is absent or `false`

**Test scenarios:**
- Happy path: `forceDisabled` not set, `autoDiscoverOntologies: true` → discovery proceeds normally
- Happy path: `forceDisabled: false` → discovery proceeds normally
- Edge case: `forceDisabled: true`, `autoDiscoverOntologies: true` → early exit, no candidates loaded
- Edge case: `forceDisabled: true`, `autoDiscoverOntologies: false` → early exit (both guards active, same result)

**Verification:**
- Function signature matches updated options type
- Unit test covers the `forceDisabled: true` early-exit path

---

- [ ] **Unit 2: Parse `?loadImports` URL param at startup**

**Goal:** Capture the `?loadImports=false` override at component mount so both trigger points can respect it.

**Requirements:** R2

**Dependencies:** Unit 1

**Files:**
- Modify: `src/components/Canvas/ReactodiaCanvas.tsx`
- Test: `src/__tests__/components/ReactodiaCanvas.loadImports.test.tsx` (new)

**Approach:**
- Inside the startup `useEffect` (lines 779–836), parse `?loadImports` alongside existing params using `searchParams.get('loadImports')`
- Store result in a `React.useRef<boolean>` (default `true`; set to `false` when param equals `"false"`)
- Pass `forceDisabled: !loadImportsRef.current` to the existing `discoverReferencedOntologies` call inside `loadKnowledgeGraph`'s post-load flow — or pass the ref to the call site if the call is already inside the effect
- Ref is created outside the effect so it is readable by `handleFileChange`

**Patterns to follow:**
- Existing param parsing pattern: `u.searchParams.get('url') || u.searchParams.get('rdfUrl') || ...` in `ReactodiaCanvas.tsx` lines 786–800
- Test pattern from `src/__tests__/components/KnowledgeCanvas.autoload.test.tsx`: set `window.location` before render, assert side effects via `waitFor`

**Test scenarios:**
- Happy path: no `?loadImports` param → ref defaults to `true`, discovery fires
- Happy path: `?loadImports=false` → ref is `false`, `discoverReferencedOntologies` called with `forceDisabled: true`
- Edge case: `?loadImports=true` explicitly → ref is `true`, discovery fires (no-op for default-on case)
- Edge case: `?loadImports=banana` (invalid) → ref defaults to `true`, discovery fires

**Verification:**
- Test confirms mock `discoverReferencedOntologies` receives `forceDisabled: true` when `?loadImports=false`

---

- [ ] **Unit 3: Wire discovery to file upload trigger**

**Goal:** Call `discoverReferencedOntologies` after a successful file upload, respecting the session override.

**Requirements:** R1, R2

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `src/components/Canvas/ReactodiaCanvas.tsx`
- Test: `src/__tests__/components/ReactodiaCanvas.fileUpload.test.tsx` (new or extend existing)

**Approach:**
- After `rdfManager.loadRDFIntoGraph(...)` resolves successfully in `handleFileChange`, call `discoverReferencedOntologies({ load: "async", forceDisabled: !loadImportsRef.current })`
- Guard with the same `typeof discoverReferencedOntologies === "function"` pattern used in `loadKnowledgeGraph` call sites
- Call is fire-and-forget (no `await`), consistent with the inline-branch pattern in `loadKnowledgeGraph` lines 1059–1073

**Patterns to follow:**
- Fire-and-forget discovery call in `loadKnowledgeGraph` inline branch, `ontologyStore.ts` lines 1059–1073

**Test scenarios:**
- Happy path: file upload succeeds → `discoverReferencedOntologies` called with `load: "async"`
- Happy path: `loadImportsRef.current === false` → `discoverReferencedOntologies` called with `forceDisabled: true`
- Error path: `rdfManager.loadRDFIntoGraph` throws → `discoverReferencedOntologies` not called
- Edge case: `discoverReferencedOntologies` is undefined on the store → no error thrown

**Verification:**
- File upload path calls discovery; URL param override respected

---

- [ ] **Unit 4: Emit subjects after `loadAdditionalOntologies` batch**

**Goal:** Refresh the canvas after a user loads one or more ontologies via the ontology dialog.

**Requirements:** R3

**Dependencies:** None (independent fix)

**Files:**
- Modify: `src/stores/ontologyStore.ts`

**Approach:**
- After the serial `for` loop in `loadAdditionalOntologies` completes (line ~1145), call `emitAllSubjects()` unconditionally
- `emitAllSubjects` with no argument emits for all subjects in all graphs — consistent with how `loadOntology` calls it for non-autoload cases (line 822)
- This fires once per batch regardless of how many URIs were loaded

**Patterns to follow:**
- `emitAllSubjects()` call in `loadOntology` line 822 (no-arg form)
- `emitAllSubjects("urn:vg:data")` call in `discoverReferencedOntologies` line 1475 (after-batch form)

**Test scenarios:**
- Happy path: single ontology loaded via dialog → `emitAllSubjects` called once after batch
- Happy path: multiple ontologies loaded → `emitAllSubjects` called once (not per-ontology)
- Edge case: all URIs already loaded (loop body skipped entirely) → `emitAllSubjects` still called
- Error path: one URI fails (continues loop) → `emitAllSubjects` still called after loop

**Verification:**
- Canvas reflects type/label data from newly loaded ontology without requiring a page reload

---

- [ ] **Unit 5: Rename settings toggle label**

**Goal:** Make the auto-discovery toggle clear to non-expert users.

**Requirements:** R4

**Dependencies:** None (independent change)

**Files:**
- Modify: `src/components/Canvas/ConfigurationPanel.tsx`

**Approach:**
- Change toggle label from "Auto-discover ontologies" (line 466) to "Automatically load referenced ontologies"
- Update adjacent description text to: "When loading RDF data, automatically fetch ontologies referenced via owl:imports."

**Test scenarios:**
- Test expectation: none — pure text change, no behavioral impact

**Verification:**
- Settings dialog Ontologies tab shows updated label and description

## System-Wide Impact

- **Interaction graph:** `handleFileChange` will now trigger `discoverReferencedOntologies` — any listener on the ontology store that reacts to new ontologies being loaded will fire after file uploads, same as URL loads
- **State lifecycle risks:** `loadAdditionalOntologies` calling `emitAllSubjects` at the end means every ontology-dialog load will now trigger a canvas refresh; this is the desired behavior but it is a new side effect for callers of that function
- **Unchanged invariants:** Single-level import depth is preserved — `discoverReferencedOntologies` scans only `urn:vg:data`; fetched imports land in `urn:vg:ontologies` and are never re-scanned
- **API surface parity:** `discoverReferencedOntologies` option type change is additive; all existing call sites continue to work with `forceDisabled` absent

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `handleFileChange` fire-and-forget discovery runs after the loading spinner clears — user sees "Loaded X" then canvas updates again | Acceptable UX for async background load; consistent with URL-load behavior |
| `loadAdditionalOntologies` now always calls `emitAllSubjects` even if all URIs were already loaded (no-op loop) | No functional harm; `emitAllSubjects` on an unchanged graph is safe |
| First discovery candidate failure aborts remaining imports (pre-existing) | Accepted for this iteration; deferred fix noted in Scope Boundaries |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-20-ontology-import-loading-requirements.md](docs/brainstorms/2026-04-20-ontology-import-loading-requirements.md)
- Related code: `src/stores/ontologyStore.ts` — `discoverReferencedOntologies`, `loadAdditionalOntologies`
- Related code: `src/components/Canvas/ReactodiaCanvas.tsx` — `handleFileChange`, startup `useEffect`
- Related code: `src/stores/appConfigStore.ts` — `AppConfig.autoDiscoverOntologies`
- Related code: `src/components/Canvas/ConfigurationPanel.tsx` — Ontologies tab toggle
