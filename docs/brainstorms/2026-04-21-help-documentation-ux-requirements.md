# Help & Documentation UX — Requirements

**Date:** 2026-04-21  
**Status:** Ready for planning

## Problem

The sidebar's "How it works" link in the AI Relay panel points at a broken GitHub anchor (`#ai-relay`). There is no in-app entry point to documentation beyond this one broken link. Future contextual doc links are desirable but no user signal exists yet to justify a full Help modal or icon.

## Goals

1. Fix the broken Relay "How it works" anchor so users can actually reach the documentation.
2. Establish a pattern for contextual doc links (anchor map + guidance) so future links are easy to add correctly.

## Non-goals

- In-app Help modal, About dialog, or help icon in the sidebar.
- In-app markdown rendering / help panel.
- Offline docs or bundled documentation.
- Any new documentation content (README already covers everything).

## GitHub README anchor map

Base URL: `https://github.com/ThHanke/visgraph#`

| Section | Anchor slug |
|---------|-------------|
| Overview | `overview` |
| Key capabilities | `key-capabilities` |
| Startup / URL parameters | `startup--url-parameters` |
| Left sidebar | `left-sidebar` |
| AI Relay Bridge | `chatgpt-gemini-claudeai--ai-relay-bridge` |
| MCP server / tools | `ai--mcp-integration` |
| Playwright / headless | `setup-playwright--headless` |

> GitHub auto-generates slugs: lowercase, spaces → `-`, special chars stripped, `—` → empty, consecutive `-` collapsed. Anchors must be re-verified when the corresponding README heading text changes.

## Scope

### 1. Fix Relay "How it works" link

- Current: `https://github.com/ThHanke/visgraph#ai-relay` (broken — no such anchor exists).
- Fix to: `https://github.com/ThHanke/visgraph#chatgpt-gemini-claudeai--ai-relay-bridge`.
- File: `src/components/Canvas/RelaySection.tsx:63`.

### 2. Contextual doc links in other panels (future / out of scope this iteration)

- MCP panel or Settings tab: link to `#mcp-support`.
- Workflow template panel: link to `#left-sidebar` (note: `#sidebar-content-expanded` does not exist in the README anchor map and must not be used).
- Out of scope for this iteration. When added, use the anchor map above to ensure links are valid.

## Acceptance criteria

1. Relay "How it works" link resolves to a valid GitHub README anchor.
2. No new runtime dependencies introduced.
3. All anchor map URLs verified to resolve by manually loading each link in a browser before shipping.
