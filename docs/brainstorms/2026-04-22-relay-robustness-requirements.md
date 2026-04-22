# Relay Robustness: Injection, Defocus, Popup — Requirements

**Date:** 2026-04-22
**Status:** Ready for planning

## Problem

Four reliability issues in `public/relay-bookmarklet.js` and `src/mcp/relayBridge.ts`:

1. **Injection fragility** — Different chat UIs (ChatGPT textarea, Claude.ai ProseMirror, Open WebUI TipTap, Gemini) have diverging DOM structures. The current `setInnerText` / `execCommand` strategy breaks on some.

2. **Defocused tab** — When the user switches from the chat tab to the VisGraph app to see what was created, the relay stops working: `el.focus()` fails (browser restriction) and postMessage to popup may time out or be dropped.

3. **Popup not opening** — User must click the bookmarklet multiple times. Root cause: the idempotency guard (`window.__vgRelayActive`) short-circuits to `showBadge()` on re-click, but does not call `openPopup()` when the popup is closed. Also: if `window.open` is blocked silently, no feedback is shown.

4. **Indicator always green** — `useRelayBridge` sets `connected = true` immediately when the bridge starts, regardless of whether the relay popup is actually open. The green dot in the sidebar is always on.

## Goals

- Injection works reliably across ChatGPT, Claude.ai, Open WebUI, Gemini
- Relay queues work while tab is defocused; drains automatically when tab regains focus
- One bookmarklet click always results in a visible popup (or clear actionable error)
- Sidebar green dot reflects real popup presence

## Non-Goals

- Supporting chat UIs with no visible text input (voice-only, etc.)
- Changing the tool-call detection or TOOL: parsing format
- Changing the relay.html popup UI

## Requirements

### R1: Clipboard-based injection

- Primary injection path: `navigator.clipboard.writeText(text)` then focus input and dispatch a `paste` ClipboardEvent
- This works natively for all input types: textarea, ProseMirror, TipTap, React controlled inputs
- If Clipboard API is unavailable or permission denied, fall back to DataTransfer synthetic ClipboardEvent (no permission needed, synchronous)
- If that also fails, fall back to current textarea-setter / execCommand approach
- Submit still happens via `submitInput()` after successful injection

### R2: Defocus-safe processing

- Before calling `injectResult()`, check `document.hasFocus()` and `document.visibilityState`
- If tab is not active: store the pending combined result (text, ok flag) in a variable; do not inject yet
- Listen for `document.visibilitychange`; when tab becomes visible and focused, drain any queued injection
- The MutationObserver and tool-call queue continue processing normally in the background — only the final inject-and-submit is deferred
- Show a toast when injection is deferred: "⏳ Waiting for tab focus to inject result"

### R3: Reliable popup open

- Fix the idempotency guard: when `window.__vgRelayActive` is already true, call `openPopup()` in addition to `showBadge()` (not instead of it)
- After `window.open()`, check return value; if null/undefined, show an actionable error: "Popup blocked — allow popups for this site, then click the badge to retry"
- Animate/pulse the badge (CSS outline blink) when popup is needed but blocked, to draw attention

## Success Criteria

- Injecting a result into Claude.ai, ChatGPT, and Open WebUI all work without manual intervention
- Switching to the VisGraph tab while the AI is responding does not lose the result; it injects when focus returns
- Clicking the bookmarklet once always opens the popup or shows a clear "blocked" message

### R4: Accurate connection indicator

- `public/relay.html` broadcasts `{ type: 'vg-ping' }` on BroadcastChannel immediately on load and every 10 seconds (heartbeat)
- `src/mcp/relayBridge.ts` listens for `vg-ping`; tracks `lastPingAt` timestamp; exposes a `connected` boolean (true when `lastPingAt` is within the last 15 seconds)
- `startRelayBridge()` returns `connected` state or fires a callback so `useRelayBridge` can subscribe
- `src/hooks/useRelayBridge.ts` uses this real signal instead of the hardcoded `setConnected(true)`
- When relay.html closes, heartbeat stops; within ≤15 s the indicator goes grey

## Files Affected

- `public/relay-bookmarklet.js` — R1, R2, R3
- `public/relay.html` — R4 heartbeat broadcast
- `src/mcp/relayBridge.ts` — R4 ping listener + connected signal
- `src/hooks/useRelayBridge.ts` — R4 real connected state
- `dist/relay-bookmarklet.js` — regenerated from build
