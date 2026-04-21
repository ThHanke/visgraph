---
title: "fix: Correct broken Relay 'How it works' anchor link"
type: fix
status: active
date: 2026-04-21
origin: docs/brainstorms/2026-04-21-help-documentation-ux-requirements.md
---

# fix: Correct broken Relay "How it works" anchor link

## Overview

The AI Relay panel's "How it works" link (`src/components/Canvas/RelaySection.tsx:63`) points to `#ai-relay`, an anchor that does not exist in the GitHub README. This causes the link to silently scroll to the top of the README rather than the AI Relay Bridge section. The fix is a one-character-range URL change in one file.

## Problem Frame

Users who click "How it works" in the AI Relay sidebar panel are sent to the GitHub README top rather than the relevant documentation section. The anchor `#ai-relay` was never a valid README heading slug.

A parallel concern: the requirements doc's anchor map flagged two slugs as unverified — the AI Relay Bridge slug (conflicting parse results) and the MCP section slug (wrong name in the map). The fix validates these before shipping. (see origin: `docs/brainstorms/2026-04-21-help-documentation-ux-requirements.md`)

## Requirements Trace

- R1. Relay "How it works" link resolves to the correct GitHub README section.
- R2. No new runtime dependencies introduced.
- R3. All anchor map URLs verified to resolve by loading each link in a browser before shipping.

## Scope Boundaries

- No Help modal, About dialog, or sidebar help icon — deferred; no user signal justifying it yet.
- No contextual doc links in MCP panel, Settings, or workflow panel — deferred to a future iteration.
- No CI link-check job — manual browser verification is sufficient for this one-line fix.

## Context & Research

### Relevant Code and Patterns

- `src/components/Canvas/RelaySection.tsx:63` — the single line containing the broken href.
- The link is a plain `<a>` tag with `target="_blank" rel="noopener noreferrer"`. No routing logic, no generated URL — a literal string replacement.

### Anchor Slug Analysis

GitHub heading anchor algorithm: lowercase, spaces → hyphens, special chars stripped, `/` and `—` each produce `--` (double dash — GitHub does NOT collapse consecutive hyphens from these characters). Browser-verified 2026-04-21.

| README heading | Verified slug |
|----------------|--------------|
| `#### ChatGPT, Gemini, Claude.ai — AI Relay Bridge` | `chatgpt-gemini-claudeai--ai-relay-bridge` |
| `AI / MCP Integration` (Setext h2) | `ai--mcp-integration` — **not** `mcp-support` |
| `### Startup / URL parameters` | `startup--url-parameters` |
| `### Setup (Playwright / headless)` | `setup-playwright--headless` |
| `## Overview` | `overview` |
| `## Key capabilities` | `key-capabilities` |
| `### Left sidebar` | `left-sidebar` |

### Anchor Map Corrections Needed

All entries in the requirements doc anchor map must be verified against live GitHub before use — the entire map was built with manual slug guesses that may be wrong. Browser verification during implementation will establish ground truth for all 7 entries.

## Key Technical Decisions

- **String replacement only**: No helper, no constant, no mapping layer. The link is a one-off in a leaf component; premature abstraction has no payoff. A future iteration with multiple doc links can introduce a constants file at that time.
- **Verify before ship**: Per AC3, the implementer loads each anchor URL in a browser before committing. This is the minimum guard against repeating this class of bug.

## Open Questions

### Resolved During Planning

- **Why was the original anchor wrong?** The section heading contains "AI Relay Bridge" but was linked as `#ai-relay` — likely a hand-written guess that was never verified.
- **Should this go in a constants file?** No. YAGNI. One link, one file.
- **Is `#mcp-support` in the README?** No. The actual MCP section is the Setext h2 "AI / MCP Integration" → `ai--mcp-integration`.

### Deferred to Implementation

- **Exact dash count for Relay Bridge anchor**: Computed as 2 (`chatgpt-gemini-claudeai--ai-relay-bridge`) but must be confirmed by loading the live GitHub page. Implementer resolves this during execution.
- **Correct slug for `left-sidebar`**: Low priority (future scope), but can be spot-checked alongside the others per AC3.

## Implementation Units

- [x] **Unit 1: Verify anchors and fix the Relay link**

**Goal:** Confirm the correct GitHub anchor slugs by browser check, then update the broken href in `RelaySection.tsx` and the anchor map entries in the requirements doc.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/components/Canvas/RelaySection.tsx` (line 63 — href string only)
- Update: `docs/brainstorms/2026-04-21-help-documentation-ux-requirements.md` (anchor map table — remove ⚠️ warnings, set verified slugs)

**Approach:**
1. Open `https://github.com/ThHanke/visgraph` in a browser. For each anchor map entry, right-click the heading, copy the link, and confirm the slug.
2. Update `RelaySection.tsx` line 63: replace `https://github.com/ThHanke/visgraph#ai-relay` with the verified AI Relay Bridge anchor.
3. Update the anchor map table in the requirements doc: remove the ⚠️ warnings, set the confirmed slugs for AI Relay Bridge and MCP server/tools.

**Test scenarios:**
- Happy path: Click "How it works" in the expanded AI Relay sidebar panel → browser opens the GitHub README scrolled to the AI Relay Bridge section, not the top.
- Regression: All other sidebar links and buttons are unaffected (relay bookmarklet, connection status, call log).
- AC3: Load each URL from the anchor map in a browser — all 7 resolve to a visible README section (no redirect to top).

**Verification:**
- Clicking "How it works" in the expanded sidebar opens the correct README section.
- No TypeScript or lint errors introduced.
- `src/components/Canvas/RelaySection.tsx` diff is a single href string change.

## System-Wide Impact

- **Interaction graph:** Only `RelaySection.tsx` is modified. No callbacks, no store changes, no event bus.
- **Unchanged invariants:** The bookmarklet drag behavior, BroadcastChannel relay logic, and call log display are untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Computed anchor slug differs from live GitHub slug | Browser verification (AC3) resolves before shipping |
| GitHub changes anchor generation algorithm | Not a current risk; note is a maintenance concern for future links |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-21-help-documentation-ux-requirements.md](docs/brainstorms/2026-04-21-help-documentation-ux-requirements.md)
- Related code: `src/components/Canvas/RelaySection.tsx:63`
- Related requirements: GitHub README anchor map in origin document
