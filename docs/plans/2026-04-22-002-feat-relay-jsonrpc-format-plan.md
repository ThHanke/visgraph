---
title: "feat: Relay MCP JSON-RPC 2.0 wire format"
type: feat
status: active
date: 2026-04-22
---

# feat: Relay MCP JSON-RPC 2.0 wire format

## Overview

Switch the AI relay from the custom `TOOL: name\nparam: value` text format to MCP
JSON-RPC 2.0 — the actual spec that `.well-known/mcp.json` describes. The AI
writes tool calls as single-backtick inline JSON (`\`{"jsonrpc":"2.0",...}\``); the
bookmarklet parses them; results come back as backtick-wrapped JSON-RPC responses.
The starter prompt in README / `docs/relay-bridge.md` is rewritten to match.

## Problem Frame

The current TOOL-block format is bespoke and underdocumented for the AI. The AI
already knows MCP JSON-RPC 2.0 and the repo ships a full `.well-known/mcp.json`
manifest. Using the real spec reduces prompt length, eliminates the custom
parameter-parsing grammar, and makes the AI's tool-call intent unambiguous (tool
name + typed arguments in one JSON object, with an `id` for round-trip correlation).

The broken branch (`feat/relay-jsonrpc-format`) proved the concept but was abandoned
because the listener became non-functional — unrelated to the format change. That
branch gives us the parser, result formatter, test fixtures, and updated prompt.
The goal of this plan is to port those pieces cleanly onto the now-stable
`fix/relay-robustness` base, fix what was broken, and update all tests.

## Requirements Trace

- R1. Bookmarklet detects MCP JSON-RPC 2.0 tool calls written as inline
  single-backtick JSON in AI responses.
- R2. Bookmarklet injects results as backtick-wrapped JSON-RPC response objects
  (one per call) so the AI can parse them by `id`.
- R3. A human-readable header line (`[VisGraph — N tools ✓]`) is retained above
  the JSON-RPC responses for readability.
- R4. Canvas summary line and SVG attachment are preserved in the injected result.
- R5. Prefix expansion (`ex:`, `foaf:`, etc.) works on `arguments` values.
- R6. Dedup set prevents re-dispatching the same call during streaming.
- R7. Streaming safety: truncated JSON (unbalanced braces) is silently skipped.
- R8. Starter prompt in `README.md` and `docs/relay-bridge.md` uses JSON-RPC format.
- R9. Unit tests cover the new parser; mock HTML fixtures emit JSON-RPC blocks.
- R10. `LeftSidebar.tsx` minified bookmarklet stays in sync with source.

## Scope Boundaries

- No changes to `src/mcp/` tools, `relayBridge.ts`, or `relay.html` popup.
- No changes to the BroadcastChannel message protocol between popup and VisGraph tab.
- No changes to `isAiStreaming()` / `waitForIdle()` streaming-detection logic.
- E2E Playwright tests (`e2e/`) are out of scope for this plan — they require
  live browser automation and are a separate concern.

### Deferred to Separate Tasks

- E2E spec updates for the new result format — separate PR after this lands.
- `relay-fhgenie-mock.html` fixture updates — deferred with E2E work.

## Context & Research

### Relevant Code and Patterns

- `public/relay-bookmarklet.js` — current TOOL-block parser in `extractAllToolCalls()`;
  `injectCombinedResult()` for result formatting. Both get replaced.
- `src/components/Canvas/LeftSidebar.tsx` — `buildBookmarkletHref()` contains the
  minified inline copy. Must be kept in sync manually after every source change.
- `src/__tests__/relay/bookmarklet.extractToolCalls.test.ts` — unit tests replicate
  the parser inline (no import). Pattern to follow for new tests.
- `public/relay-mock-chat.html` — scenario buttons; must emit JSON-RPC blocks.
- Broken branch `feat/relay-jsonrpc-format` — has working versions of the parser
  (`extractJsonObjects` + `validateMcpRequest` + `extractAllToolCalls`), result
  formatter, and updated prompts. Use as reference, not as a direct cherry-pick
  (the listener was broken there).

### What the broken branch had right

- Brace-depth scanner `extractJsonObjects(text)` — robust to streaming truncation.
- `validateMcpRequest(obj)` — rejects non-tools/call JSON (false-positive guard).
- Result lines: `` `{"jsonrpc":"2.0","id":<N>,"result":{"content":[{"type":"text","text":"<summary>"}]}}` ``
- `mcpId` field on queued calls for round-trip correlation.
- Prefix expansion on `req.params.arguments` values.

### What was broken there (do not repeat)

- The relay listener (`window.addEventListener('message', ...)`) was dysfunctional —
  exact cause unknown but it was in the same WIP commit. The current branch has a
  working listener; do not touch it.
- The `visibilityState` focus guard (already fixed in current branch).

## Key Technical Decisions

- **Inline backtick, not code fence**: The broken branch comments mentioned
  ` ```mcp ` fences but the actual parser used inline single-backtick JSON. Inline
  is simpler (one regex / brace scan), streaming-safe, and matches what AI models
  naturally produce for JSON snippets. Stick with inline backtick.
- **Keep human header line**: `[VisGraph — N tools ✓]` above the JSON-RPC responses
  lets humans read results at a glance without parsing JSON.
- **Retain canvas summary + SVG**: These go after the JSON-RPC response lines,
  separated by a blank line, so they do not interfere with the AI's JSON parsing.
- **`mcpId` round-trip**: Carry `req.id` through the queue item → batch result →
  response JSON so the AI can correlate requests and responses by `id`.
- **Manual minification sync**: No build step — update `LeftSidebar.tsx` by hand
  after source is finalized. A comment in source calls this out explicitly.

## High-Level Technical Design

> *Directional guidance, not implementation specification.*

```
AI response text
       │
       ▼
extractJsonObjects(text)       ← brace-depth scanner, skips truncated JSON
       │ [{...}, {...}, ...]
       ▼
validateMcpRequest(obj)        ← must be {jsonrpc:"2.0", method:"tools/call", params:{name,arguments}}
       │ valid calls only
       ▼
prefix-expand arguments values ← ex:Alice → http://example.org/Alice
       │
       ▼
dedup via sig Set              ← tool+JSON.stringify(params) key
       │
       ▼
callQueue  →  processNextInQueue()  →  postMessage to popup
                                              │
                              window.addEventListener('message')  ← vg-result
                                              │
                              injectCombinedResult(results, summary, svg)
                                              │
                     ┌────────────────────────┤
                     │  [VisGraph — N tools ✓]          ← human header
                     │  `{"jsonrpc":"2.0","id":1,...}`   ← per-call JSON-RPC response
                     │  `{"jsonrpc":"2.0","id":2,...}`
                     │                                   ← blank line
                     │  Canvas: N nodes, M links
                     │  Current graph (SVG): <svg...>
                     └────────────────────────►  injectResult(text)
```

**Starter prompt wire format (AI output side):**
```
`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://example.org/Alice","label":"Alice"}}}`
`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://example.org/Bob","label":"Bob"}}}`
```

**Injected result (AI input side):**
```
[VisGraph — 2 tools ✓]
`{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"http://example.org/Alice"}]}}`
`{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"http://example.org/Bob"}]}}`

Canvas: 2 nodes (Alice, Bob), 0 links
```

## Implementation Units

- [ ] **Unit 1: Replace bookmarklet parser — JSON-RPC extraction**

**Goal:** Swap `extractAllToolCalls` from TOOL-block regex to JSON-RPC brace-depth scanner.

**Requirements:** R1, R5, R6, R7

**Dependencies:** None

**Files:**
- Modify: `public/relay-bookmarklet.js`

**Approach:**
- Add `extractJsonObjects(text)` — brace-depth scanner that returns balanced
  top-level `{...}` strings. Skips truncated JSON (unbalanced braces at EOF).
- Add `validateMcpRequest(obj)` — checks `jsonrpc === '2.0'`, `method === 'tools/call'`,
  `params.name` is a string.
- Replace body of `extractAllToolCalls(text)` to use these two functions.
- `mcpId` field on returned call objects: `req.id != null ? req.id : null`.
- Prefix-expand each string value in `req.params.arguments`.
- Dedup sig: `tool + ':' + JSON.stringify(params)` (unchanged).
- Update comment block at top of parser section to describe new format.
- Remove the old TOOL-block `stripped.split(/^TOOL:\s*/m)` logic entirely.

**Test scenarios:**
- Happy path: single inline backtick JSON-RPC call extracted correctly
- Happy path: two calls in one message, both extracted in order
- Happy path: `id` is carried through to returned call object
- Happy path: `arguments` values with `ex:` prefix are expanded
- Edge case: truncated JSON (opens `{` never closes) — skipped, no crash
- Edge case: valid JSON but wrong `method` field — skipped by `validateMcpRequest`
- Edge case: valid JSON but no `params.name` — skipped
- Edge case: same call appears twice (streaming re-scan) — dedup set prevents duplicate
- Edge case: call inside markdown code fence (`` ```...``` ``) — still extracted
  because brace scanner works on raw `innerText`

**Verification:**
- Unit tests pass. `extractAllToolCalls` returns zero calls for old TOOL-block text.

---

- [ ] **Unit 2: Replace result formatter — JSON-RPC responses**

**Goal:** `injectCombinedResult` emits backtick-wrapped JSON-RPC response objects.

**Requirements:** R2, R3, R4

**Dependencies:** Unit 1 (needs `mcpId` on batch result items)

**Files:**
- Modify: `public/relay-bookmarklet.js`

**Approach:**
- Add `mcpId` to items pushed into `batchResults` (from `pendingMcpId` which is
  set in `processNextInQueue`).
- In `injectCombinedResult`, after the header line, push one backtick-wrapped
  JSON-RPC response per result:
  - Success: `{"jsonrpc":"2.0","id":<mcpId>,"result":{"content":[{"type":"text","text":"<briefData>"}]}}`
  - Error: `{"jsonrpc":"2.0","id":<mcpId>,"error":{"code":-32000,"message":"<err>","data":{"tool":"<name>"}}}`
- Canvas summary line and SVG follow after a blank line (unchanged position).
- Remove old `✓ tool: ...` / `✗ tool: ...` plain-text lines.

**Test scenarios:**
- Happy path: success result produces correct JSON-RPC `result` object with `id`
- Happy path: error result produces JSON-RPC `error` object with tool name in `data`
- Happy path: header line still present as first line
- Happy path: canvas summary and SVG appear after blank line following response lines
- Edge case: `mcpId` is `null` (AI omitted `id`) — response uses `"id":null`

**Verification:**
- Manual test: run a tool call, inspect injected text in chat input — contains
  backtick JSON-RPC line(s) after the header.

---

- [ ] **Unit 3: Update starter prompt — README and relay-bridge.md**

**Goal:** Replace TOOL-block prompt with JSON-RPC format prompt.

**Requirements:** R8

**Dependencies:** Units 1–2 finalized (so prompt matches implementation)

**Files:**
- Modify: `README.md`
- Modify: `docs/relay-bridge.md`

**Approach:**
- Replace the entire starter prompt code block in both files.
- New prompt structure (adapt from broken branch `docs/relay-bridge.md`):
  - One sentence describing the relay mechanic.
  - OUTPUT FORMAT: one inline backtick JSON-RPC line per call, sequential.
  - Rules: different `id` per call, wait for result, never output calls unintended.
  - Reading results: parse each backtick line as JSON-RPC response; `id` correlates.
  - Common prefix list (unchanged).
  - Fetch `.well-known/mcp.json` for full tool list.
  - Closing prompt question.
- Remove BATCHING RULES, PARAMETER RULES, CLOSING EACH PHASE, KEY WORKFLOW PATTERNS
  sections — these are TOOL-block-specific; JSON-RPC format needs less hand-holding.
- Keep the `.well-known/mcp.json` fetch instruction — it is format-agnostic.
- `README.md` inline prompt and `docs/relay-bridge.md` must match exactly.

**Test scenarios:**
- Test expectation: none — prose/documentation change, no logic.

**Verification:**
- Both files updated. Prompt in README matches docs/relay-bridge.md.
- Troubleshooting table in relay-bridge.md updated: "Tool calls not detected" row
  references JSON-RPC backtick format instead of TOOL blocks.

---

- [ ] **Unit 4: Update unit tests for new parser**

**Goal:** `bookmarklet.extractToolCalls.test.ts` tests the JSON-RPC parser, not the old TOOL-block one.

**Requirements:** R9

**Dependencies:** Unit 1

**Files:**
- Modify: `src/__tests__/relay/bookmarklet.extractToolCalls.test.ts`

**Approach:**
- Replace the replicated `extractAllToolCalls` function inline in the test file with
  the JSON-RPC version (same pattern: replicate, don't import).
- Also replicate `extractJsonObjects` and `validateMcpRequest` since they are helpers.
- Replace all existing test cases with JSON-RPC input strings.
- Test categories: happy path, streaming truncation safety, invalid JSON skip,
  wrong method skip, prefix expansion, dedup.
- Remove all old TOOL-block test cases.

**Patterns to follow:**
- `src/__tests__/relay/bookmarklet.extractToolCalls.test.ts` existing structure
  (describe/it blocks, `beforeEach` to reset seen set).

**Test scenarios:**
- Happy path: well-formed inline backtick call → correct `{tool, params, mcpId}`
- Happy path: two calls → array of two items in order
- Happy path: `id:3` → `mcpId: 3` on returned item
- Edge case: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":` (truncated) → empty result
- Edge case: `{"jsonrpc":"2.0","method":"other/method",...}` → skipped
- Edge case: arguments contain `ex:Alice` → expanded to `http://example.org/Alice`
- Edge case: same JSON twice in text → only one call returned (dedup)
- Edge case: text with no JSON at all → empty array

**Verification:**
- `npm test` passes for this test file with zero old TOOL-block tests remaining.

---

- [ ] **Unit 5: Update relay-mock-chat.html fixture**

**Goal:** Scenario buttons emit JSON-RPC tool calls so manual relay testing works.

**Requirements:** R9

**Dependencies:** Unit 1

**Files:**
- Modify: `public/relay-mock-chat.html`

**Approach:**
- Replace each scenario string's `TOOL: toolName\nparam: value` content with
  inline backtick JSON-RPC lines.
- Keep the same scenarios (addNode, addLink, etc.) — just change the wire format.
- Verify scenario strings are well-formed JSON (brace-balanced).

**Test scenarios:**
- Test expectation: none — HTML fixture, validated visually / by E2E tests.

**Verification:**
- Load fixture locally, click a scenario button, confirm bookmarklet picks it up
  (relay processes it and shows toast).

---

- [ ] **Unit 6: Sync LeftSidebar.tsx minified bookmarklet**

**Goal:** `buildBookmarkletHref()` in `LeftSidebar.tsx` matches updated source.

**Requirements:** R10

**Dependencies:** Units 1–2 finalized

**Files:**
- Modify: `src/components/Canvas/LeftSidebar.tsx`

**Approach:**
- After Units 1–2 are stable, re-minify `public/relay-bookmarklet.js` by hand:
  - Collapse whitespace, shorten local var names where safe, remove comments.
  - The existing minified string in `buildBookmarkletHref()` is the reference for
    the minification style.
- Replace the entire template literal string in `buildBookmarkletHref()`.
- Verify the minified string does NOT contain the old `TOOL:` split logic.

**Test scenarios:**
- Test expectation: none — verified by drag-and-drop bookmarklet test in browser.

**Verification:**
- Drag bookmarklet from sidebar to bookmark bar, click it on an AI chat tab.
  The badge appears and JSON-RPC calls in AI responses are detected.

## System-Wide Impact

- **Prompt change is breaking for existing sessions**: users with the old TOOL-block
  prompt must re-paste the new starter prompt. Document in relay-bridge.md.
- **E2E specs**: `e2e/relay-bookmarklet.real.spec.ts` and `.fhgenie.spec.ts` will
  fail after this lands until updated (deferred).
- **Unchanged**: popup (`relay.html`), BroadcastChannel protocol, MCP tools,
  `isAiStreaming()`, `waitForIdle()`, the focus-injection fix from the previous commit.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| AI models don't reliably write inline backtick JSON | Tested in broken branch — Claude.ai produces it consistently with the prompt. Add examples in prompt. |
| Brace scanner false-positives on non-MCP JSON in chat | `validateMcpRequest` guard filters to `method:"tools/call"` only |
| Minification introduces bugs | Test bookmarklet manually after Unit 6; compare behavior with source version |
| E2E tests fail in CI | Mark them as known-broken in a comment or skip until deferred update lands |

## Sources & References

- Broken branch: `feat/relay-jsonrpc-format` (commit `4b51ac5`)
- Broken branch plan: `docs/plans/2026-04-22-002-feat-relay-mcp-format-e2e-plan.md` (in that branch)
- MCP spec: `public/.well-known/mcp.json`
- Existing relay doc: `docs/relay-bridge.md`
