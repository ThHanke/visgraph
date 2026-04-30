# OWUI Relay Session Guide

How to run an interactive OpenWebUI ↔ Ontosphere relay session using the Playwright MCP browser.

---

## What the relay is

The bookmarklet (`public/relay-bookmarklet.js`) bridges an OpenWebUI chat tab and the Ontosphere app tab inside the **same browser process**. It works via `BroadcastChannel`:

```
OWUI chat output
  → MutationObserver watches for backtick-wrapped JSON-RPC
  → relay parses & forwards via BroadcastChannel("vg-relay")
  → Ontosphere tab receives, executes MCP tool, returns result
  → relay injects [Ontosphere — N tools ✓] back into OWUI input
  → doSubmit fires, model sees the result
```

Key constraint: **BroadcastChannel is scoped to a single browser origin and process.** Everything must happen inside the same MCP browser instance. No Node.js scripts outside it.

---

## Prerequisites

1. **Ontosphere running** at `http://docker-dev.iwm.fraunhofer.de:8080` (use docker-dev, not localhost — relay popup needs same origin for BroadcastChannel to work across tabs).

2. **Auth cookie** saved at `.playwright/owui-auth.json`. Refresh if expired:
   ```bash
   OWUI_URL=https://gpuserver1-sit.iwm.fraunhofer.de \
   OWUI_EMAIL=agent@example.de \
   OWUI_PASSWORD=peter123 \
   npm run demo:owui:auth
   ```

3. **MCP browser** open (Playwright MCP tools active in session).

---

## Startup sequence

### Tab 0 — Ontosphere

```
browser_navigate → http://docker-dev.iwm.fraunhofer.de:8080
browser_wait_for → window.__mcpTools?.addNode
```

### Tab 1 — OpenWebUI

Open new tab, navigate to OWUI, inject auth cookie (httpOnly — must use `context.addCookies`, not `document.cookie`):

```js
// inject-auth snippet (see .playwright/owui-auth-inject.js)
const state = JSON.parse(fs.readFileSync('.playwright/owui-auth.json'));
await context.addCookies(state.cookies);
await page.goto('https://gpuserver1-sit.iwm.fraunhofer.de');
```

### Run fresh-setup.js

Selects qwen3:8b and clears any prior input.

### Run send-starter.js

Does everything in one shot:
1. Types plain-text seed on `/` → Enter → navigates to `/c/...` (no backticks = no Notes routing)
2. Fetches `/relay-bookmarklet.js` from Ontosphere tab, patches URLs, exposes internals
3. Waits for model to finish responding to seed via `__vgIsStreaming`
4. Injects format instructions + `help({})` call via `__vgInjectResult`
5. Fallback-clicks `#send-message-button` if doSubmit didn't auto-fire

After this step, the model has received `help()` output and knows the JSON-RPC format.

### Run send-pizza.js (or send-task.js for custom tasks)

Waits for model idle, then injects the task prompt. Model should now use JSON-RPC format.

---

## Relay globals after inject

After `send-starter.js` runs, these are available on the OWUI tab (`Tab 1`):

| Global | Description |
|--------|-------------|
| `window.__vgInjectResult(text)` | Set TipTap content + auto-submit |
| `window.__vgIsStreaming()` | `true` if model is still generating |
| `window.__vgWaitForIdle(container, cb)` | Poll until DOM stable + not streaming |

---

## Format enforcement

**All non-JSON-RPC formats are silently ignored.** No error, no response, nothing. This affects:
- OpenAI `function_call` / `tool_calls`
- Claude `tool_use` blocks
- Gemini `functionCall`
- `{"tool":"x","input":{}}` style
- `<tool_call>` XML tags
- Plain prose describing a tool call

The `help()` output and `send-starter.js` INSTR both state this explicitly. If the model uses its native tool format, inject a correction:

```
The relay only intercepts JSON-RPC 2.0 in single backticks. Your last response used [native format] which was silently ignored. Please retry using:
`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"...","arguments":{...}}}`
```

---

## Known model quirks

### qwen3:8b thinking phase

qwen3 emits a long `<think>...</think>` block before its response. The relay's `isAiStreaming()` uses spinner/stop-button detection — it correctly waits for the full response including thinking to finish before checking. Do not inject during the thinking phase.

### Format override

After receiving `help()` output, most models switch to JSON-RPC. If they revert to native format, the `help()` result itself contains the explicit warning. Re-send the INSTR via `__vgInjectResult`.

---

## Custom investigation tasks

Use `send-task.js` as a generic wrapper. Example from Playwright MCP:

```js
// In browser_evaluate on Tab 1 (OWUI):
const TASK = "Investigate the foaf:Person class hierarchy. Load the FOAF ontology, show all subclasses, run a layered layout, and export the SVG.";
await page.waitForFunction(
  () => typeof window.__vgIsStreaming === 'function' && !window.__vgIsStreaming(),
  { timeout: 60000, polling: 500 }
).catch(() => {});
const injected = await page.evaluate((text) => window.__vgInjectResult(text), TASK);
await page.waitForTimeout(800);
const btn = await page.$('#send-message-button:not([disabled])');
if (btn) await btn.click();
```

Or load `.playwright/send-task.js` directly and pass your TASK string.

---

## Debug checklist

| Symptom | Fix |
|---------|-----|
| Content stuck in input, not submitted | `doSubmit` async race — `btn.click()` fallback handles it |
| Model outputs native tool call, no `[Ontosphere` result | Silent-ignore; inject a correction message explaining JSON-RPC only |
| Injection during think phase, model echoes UUID | `isAiStreaming()` stops-button check prevents this; verify relay re-injected correctly |
| `__vgInjectResult` undefined | Relay not injected yet; re-run `send-starter.js` |
| BroadcastChannel not reaching Ontosphere | Wrong origin — must use docker-dev URL (not localhost) in Tab 0 |
| Relay popup blocked | OWUI tab must have `allow-popups` sandbox flag; the stage HTML has it |
| MCP browser locked "already in use" | `ps aux \| grep mcp-chrome` → `kill <PID>` |

---

## Playwright scripts reference

| Script | Purpose |
|--------|---------|
| `.playwright/fresh-setup.js` | Select model, clear input |
| `.playwright/send-starter.js` | Full session bootstrap (seed → relay inject → help call) |
| `.playwright/send-task.js` | Generic task injection wrapper |
| `.playwright/send-pizza.js` | Pizza ontology task (thin wrapper over send-task pattern) |
| `.playwright/owui-auth-inject.js` | Inject saved auth cookie into context |
