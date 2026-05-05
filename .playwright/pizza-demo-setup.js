/**
 * pizza-demo-setup.js — Bootstrap OWUI relay session for pizza ontology recording
 *
 * Usage: mcp__playwright__browser_run_code_unsafe filename=.playwright/pizza-demo-setup.js
 *
 * Prerequisites:
 *   - Ontosphere running at http://docker-dev.iwm.fraunhofer.de:8080
 *   - OWUI tab already open + authenticated at https://gpuserver1-sit.iwm.fraunhofer.de
 *
 * What it does:
 *   1. fresh-setup: select qwen3:4b, clear input
 *   2. Navigate to OWUI home
 *   3. Type the full README starter prompt (Shift+Enter for newlines) → creates /c/ URL
 *      The starter prompt embeds the relay format + help() call.
 *      The model reads it and calls help() itself — no separate INSTR injection.
 *   4. Inject relay bookmarklet (relay pre-seeds the embedded help() call so it won't
 *      re-execute it; only the model's own help() call in its response is dispatched)
 *   5. Wait for model's help() cycle to complete
 *   6. Inject Socratic starter question (Turn 0) via relay
 *
 * After this script: relay connected, Turn 0 live. Drive with turn-driver.js.
 */

async (page) => {
  const MODEL = 'qwen3:4b';

  const pages = page.context().pages();
  const owuiPage = pages.find(p => p.url().includes('gpuserver1-sit'));
  const vgPage   = pages.find(p => p.url().includes('docker-dev') && !p.url().includes('relay'));
  if (!owuiPage) return { ok: false, error: 'no OWUI tab' };
  if (!vgPage)   return { ok: false, error: 'no Ontosphere tab' };

  // ── 0. Reload Ontosphere to clear any graph state from previous sessions ───
  await vgPage.reload();
  await vgPage.waitForFunction(
    () => typeof window.__mcpTools?.addNode === 'function',
    { timeout: 30_000 },
  );

  // ── 1. fresh-setup ─────────────────────────────────────────────────────────
  await owuiPage.goto('https://gpuserver1-sit.iwm.fraunhofer.de/');
  await owuiPage.waitForTimeout(1500);

  while (true) {
    const btn = await owuiPage.$('button[aria-label*="Remove Model"]');
    if (!btn) break;
    await btn.click();
    await owuiPage.waitForTimeout(300);
  }
  const modelBtn = await owuiPage.$('#model-selector-0-button');
  if (modelBtn) {
    await modelBtn.click();
    await owuiPage.waitForTimeout(400);
    const search = await owuiPage.$('input[placeholder*="Search" i]');
    if (search) { await search.fill(MODEL); await owuiPage.waitForTimeout(400); }
    const pick = await owuiPage.$(`button:has-text("${MODEL}"), [data-value*="${MODEL}"]`);
    if (pick) { await pick.click(); await owuiPage.waitForTimeout(400); }
  }

  // ── 2. Type full README starter prompt — Shift+Enter for newlines ──────────
  // Source of truth: README.md "Starter prompt" section.
  // The embedded help() call (`id:0`) is pre-seeded by the relay on startup so
  // it will NOT be executed. Only the model's own help() call in its response fires.
  const STARTER_LINES = [
    'You are connected to Ontosphere via a relay. A script in this tab intercepts your tool calls, runs them in Ontosphere, and injects results back as a user message. Ask the user what they would like to build.',
    '',
    'Output format — one JSON-RPC 2.0 call per line, backtick-wrapped:',
    '`{"jsonrpc":"2.0","id":<N>,"method":"tools/call","params":{"name":"<toolName>","arguments":{...}}}`',
    '',
    'Call help first to get full instructions and the tool list:',
    '`{"jsonrpc":"2.0","id":0,"method":"tools/call","params":{"name":"help","arguments":{}}}`',
  ];

  const chatInput = await owuiPage.$('#chat-input');
  if (!chatInput) return { ok: false, error: 'no #chat-input' };
  await chatInput.click();
  await owuiPage.waitForTimeout(200);

  for (let i = 0; i < STARTER_LINES.length; i++) {
    if (STARTER_LINES[i]) await owuiPage.keyboard.type(STARTER_LINES[i], { delay: 2 });
    if (i < STARTER_LINES.length - 1) await owuiPage.keyboard.press('Shift+Enter');
  }
  await owuiPage.keyboard.press('Enter');
  await owuiPage.waitForFunction(() => location.pathname.startsWith('/c/'), { timeout: 10000 });
  const chatUrl = owuiPage.url();

  // ── 3. Inject relay (fetch from VG tab, addScriptTag bypasses mixed-content) ─
  const relayCode = await vgPage.evaluate(async () => {
    const r = await fetch('/relay-bookmarklet.js');
    let src = await r.text();
    src = src.replace(/__RELAY_URL__/g,    'http://docker-dev.iwm.fraunhofer.de:8080/relay.html');
    src = src.replace(/__RELAY_ORIGIN__/g, 'http://docker-dev.iwm.fraunhofer.de:8080');
    src = src.replace(/\}\)\(\);\s*$/, [
      '  window.__vgInjectResult = injectResult;',
      '  window.__vgIsStreaming   = isAiStreaming;',
      '  window.__vgWaitForIdle  = waitForIdle;',
      '  window.__vgIsRelayIdle  = function() { return callQueue.length === 0 && !isProcessing; };',
      '})();',
    ].join('\n'));
    return src;
  });
  await owuiPage.addScriptTag({ content: relayCode });
  await owuiPage.waitForTimeout(300);

  // ── 4. Wait for model's help() cycle to complete ──────────────────────────
  // Model reads starter prompt → calls help() itself → relay executes → model
  // reads manifest and responds. Use content-length + relay-idle (same as
  // turn-driver.js) — isAiStreaming() is unreliable in newer OWUI.
  let _lastLen = -1;
  async function isBusy() {
    const state = await owuiPage.evaluate(() => ({
      relayBusy: !(window.__vgIsRelayIdle?.() ?? true),
      len: document.body.innerText?.length ?? 0,
    })).catch(() => ({ relayBusy: false, len: _lastLen }));
    const growing = _lastLen >= 0 && state.len !== _lastLen;
    _lastLen = state.len;
    return state.relayBusy || growing;
  }
  const helpDeadline = Date.now() + 180_000;
  const pollMs = 500;
  let silentMs = 0;
  while (Date.now() < helpDeadline) {
    const busy = await isBusy();
    if (busy) silentMs = 0; else silentMs += pollMs;
    if (silentMs >= 3_000) break;
    await owuiPage.waitForTimeout(pollMs);
  }
  await owuiPage.waitForTimeout(1000);

  // ── 5. Inject Turn 0 — Socratic starter ───────────────────────────────────
  const TURN0 = 'I want to learn OWL ontology concepts through a hands-on example. I will guide you through the pizza domain step by step — one concept at a time. Rule: for each question I ask, model exactly the concept I ask about on the canvas, then stop and wait. Do not add anything beyond what I asked. Do not arrange nodes automatically. Use the ex: prefix for all IRIs (ex: maps to http://example.org/). First question: in OWL, what is the most fundamental building block for representing a concept? Create a single Pizza class — just this one node, nothing more. Wait for my next question.';
  let turn0Ok = false;
  for (let i = 0; i < 8; i++) {
    turn0Ok = await owuiPage.evaluate((text) => window.__vgInjectResult?.(text) ?? false, TURN0);
    if (turn0Ok !== false) break;
    await owuiPage.waitForTimeout(500);
  }

  await owuiPage.waitForTimeout(800);
  const t0btn = await owuiPage.$('#send-message-button:not([disabled])');
  if (t0btn) await t0btn.click();

  return { ok: true, chatUrl, turn0: turn0Ok };
}
