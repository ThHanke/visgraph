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

## Startup sequence — two-tab (proven, interactive sessions)

**This is the primary approach.** OWUI and Ontosphere each run in their own tab — no iframes, no route interception, no streaming issues.

### Tab 0 — Ontosphere

```text
browser_navigate → http://docker-dev.iwm.fraunhofer.de:8080
browser_wait_for → window.__mcpTools?.addNode
```

### Tab 1 — OpenWebUI

Open new tab, navigate to OWUI, inject auth cookie (httpOnly — must use `context.addCookies`, not `document.cookie`):

```js
// see .playwright/owui-auth-inject.js
const fs = require('fs');
const auth = JSON.parse(fs.readFileSync('.playwright/owui-auth.json', 'utf8'));
await page.context().addCookies(auth.cookies);
await page.goto('https://gpuserver1-sit.iwm.fraunhofer.de');
```

### Run fresh-setup.js (on Tab 1)

Selects `qwen3:4b` and clears any prior input. **Note:** script hardcodes `qwen3:4b-instruct` — verify model is selected before continuing, or select manually via the dropdown.

### Run send-starter.js (on Tab 1)

Does everything in one shot:
1. Types plain-text seed → Enter → navigates to `/c/` (no backticks = no Notes routing)
2. Fetches `relay-bookmarklet.js` from Ontosphere tab, patches URLs, exposes `__vgInjectResult` / `__vgIsStreaming` / `__vgWaitForIdle`
3. Polls `__vgIsStreaming()` until false (relay-only idle detection — no `waitForSelector`)
4. Injects relay format reminder via `__vgInjectResult`
5. Fallback-clicks `#send-message-button` if relay auto-submit didn't fire

### Wait for INSTR response, then run send-pizza.js (on Tab 1)

Poll `__vgIsStreaming()` until false, then run send-pizza.js to inject the pizza task.

**Idle poll pattern (relay-only):**
```js
const deadline = Date.now() + 600_000;
while (Date.now() < deadline) {
  if (!await page.evaluate(() => window.__vgIsStreaming())) break;
  await page.waitForTimeout(1000);
}
```

---

## Demo recording approach — iframe stage (pizza-demo-setup.js)

**Use this only for screen-recorded demos.** Loads OWUI and Ontosphere side-by-side in iframes at 1920×1080. Has known constraints vs. the two-tab approach:

- Requires `context.route()` to strip `X-Frame-Options` from OWUI HTML responses
- **Route handler must skip `/api/` and `/socket.io`** — buffering SSE breaks LLM streaming
- No `/no_think` prefix on the seed — causes qwen3 to output `{}` (empty JSON error)
- Requires auth cookie injection at context level before navigation

Run as inline `code=` in `browser_run_code_unsafe` (vm sandbox has no `require`/`fs`):
1. Read token: `.playwright/owui-auth.json → cookies[0].value`
2. Paste token value over `PASTE_TOKEN_HERE` in the script
3. Paste full script as `code=` into `browser_run_code_unsafe`

After `{ ok: true }`: recording view active, relay connected, Turn 1 dispatched.

### Side-by-side stage URL

```text
http://docker-dev.iwm.fraunhofer.de:8080/demo-stage-owui.html
  ?owui=https://gpuserver1-sit.iwm.fraunhofer.de/
  &app=http://docker-dev.iwm.fraunhofer.de:8080/
```

---

## Manual startup sequence (without the setup scripts)

### Step 1: Auth + route setup

In `browser_run_code_unsafe`:
```js
const fs = require('fs');
const auth = JSON.parse(fs.readFileSync('/home/hanke/ontosphere/.playwright/owui-auth.json', 'utf8'));
const tok = auth.cookies.find(c => c.name === 'token');
await page.context().addCookies([{ ...tok, domain: 'gpuserver1-sit.iwm.fraunhofer.de' }]);
await page.context().route('https://gpuserver1-sit.iwm.fraunhofer.de/**', async route => {
  try {
    const r = await route.fetch();
    const h = { ...r.headers() };
    delete h['x-frame-options']; delete h['content-security-policy'];
    await route.fulfill({ response: r, headers: h });
  } catch { await route.continue(); }
});
```

### Step 2: Navigate to stage, wait for frames

```js
await page.goto('http://docker-dev.iwm.fraunhofer.de:8080/demo-stage-owui.html?owui=...&app=...');
await page.setViewportSize({ width: 1920, height: 1080 });
// Find frames:
const appFrame = page.frames().find(f => f.url().startsWith('http://docker-dev') && !f.url().includes('demo-stage'));
const owuiFrame = page.frames().find(f => f.url().startsWith('https://gpuserver1-sit'));
```

### Step 3: Inject relay

```js
const relayCode = await appFrame.evaluate(async () => {
  let src = await (await fetch('/relay-bookmarklet.js')).text();
  src = src.replace(/__RELAY_URL__/g, 'http://docker-dev.iwm.fraunhofer.de:8080/relay.html');
  src = src.replace(/__RELAY_ORIGIN__/g, 'http://docker-dev.iwm.fraunhofer.de:8080');
  src = src.replace(/\}\)\(\);\s*$/, '  window.__vgInjectResult = injectResult;\n  window.__vgIsStreaming = isAiStreaming;\n})();');
  return src;
});
await owuiFrame.addScriptTag({ content: relayCode });
```

### Step 4: Inject a turn

```js
await owuiFrame.evaluate((text) => window.__vgInjectResult(text), 'your turn text here');
// Fallback if auto-submit didn't fire:
const btn = await owuiFrame.$('#send-message-button:not([disabled])');
if (btn) await btn.click();
```

---

## Relay globals after inject

After injection, these are available on the OWUI frame:

| Global | Description |
|--------|-------------|
| `window.__vgInjectResult(text)` | Set TipTap content + auto-submit |
| `window.__vgIsStreaming()` | `true` if model is still generating |
| `window.__vgWaitForIdle(container, cb)` | Poll until DOM stable + not streaming |

---

## Driving turns: turn-driver.js

After setup, each subsequent turn uses `.playwright/turn-driver.js` as a template (paste inline, fill `CAPTION` and `NEXT_TURN`):

```js
// Key pattern — substitute CAPTION and NEXT_TURN per turn:
const chatFL = page.frameLocator('#chat-frame');
const appFrame = () => page.frames().find(f =>
  f.url().startsWith('http://docker-dev.iwm.fraunhofer.de:8080') && !f.url().includes('demo-stage'));

// 1. Wait for model done
await chatFL.locator('button[aria-label="Good Response"]').last()
  .waitFor({ state: 'visible', timeout: 180000 });

// 2. Set caption on Ontosphere canvas
await appFrame()?.evaluate((text) => {
  let el = document.getElementById('__demo_caption');
  if (!el) { el = document.createElement('div'); el.id = '__demo_caption'; /* style... */ document.body.appendChild(el); }
  el.textContent = text;
}, 'Your caption here');

// 3. Inject next turn via relay globals
await chatFL.evaluate((text) => window.__vgInjectResult(text), 'Next turn text');
await page.waitForTimeout(800);
await chatFL.locator('#send-message-button:not([disabled])').click().catch(() => {});
```

Note: use `chatFL.evaluate()` (FrameLocator evaluate), **not** `owuiFrame.evaluate()` — cross-origin iframes need frameLocator to reach the correct JS context.

---

## Format enforcement

**All non-JSON-RPC formats are silently ignored.** No error, no response, nothing. This affects:
- OpenAI `function_call` / `tool_calls`
- Claude `tool_use` blocks
- Gemini `functionCall`
- `{"tool":"x","input":{}}` style
- `<tool_call>` XML tags
- Triple-backtick JSON blocks
- Plain prose describing a tool call

The INSTR injected by `pizza-demo-setup.js` states this explicitly. If the model uses its native tool format, inject a correction:

```
The relay only intercepts JSON-RPC 2.0 in single backticks. Your last response used [native format] which was silently ignored. Please retry using:
`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"...","arguments":{...}}}`
```

---

## Known model quirks

### qwen3 thinking phase

qwen3 emits a long `<think>...</think>` block before its response. The relay's `isAiStreaming()` uses spinner/stop-button detection — it correctly waits for the full response including thinking to finish before checking. Do not inject during the thinking phase.

### Format reversion

After receiving the INSTR, most models switch to JSON-RPC. If they revert to native format, re-inject the INSTR via `__vgInjectResult`.

---

## Automated Playwright recording (alternative)

For headless automated recording without MCP, use the existing spec and config:

```bash
# Requires OWUI to be accessible and auth cookie saved
OWUI_URL=https://gpuserver1-sit.iwm.fraunhofer.de \
npm run demo:owui:video
# or directly:
xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24' \
  npx playwright test e2e/demo-openwebui-socratic.spec.ts \
    --config=playwright.openwebui.config.ts
```

This runs headless (via xvfb) with Playwright's built-in video recording (`video: mode: 'on'` in `playwright.openwebui.config.ts`). Output: `test-results/demo-openwebui/`.

The `pizza-demo-setup.js` approach is for **interactive MCP sessions** (live relay, manual turn injection). The Playwright spec is for **automated recordings** of fixed scenarios.

---

## Debug checklist

| Symptom | Fix |
|---------|-----|
| `{ ok: false, error: 'OWUI frame not found' }` | X-Frame-Options not stripped — check `context.route()` was added before navigation |
| Content goes to `/notes/` instead of `/c/` | `fill()` used instead of `pressSequentially` + `Enter` |
| `__vgInjectResult` undefined | `addScriptTag` failed or relay code fetch returned 404 — check Ontosphere is running |
| Content injected but not submitted | Fallback `sendBtn.click()` should handle this; verify button selector |
| Model outputs native tool call, no `[Ontosphere` result | Silent-ignore; inject correction message |
| Injection during think phase, model echoes UUID | `isAiStreaming()` stop-button check prevents this; verify relay waited for idle |
| Canvas empty after addNode succeeds | addNode adds OWL classes to TBox — switch to TBox view: `__mcpTools.setViewMode({mode:'tbox'})` |
| Same tool calls silently skipped on re-inject | `dispatchedSigs` deduplication — start a new chat to reset (fresh page = fresh relay instance) |
| INSTR example fires as real tool call | `RIGHT:` example contained live backtick JSON-RPC — use `TOOL_NAME`/`N` placeholders, never real IRIs |
| BroadcastChannel not reaching Ontosphere | Wrong origin — stage `app=` param must use docker-dev URL (not localhost) |
| Relay popup blocked | Stage HTML sets `allow-popups-to-escape-sandbox` on OWUI iframe — check it's present |
| MCP browser locked "already in use" | `ps aux \| grep mcp-chrome` → `kill <PID>` |

---

## Playwright scripts reference

| Script | Purpose |
|--------|---------|
| `.playwright/pizza-demo-setup.js` | **One-shot setup**: stage nav, auth, model, seed, relay inject, Turn 1. Run as inline code (no `filename=` — vm sandbox has no fs access). |
| `.playwright/turn-driver.js` | Template for each subsequent turn: wait idle → caption → inject next |
| `.playwright/inject-relay.js` | Relay-only injection (no seed, no model setup) |
| `.playwright/fresh-setup.js` | Select model, clear input (OWUI tab must already be open) |
| `.playwright/send-starter.js` | Seed + relay inject for tab-based (non-stage) sessions |
| `.playwright/send-task.js` | Generic task injection wrapper |
| `.playwright/send-pizza.js` | Pizza ontology task (thin wrapper over send-task pattern) |
| `.playwright/owui-auth-inject.js` | Inject saved auth cookie into context |
