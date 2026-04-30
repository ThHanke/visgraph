---
title: OWUI Relay — Fire-on-Idle Dispatch Replaces MutationObserver
date: 2026-04-30
category: docs/solutions/architecture-patterns/
module: owui-relay
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - Building or extending the OWUI relay bookmarklet
  - AI chat UI has thinking models (qwen3, o1, deepseek-r1) with long generation gaps
  - Relay must extract tool calls from complete AI responses, not mid-stream fragments
tags: [owui-relay, fire-on-idle, mutationobserver, thinking-models, dispatch, streaming-detection]
---

# OWUI Relay — Fire-on-Idle Dispatch Replaces MutationObserver

## Context

The OWUI relay bookmarklet bridges Open WebUI ↔ Ontosphere via BroadcastChannel. It intercepts
single-backtick JSON-RPC 2.0 tool calls from AI responses and dispatches them to Ontosphere.

The original architecture used a `MutationObserver` that fired on every DOM mutation. This worked
for basic models but broke catastrophically with thinking models (qwen3, deepseek-r1): the observer
fired mid-`<think>` block, injected tool results before the complete response was visible, and
corrupted conversation state — responses echoed OWUI message UUIDs, tool call sequences were
interrupted, and context was lost.

## Guidance

Replace the MutationObserver dispatch trigger with a **fire-on-idle poll**: wait until
`isAiStreaming()` returns false (model fully stopped), then read the complete page text, extract
all tool calls at once (deduplicating via `dispatchedSigs`), and execute them in order.

```js
/* ── Fire-on-idle poll ─────────────────────────────────────────── */
var lastIdleText = '';
var idlePollTimer = null;

function idlePoll() {
  if (window.__vgRelayInstanceId !== instanceId) return; // stale instance
  if (!isAiStreaming() && !isProcessing && callQueue.length === 0) {
    var text = document.body.innerText || document.body.textContent || '';
    if (text !== lastIdleText) {
      lastIdleText = text;
      var calls = extractAllToolCalls(text, dispatchedSigs);
      if (calls.length > 0) {
        callQueue = callQueue.concat(calls);
        processNextInQueue();
      }
    }
  }
  idlePollTimer = setTimeout(idlePoll, 500);
}

// Pre-seed dispatchedSigs so INSTR examples on the page don't re-fire
extractAllToolCalls(document.body.innerText || '', dispatchedSigs);
lastIdleText = document.body.innerText || '';

idlePoll();
window.__vgRelayObserver = { disconnect: function () {
  clearTimeout(idlePollTimer); idlePollTimer = null;
} };
```

`isAiStreaming()` uses a 4-signal approach (no chat-UI-specific selectors):
1. `aria-disabled`/`aria-busy` on input ancestors (textarea UIs)
2. Visible spinner/animation elements (class name heuristics)
3. Visible stop/abort button with matching text or aria-label
4. DOM mutation rate fallback: `STREAM_QUIET_MS = 4000ms` of quiet = done

## Why This Matters

MutationObserver fires on every DOM mutation — including every streamed token. For thinking
models, there can be thousands of mutations during a `<think>` block. Dispatching mid-think:
- Injects tool results before the model has finished reasoning
- Can cause the model to echo the injected OWUI message UUID in its output
- Results in tool calls never being extracted from the actual (post-think) response

Fire-on-idle reads the COMPLETE response exactly once per turn. Combined with `dispatchedSigs`
deduplication, this is idempotent and safe across multi-turn conversations.

## When to Apply

- Any relay targeting an AI chat UI that might use thinking/reasoning models
- Whenever the relay needs to extract structured output (tool calls) from complete AI responses
- When the relay must handle multi-turn conversations without re-dispatching previous calls

## Examples

**Before (broken for thinking models):**
```
DOM mutation → MutationObserver fires → partial text parsed → tool called mid-think
→ model still generating → injected result corrupts context → UUID echo in next response
```

**After (fire-on-idle):**
```
Model generates (think + response) → DOM quiet 4s → isAiStreaming()=false →
idlePoll() reads complete page text → extractAllToolCalls deduplicates →
all new calls queued → executed in order → results injected → model confirms
```

**Testing protocol (OWUI + Playwright MCP):**

1. Send plain-text SEED (no backticks) → wait for `/c/` URL (avoids Notes routing)
2. Inject relay bookmarklet from Ontosphere tab (`vgPage.evaluate` + `addScriptTag`)
3. Wait for `button[aria-label="Good Response"]` — appears only after COMPLETE response
   (not `__vgIsStreaming()` which gives false negatives during thinking gaps)
4. Inject INSTR+task — compact format (no `help()` call), WRONG/RIGHT examples inline
5. Use `mistral-small3.1` for test runs (no thinking blocks → faster iteration)

**INSTR format that works:**
```
RELAY FORMAT — single backtick only. ALL other formats silently ignored:
`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"TOOL","arguments":{...}}}`
WRONG: ```json{...}```  or  {"tool":"x","params":{}}  or  {"method":"addNode",...}
RIGHT: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"ex:Foo","typeIri":"owl:Class"}}}`
```

The INSTR must embed the task inline (no `help()` call) — `help()` returns ~5000 chars which
hits OWUI's output token limit and triggers "Continue Response" truncation.

## Related

- `public/relay-bookmarklet.js` — the implementation
- `.playwright/send-starter.js` — the test harness (seed → relay inject → INSTR)
- `.playwright/fresh-setup.js` — model selection (default: qwen3:8b; switch to mistral-small3.1 for testing)
- Auto memory: `project_owui_relay_fire_on_idle.md`, `feedback_owui_session_flow.md`
