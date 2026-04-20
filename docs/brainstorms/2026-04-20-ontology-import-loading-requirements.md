# Ontology Import Auto-Loading

**Date:** 2026-04-20  
**Status:** Draft

## Problem

When users load RDF data (via `?url=` / `?rdfUrl=` / `?vg_url=` params or file upload), referenced `owl:imports` are not reliably followed. The mechanism exists (`discoverReferencedOntologies()` in `src/stores/ontologyStore.ts`) but the user has no clear control over it — the settings toggle label is ambiguous, and there is no URL-parameter override for scripted or shared-link use cases. Additionally, when ontologies load after the initial canvas render, the canvas does not update because subjects are not re-emitted.

## Goals

- Surface existing auto-load behavior clearly via a renamed settings toggle
- Let users disable auto-loading in app settings
- Let URL param `?loadImports=false` override the setting (e.g. for embedding or performance)
- Wire both trigger points (URL load and file upload) to respect the override
- Re-emit all subjects after ontology loads so the canvas updates correctly
- Keep scope minimal: single-level imports only, no recursive traversal

## Non-Goals

- Recursive / transitive import following
- Per-ontology include/exclude UI
- Import discovery log or status panel
- `?loadImports=true` URL override (no identified use case; can be added later)

## Behavior

### Default

`autoDiscoverOntologies` already defaults to `true` in `src/stores/appConfigStore.ts` — no store default change is needed. After any RDF load (URL or file), `discoverReferencedOntologies({ load: "async" })` runs automatically. The actual changes are: (1) label rename, (2) URL param wiring, (3) file-upload trigger wiring, (4) canvas re-emission after ontology load.

**Single-level enforcement:** `discoverReferencedOntologies()` scans only the data graph (`urn:vg:data`), not the ontologies graph (`urn:vg:ontologies`). Fetched ontologies land in the ontologies graph, so their imports are never re-scanned. This accidental property enforces single-level behavior; it must be preserved.

### Settings toggle

In `src/components/Canvas/ConfigurationPanel.tsx`, Ontologies tab:

- Rename existing toggle label from "Auto-discover ontologies" to **"Automatically load referenced ontologies"**
- Update description to: "When loading RDF data, automatically fetch ontologies referenced via owl:imports."

### URL parameter override

New param: `?loadImports=false`

- `?loadImports=false` — disables import auto-loading for this page load, regardless of the persisted setting
- Parsed alongside existing params in `src/components/Canvas/ReactodiaCanvas.tsx` (lines 786–800) at component mount, stored in a ref or local variable
- The resolved value is passed into both trigger points at call time
- Override is session-only; does not persist to `appConfigStore`

**Propagation mechanism:** Because `discoverReferencedOntologies()` reads `appConfigStore.autoDiscoverOntologies` at call time, the URL override must be passed explicitly. Options: (a) pass as an option to the function, e.g. `discoverReferencedOntologies({ load: "async", forceDisabled: true })`, or (b) temporarily write to the store for the session. Option (a) is preferred to avoid side effects on the persisted setting.

### Trigger points

Import loading fires after:
1. URL load via `?url=` / `?rdfUrl=` / `?vg_url=`  
   Already calls `discoverReferencedOntologies()` at `src/stores/ontologyStore.ts` lines 1018 and 1062.
2. File upload via `handleFileChange()` in `src/components/Canvas/ReactodiaCanvas.tsx` (lines 978–995)  
   Does **not** currently call `discoverReferencedOntologies()` — must be added explicitly after `rdfManager.loadRDFIntoGraph()` resolves.

### Canvas update after ontology load

After ontology imports load, the canvas does not update because `emitAllSubjects()` is not called. `emitAllSubjects()` must be called once per logical load operation, not per individual fetch:

- After `discoverReferencedOntologies()` fully resolves (all imports in the batch done)
- After the user manually loads an ontology via the ontology dialog (`loadAdditionalOntologies()`)

### Error behavior (pre-existing)

`discoverReferencedOntologies()` currently throws on the first failed candidate load (line ~1462 in `src/stores/ontologyStore.ts`), silently aborting remaining imports. This is a pre-existing issue. For this iteration, the behavior is acceptable — a follow-up can change it to a push-and-continue pattern.

## Success Criteria

- Load RDF with `owl:imports` via URL → referenced ontologies load automatically and canvas updates
- Load RDF with `owl:imports` via file upload → referenced ontologies load automatically and canvas updates
- Set toggle off in settings → imports not loaded on next load
- Add `?loadImports=false` to URL → imports not loaded even if setting is on
- Toggle label and description are clear to non-expert users
