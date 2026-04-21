---
date: 2026-04-21
topic: sidebar-help-link
---

# Sidebar Help Link Button

## Problem Frame

The sidebar has no entry point to documentation. Users who want to understand the app have no discoverable path to the README. A simple "Docs" link button in the collapsed icon rail fills this gap at near-zero carrying cost.

## Requirements

- R1. A "Docs" `rail-btn` link using the `HelpCircle` lucide-react icon appears in the collapsed sidebar rail, positioned after the `flex-1` spacer (adjacent to Settings at the bottom).
- R2. Clicking it opens `https://github.com/ThHanke/visgraph` in a new tab (`target="_blank" rel="noopener noreferrer"`). No modal, no in-app rendering.
- R3. In the expanded sidebar, the button appears as a footer link row below the existing `grid-cols-5` actions block — not inside the 5-column grid. Styled as a small muted text link with icon, consistent with `RelaySection`'s "How it works" link pattern.
- R4. A tooltip labels the button "Documentation".

## Scope Boundaries

- No modal, About dialog, or in-app markdown rendering.
- No contextual section deep-links from this button — links to README root only.
- No new runtime dependencies.

## Key Decisions

- **Plain `<a>` tag as `rail-btn`**: Same pattern as the existing "How it works" link in RelaySection — no routing logic, no abstraction.
- **README root, not a section anchor**: The help button is a general entry point; section anchors live in the RelaySection "How it works" link already added.

## Success Criteria

- The Docs button is visible and clickable in the collapsed rail.
- Clicking opens the GitHub README in a new browser tab.
- No existing rail buttons are displaced or broken.
