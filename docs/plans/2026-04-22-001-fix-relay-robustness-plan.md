---
title: "fix: Relay robustness — injection, defocus, popup, indicator"
type: fix
status: active
date: 2026-04-22
origin: docs/brainstorms/2026-04-22-relay-robustness-requirements.md
---

# fix: Relay robustness — injection, defocus, popup, indicator

## Overview

Four targeted fixes to `public/relay-bookmarklet.js`, `public/relay.html`, and the VisGraph app's relay bridge. Together they replace fragile innerText injection with clipboard-paste, queue result injection while the chat tab is defocused, repair the popup idempotency guard, and wire the sidebar green dot to a real heartbeat signal from the relay popup.

## Problem Frame

The relay bookmarklet chain has four independent reliability failures:

1. **Injection fragility** — innerText/execCommand diverges across ChatGPT, Claude.ai, Open WebUI. Clipboard paste events are intercepted natively by all frameworks (ProseMirror, TipTap, React controlled inputs).
2. **Defocused tab** — `el.focus()` is a no-op from an unfocused tab. Results are lost when the user switches to the VisGraph app to inspect what was created.
3. **Popup guard** — re-clicking the bookmarklet calls `showBadge()` without calling `openPopup()`, so a closed popup is never reopened. Silent `window.open()` failures produce no feedback.
4. **Indicator always green** — `useRelayBridge` hardcodes `connected = true` on bridge start; it never reflects actual popup presence.

See origin: `docs/brainstorms/2026-04-22-relay-robustness-requirements.md`

## Requirements Trace

- R1. Clipboard-based injection — three-layer fallback works across all target chat UIs
- R2. Defocus-safe processing — tab-unfocused results are queued and injected on refocus
- R3. Reliable popup open — one bookmarklet click always opens popup or shows actionable error
- R4. Accurate connection indicator — sidebar green dot reflects heartbeat from relay.html

## Scope Boundaries

- No changes to tool-call detection or TOOL: parsing format
- No changes to relay.html popup UI/layout
- No changes to MCP tool handlers or `relayBridge.ts` business logic
- No automated minification pipeline — inline bookmarklet in `LeftSidebar.tsx` is updated manually

## Context & Research

### Relevant Code and Patterns

- `public/relay-bookmarklet.js` — canonical readable source; E2E tests use this file directly
- `src/components/Canvas/LeftSidebar.tsx` lines 45–49 — `buildBookmarkletHref()` contains a hand-minified `javascript:` URI string; **significantly diverged from the readable source** (old parser, old inject logic, no batch queue). Must be updated manually alongside all readable-source changes.
- `public/relay.html` — popup bridge; uses `window.addEventListener('message')` from opener and `BroadcastChannel('visgraph-relay-v1')` toward the app. Receives `vg-call` via postMessage; sends `vg-result` back via `opener.postMessage`.
- `src/mcp/relayBridge.ts` — app-side BroadcastChannel listener; `startRelayBridge()` returns a cleanup fn; `onCallLogged()` export pattern to mirror for `onConnectionChanged()`
- `src/hooks/useRelayBridge.ts` — `setConnected(true)` hardcoded at line 14 is the root cause of R4 bug
- `e2e/relay-bookmarklet.real.spec.ts` — Playwright E2E; injects `relay-bookmarklet.js` via `page.evaluate`, drives `relay-mock-chat.html` scenarios, asserts on `#chat-stream .msg-user`
- `public/relay-mock-chat.html` — mock AI chat; switchable textarea / contenteditable / ProseMirror modes

### Institutional Learnings

- DOM tests must not use Vitest/jsdom for relay/bookmarklet code — results are silently empty. Use Playwright against `relay-mock-chat.html` for all injection and lifecycle tests. (see `docs/solutions/developer-experience/vitest-jsdom-broken-in-isolation-2026-04-21.md`)
- The `pairRe` lazy regex in `parseParamLine()` must not be reverted to a colon-split tokenizer — IRI values containing `http:` would break. (see `docs/solutions/logic-errors/relay-inline-param-iri-splitting-2026-04-21.md`)

## Key Technical Decisions

- **Clipboard paste as primary injection**: All mainstream chat frameworks (ProseMirror, TipTap, React controlled inputs, plain textarea) intercept `paste` events natively and update internal state correctly — unlike execCommand or direct DOM writes. Async clipboard API requires no special permission in a bookmarklet context (user gesture chain).
- **DataTransfer fallback before old approach**: `new DataTransfer()` is synchronous, needs no permission, and works in Firefox and Chromium without clipboard API. It is the best intermediate fallback before the legacy textarea-setter path.
- **Defer inject-and-submit only**: Tool-call queue processing continues in the background during defocus. Only the final `injectCombinedResult` → `submitInput` step is held until the tab regains focus. This avoids losing tool results while keeping queue processing fast.
- **`onConnectionChanged` mirrors `onCallLogged`**: Adding a second subscription export keeps the relay bridge API surface consistent and avoids changing `startRelayBridge()`'s return type (breaking existing callers).
- **15-second liveness window, 10-second heartbeat**: Gives one full missed heartbeat before the indicator goes grey, without adding noticeable latency to the "popup closed" signal.
- **Inline bookmarklet stays hand-maintained**: No automated minification pipeline is added. The inline string in `LeftSidebar.tsx` is updated manually as part of this plan. This is a known maintenance burden; a future task can automate it.

## Open Questions

### Resolved During Planning

- **Should we replace the inline bookmarklet with a fetched script?** No — the `javascript:` URI must inject dynamic `RU`/`RO` values from React context. Fetching an external script adds latency and CSP risk. Manual sync is chosen.
- **Does `navigator.clipboard.writeText` require permission in a bookmarklet?** No — bookmarklets execute as user gestures, so the Clipboard API is available without explicit permission prompts in both Chrome and Firefox.
- **Will the DataTransfer ClipboardEvent work in Firefox?** Yes — `new DataTransfer()` is supported in Firefox 62+ and all Chromium-based browsers.

### Deferred to Implementation

- Whether `relay-mock-chat.html` needs a clipboard-aware mock submit handler (the existing native inputs should handle paste natively; verify during E2E).
- Exact Playwright `grantPermissions(['clipboard-read', 'clipboard-write'])` call syntax — confirm during E2E unit implementation.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### R4 Heartbeat flow (new)

```
relay.html loads
  → bc.postMessage({ type: 'vg-ping' })        immediately
  → setInterval: bc.postMessage({ type: 'vg-ping' }) every 10 s

relayBridge.ts (BroadcastChannel listener)
  vg-ping  → lastPingAt = Date.now()
            → fire onConnectionChanged(true) listeners
  (no ping for >15 s) → fire onConnectionChanged(false)
  vg-call  → handleCall() [unchanged]

useRelayBridge
  onConnectionChanged → setConnected(true/false)   [replaces hardcoded setConnected(true)]
```

### R1 Injection fallback chain (new `injectResult`)

```
injectResult(text):
  1. navigator.clipboard.writeText(text)
       .then: el.focus(); el.dispatchEvent(new ClipboardEvent('paste', { bubbles:true }))
       .catch: fallback_2(text)
  2. fallback_2: DataTransfer dt; dt.setData('text/plain', text)
       el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles:true }))
       if input didn't change: fallback_3(text)
  3. fallback_3: textarea setter + input event  OR  execCommand('insertText')
  → submitInput(el) after any successful path
```

## Implementation Units

- [x] **Unit 1: R3 — Fix popup idempotency guard and blocked-popup feedback**

**Goal:** One bookmarklet click reliably opens the popup or shows a clear error when blocked.

**Requirements:** R3

**Dependencies:** None

**Files:**
- Modify: `public/relay-bookmarklet.js`

**Approach:**
- In the idempotency guard branch (`if (window.__vgRelayActive)`): call `openPopup()` AND then `showBadge()` instead of just `showBadge()`.
- After `openPopup()` returns (whether first-run or re-run): check if the return value is null/undefined. If so, show an error toast: "Popup blocked — allow popups for this site, then click the badge to retry". Add a CSS keyframe animation (outline pulse) to the badge element to draw attention.

**Patterns to follow:**
- `showToast()` for error message style
- `openPopup()` already exists; just call it in the guard branch

**Test scenarios:**
- Happy path: first bookmarklet click → popup opens, badge appears
- Re-click when popup closed → popup reopens without requiring the old workaround
- Popup blocked by browser → toast appears with clear retry instruction; badge pulses

**Verification:**
- Clicking the bookmarklet a second time (after closing the popup) opens the popup without needing to click the badge
- When popup is blocked, a descriptive toast is shown

---

- [x] **Unit 2: R2 — Defocus-safe injection queue**

**Goal:** Results are never lost when the user switches tabs to inspect the VisGraph app.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `public/relay-bookmarklet.js`

**Approach:**
- Add a `pendingInjection` variable (null or `{ text, allOk }`) at module scope.
- In `injectCombinedResult`: before calling `injectResult()`, check `document.hasFocus()` and `document.visibilityState === 'visible'`. If the tab is not active, store the combined result text in `pendingInjection` and show a toast "⏳ Waiting for tab focus to inject result". Return early.
- Register one `document.addEventListener('visibilitychange', ...)` listener at init time. On fire: if `document.visibilityState === 'visible'` and `pendingInjection` is set, clear it and call `injectResult()` + `showToast()`.
- The MutationObserver, callQueue, and batch processing are unaffected — only the final inject-and-submit step is deferred.

**Patterns to follow:**
- `callQueue` and `batchResults` pattern for queued state

**Test scenarios:**
- Happy path: tab focused throughout → injection fires immediately, no toast shown
- Defocus scenario: tab loses focus before `injectCombinedResult` fires → toast shown, no injection yet; tab regains focus → result injected, submit triggered
- Multiple defocus/refocus cycles: only the most recent queued result is injected (no double-submit)

**Verification:**
- Switching to VisGraph app while AI is responding does not lose the result
- On return to chat tab, the result is automatically injected and submitted

---

- [x] **Unit 3: R1 — Clipboard-based injection with fallback chain**

**Goal:** Result injection works reliably across ChatGPT, Claude.ai, Open WebUI, and Gemini.

**Requirements:** R1

**Dependencies:** None (can be developed in parallel with Unit 2; both modify `injectResult`)

**Files:**
- Modify: `public/relay-bookmarklet.js`

**Approach:**
- Replace `injectResult(text)` body with a three-layer fallback:
  1. **Primary**: `navigator.clipboard.writeText(text)` → in `.then`: focus input, dispatch `new ClipboardEvent('paste', { bubbles: true, cancelable: true })`. The browser will use the clipboard content.
  2. **Fallback 1**: if clipboard API unavailable or permission denied (`.catch`): construct `new DataTransfer()`, call `dt.setData('text/plain', text)`, dispatch `new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })` on the focused input.
  3. **Fallback 2**: if DataTransfer paste produces no change (check `el.value` or `el.textContent`): fall back to the existing textarea native setter path for `TEXTAREA`, and `document.execCommand('selectAll')` + `execCommand('insertText', false, text)` for contenteditable.
- `submitInput(el)` is called after any successful path with a `setTimeout(..., 500)` to allow framework state to settle.
- Return `false` only if all three paths fail; show a toast in that case.

**Patterns to follow:**
- Existing `findInput()` and `submitInput()` helpers
- Existing `showToast()` for error feedback

**Test scenarios:**
- Happy path (textarea): clipboard write + paste event → value updated → submit fires
- Happy path (ProseMirror contenteditable): clipboard write + paste event → ProseMirror internal state updated → submit fires
- Clipboard permission denied: DataTransfer fallback produces correct result in input
- DataTransfer unavailable: legacy execCommand path produces correct result
- No input found: `injectResult` returns false, toast shown

**Verification:**
- In `relay-mock-chat.html`, all three input modes (textarea, contenteditable, ProseMirror) successfully receive and submit injected text
- Playwright E2E test for each mode passes

---

- [x] **Unit 4: R4a — Heartbeat broadcast in relay.html**

**Goal:** relay.html continuously signals its presence to the VisGraph app via BroadcastChannel.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `public/relay.html`

**Approach:**
- After the BroadcastChannel is set up (line ~124), immediately broadcast `{ type: 'vg-ping' }` once.
- Start a `setInterval` that broadcasts `{ type: 'vg-ping' }` every 10 000 ms.
- Store the interval ID; clear it in the existing `window.onunload` handler (or add one) so the broadcast stops cleanly when the popup is closed.

**Patterns to follow:**
- Existing `bc.postMessage(...)` pattern in relay.html

**Test scenarios:**
- Test expectation: none — this unit has no standalone logic to assert; the observable effect is tested in Unit 5's integration scenario

**Verification:**
- relay.html sends at least one `vg-ping` message on BC within 500 ms of opening
- A second ping arrives within ~11 s

---

- [x] **Unit 5: R4b — Ping listener and real connected signal in relayBridge**

**Goal:** The sidebar green dot reflects real popup presence, going grey within 15 s of popup close.

**Requirements:** R4

**Dependencies:** Unit 4 (relay.html must broadcast `vg-ping` for this to be testable)

**Files:**
- Modify: `src/mcp/relayBridge.ts`
- Modify: `src/hooks/useRelayBridge.ts`

**Approach:**
- In `relayBridge.ts`:
  - Add a module-level `connectionListeners` array, mirroring `callLogListeners`.
  - Export `onConnectionChanged(cb: (connected: boolean) => void): () => void`.
  - In the `BroadcastChannel.onmessage` handler: on `vg-ping`, update `lastPingAt = Date.now()` and fire `onConnectionChanged(true)` listeners.
  - Start a `setInterval` (every 5 s) in `startRelayBridge` that checks `Date.now() - lastPingAt > 15000`; if stale, fire `onConnectionChanged(false)`. Store interval; clear it in the returned cleanup fn.
  - `startRelayBridge` return value stays `() => void` (no breaking change).
- In `useRelayBridge.ts`:
  - Remove `setConnected(true)` at line 14.
  - After calling `startRelayBridge()`, subscribe via `onConnectionChanged(setConnected)`.
  - Unsubscribe in the cleanup (return) fn alongside `unsubscribe()` for `onCallLogged`.

**Patterns to follow:**
- `onCallLogged` / `callLogListeners` pattern in `src/mcp/relayBridge.ts`
- `useEffect` cleanup pattern in `src/hooks/useRelayBridge.ts`

**Test scenarios:**
- Happy path: relay.html ping arrives → `connected` becomes true → green dot shown
- Popup closed: no ping for 16 s → `connected` becomes false → dot goes grey
- Rapid open/close: connect → disconnect signal fires within 15 s of last ping
- Integration: `useRelayBridge` connected state toggles correctly when heartbeat starts and stops

**Verification:**
- Sidebar indicator is grey on app load before any bookmarklet click
- Indicator turns green within 1 s of relay popup opening
- Indicator turns grey within 15 s of relay popup being closed

---

- [x] **Unit 6: Sync inline bookmarklet in LeftSidebar.tsx**

**Goal:** The actual draggable bookmarklet (used by real users) reflects all R1/R2/R3 fixes.

**Requirements:** R1, R2, R3

**Dependencies:** Units 1, 2, 3 (all `relay-bookmarklet.js` changes must be finalized first)

**Files:**
- Modify: `src/components/Canvas/LeftSidebar.tsx`

**Approach:**
- Manually re-minify the updated `relay-bookmarklet.js` into the inline `javascript:` string in `buildBookmarkletHref()`.
- Replace the two hardcoded constants (`RELAY_URL` and `RELAY_ORIGIN`) with the `RU` and `RO` template variables already present in the inline version.
- The inline version currently uses an older parser (single-block regex) and older inject logic. Bring it fully up to date with the readable source: batch queue, prefix expansion, fence stripping, dedup set, and all R1/R2/R3 code.
- Preserve the `RU`/`RO` dynamic injection pattern that is unique to the inline version.

**Patterns to follow:**
- Existing `buildBookmarkletHref()` signature and `new URL('relay.html', pageHref).href` pattern for `RU`

**Test scenarios:**
- Test expectation: none — no automated test validates the inline string directly. Manual drag-to-bookmarks + click smoke test is the verification.

**Verification:**
- Dragging the bookmarklet link from the VisGraph sidebar and clicking it on Claude.ai / ChatGPT opens the popup and correctly processes tool calls using the updated logic

---

- [x] **Unit 7: E2E test coverage for new injection and defocus behaviour**

**Goal:** Prevent regressions in clipboard injection and defocus queuing.

**Requirements:** R1, R2

**Dependencies:** Units 1, 2, 3 (readable source must be updated before E2E tests can validate it)

**Files:**
- Modify: `e2e/relay-bookmarklet.real.spec.ts`
- Modify (if needed): `public/relay-mock-chat.html`

**Approach:**
- For clipboard injection: Playwright's `context.grantPermissions(['clipboard-read', 'clipboard-write'])` enables clipboard API in the test browser. Add a test scenario per input mode (textarea, contenteditable, ProseMirror) that verifies the text reaches `#chat-stream .msg-user` via the paste path. Confirm during implementation that `relay-mock-chat.html` native input elements handle paste events without changes — if not, add minimal paste-event plumbing.
- For defocus: simulate tab switching by calling `page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))` with `document.hidden = true` spoofed before the scenario triggers injection, then restoring focus and asserting the deferred injection fires.
- Existing E2E scenarios (single, batch, unknown tool) must still pass unchanged.

**Execution note:** Run E2E tests against both the readable source and verify the same scenarios work with the inline string via a manual smoke test.

**Patterns to follow:**
- Existing scenario structure in `e2e/relay-bookmarklet.real.spec.ts`
- `page.evaluate` bookmarklet injection pattern already in use

**Test scenarios:**
- Clipboard injection, textarea mode: scenario triggers → clipboard written → paste event fires → text in chat stream → submitted
- Clipboard injection, ProseMirror mode: same as above
- Clipboard permission denied (mocked): DataTransfer fallback → text in chat stream
- Defocus queue: inject deferred while tab hidden → tab becomes visible → injection fires, submit triggered

**Verification:**
- `npx playwright test e2e/relay-bookmarklet.real.spec.ts` passes all existing and new scenarios
- No test imports relay-bookmarklet.js logic into Vitest (would silently fail per institutional learning)

## System-Wide Impact

- **Interaction graph:** `useRelayBridge` now subscribes to `onConnectionChanged` — if multiple components call `useRelayBridge`, each gets independent subscription/cleanup. No shared singleton state is introduced.
- **Error propagation:** Clipboard API promise rejections are caught and routed to fallback; they do not surface as unhandled rejections.
- **State lifecycle risks:** `pendingInjection` is a simple overwrite; multiple deferred results do not queue — only the latest batch is held. This matches the sequential single-batch processing model.
- **Unchanged invariants:** `startRelayBridge()` return type stays `() => void`. `onCallLogged` API is unchanged. `RelaySection.tsx` props interface is unchanged.
- **API surface parity:** `onConnectionChanged` export follows the exact same signature pattern as `onCallLogged` for consistency.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Clipboard API blocked by site CSP | Three-layer fallback ensures legacy paths still work |
| `document.visibilitychange` not firing in some browsers when switching windows (not tabs) | `document.hasFocus()` check is also included; defocus detection covers both cases |
| `setInterval` in relay.html leaking if popup is force-closed | `clearInterval` in `window.onunload`; interval fires even if `onunload` is missed, but `lastPingAt` will go stale naturally within 15 s |
| Inline bookmarklet sync introducing a regression | Manual smoke test on Claude.ai and ChatGPT before shipping |

## Documentation / Operational Notes

- After shipping, check `README.md` for any section describing the bookmarklet or relay setup — update if UI behaviour or setup steps changed (per CLAUDE.md requirement).

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-22-relay-robustness-requirements.md](docs/brainstorms/2026-04-22-relay-robustness-requirements.md)
- Relay readable source: `public/relay-bookmarklet.js`
- Inline bookmarklet: `src/components/Canvas/LeftSidebar.tsx` lines 45–49
- Relay bridge: `src/mcp/relayBridge.ts`, `src/hooks/useRelayBridge.ts`
- E2E tests: `e2e/relay-bookmarklet.real.spec.ts`
- Institutional learnings: `docs/solutions/developer-experience/vitest-jsdom-broken-in-isolation-2026-04-21.md`, `docs/solutions/logic-errors/relay-inline-param-iri-splitting-2026-04-21.md`
