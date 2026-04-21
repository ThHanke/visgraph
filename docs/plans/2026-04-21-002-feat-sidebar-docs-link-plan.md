---
title: "feat: Add Docs link button to sidebar rail"
type: feat
status: active
date: 2026-04-21
origin: docs/brainstorms/2026-04-21-002-sidebar-help-link-requirements.md
---

# feat: Add Docs link button to sidebar rail

## Overview

Add a "Docs" link button to both states of the left sidebar. In the collapsed rail it sits adjacent to Settings at the bottom (below the `flex-1` spacer). In the expanded sidebar it appears as a footer link row below the `grid-cols-5` actions block, matching the `RelaySection` "How it works" link pattern.

## Problem Frame

The sidebar has no entry point to documentation. Users who want to understand the app have no discoverable path to the README. A single `<a>` styled as `rail-btn` fills this gap at near-zero carrying cost.

## Requirements Trace

- R1. "Docs" `rail-btn` with `HelpCircle` icon in collapsed rail, positioned below the `flex-1` spacer adjacent to Settings.
- R2. Opens `https://github.com/ThHanke/visgraph` in a new tab with `rel="noopener noreferrer"`.
- R3. Footer link row in expanded sidebar below the `grid-cols-5` block.
- R4. Tooltip text: "Documentation".

## Scope Boundaries

- No modal, About dialog, or in-app markdown rendering.
- No contextual section deep-links — README root only.
- No new runtime dependencies.

## Context & Research

### Relevant Code and Patterns

- `src/components/Canvas/LeftSidebar.tsx` — sole file to modify.
- **Collapsed rail pattern:** `TooltipPrimitive.Root` wrapping a `rail-btn` button/anchor. The `flex-1` spacer at line 239 separates action buttons from Settings. New Docs button goes between the spacer and Settings, mirroring Settings' tooltip side (`side="right"`).
- **Expanded sidebar pattern:** `grid-cols-5` at line 289 holds Onto/File/Clear/Export/Settings. Do NOT insert a 6th cell — the grid has no room. Instead, add a footer `<a>` link below the grid's parent `div`, before the `{/* Accordion sections */}` block. Mirror `RelaySection`'s "How it works" link: `flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground`.
- **`<a>` as `rail-btn`:** `rail-btn` CSS sets `display: flex` and applies regardless of element tag. Same pattern as `RelaySection`'s bookmarklet anchor. `onClick={e => e.preventDefault()}` is NOT needed here since the link is a real navigation target.
- **Icon:** `HelpCircle` from `lucide-react` — not yet imported in `LeftSidebar.tsx`; must be added to the import list alongside the existing icons.

## Key Technical Decisions

- **Below-spacer positioning in collapsed rail**: Groups Docs with Settings at the bottom, signalling it is a utility/navigation entry rather than an action button. Consistent with how other icon rails distinguish app actions from meta-navigation.
- **Footer link in expanded sidebar**: Avoids breaking the 5-column grid layout. The existing accordion content area is `flex-1 overflow-y-auto`; the footer link goes outside it, in the fixed zone between the grid and the accordion.
- **No `onClick={e => e.preventDefault()}`**: The bookmarklet anchor in `RelaySection` prevents default because dragging bookmarklets fires click. This link is a normal external link — no prevention needed.

## Implementation Units

- [ ] **Unit 1: Add Docs link to collapsed rail and expanded sidebar footer**

**Goal:** Insert the Docs link in both sidebar states.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Modify: `src/components/Canvas/LeftSidebar.tsx`

**Approach:**
1. Add `HelpCircle` to the lucide-react import.
2. In the collapsed rail (after `<div className="flex-1" />`, before the Settings `TooltipPrimitive.Root`): add a `TooltipPrimitive.Root` wrapping an `<a href="..." target="_blank" rel="noopener noreferrer" className="rail-btn" aria-label="Documentation">` with `HelpCircle` icon and `<span>Docs</span>`. Tooltip content: "Documentation", `side="right"`.
3. In the expanded sidebar, after the closing `</div>` of the `grid-cols-5` block (line ~384) and before the `{/* Accordion sections */}` block: add a `<div className="px-3 py-2 border-b border-border/40">` containing an `<a>` link styled as `flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors` with `HelpCircle h-3 w-3` and "Documentation" text.

**Patterns to follow:**
- Collapsed rail tooltip: lines 241–253 (Settings pattern) — same structure, `side="right"`.
- Expanded footer link: `src/components/Canvas/RelaySection.tsx` lines 62–70 ("How it works" link).

**Test scenarios:**
- Happy path: Click "Docs" rail button in collapsed sidebar → GitHub README opens in new tab.
- Happy path: Click "Documentation" link in expanded sidebar → GitHub README opens in new tab.
- Regression: Existing rail buttons (Onto, File, Clear, Export, Relay, Settings) remain functional and undisplaced.
- Regression: Expanded sidebar `grid-cols-5` layout unchanged; no overflow or wrapping.
- Edge case: Tooltip appears on hover over the Docs rail button in collapsed state; tooltip text reads "Documentation".

**Verification:**
- Both sidebar states show the Docs entry point.
- Clicking in either state opens `https://github.com/ThHanke/visgraph` in a new tab.
- No TypeScript or lint errors.
- `LeftSidebar.tsx` diff touches only: import line (add `HelpCircle`), one new `TooltipPrimitive.Root` block in the collapsed rail, one new `<a>` footer row in the expanded sidebar.

## System-Wide Impact

- **Interaction graph:** `LeftSidebar.tsx` only. No callbacks, store changes, or event bus.
- **Unchanged invariants:** Bookmarklet drag behavior, relay connection logic, accordion state, and all existing rail buttons are untouched.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-21-002-sidebar-help-link-requirements.md](docs/brainstorms/2026-04-21-002-sidebar-help-link-requirements.md)
- Related code: `src/components/Canvas/LeftSidebar.tsx`, `src/components/Canvas/RelaySection.tsx:62-70`
