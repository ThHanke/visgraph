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
 *   3. Send plain-text seed → creates /c/ URL
 *   4. Inject relay bookmarklet (via Ontosphere tab, bypasses mixed-content)
 *   5. Wait for seed idle
 *   6. Inject format INSTR (format + key tools, NO task embedded)
 *   7. Wait for INSTR idle
 *   8. Inject Socratic starter question (Turn 0)
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
  const cleared = await owuiPage.evaluate(() => {
    const el = document.getElementById('chat-input');
    const tp = el?.editor;
    if (tp?.view) { const s = tp.view.state; tp.view.dispatch(s.tr.delete(0, s.doc.content.size)); return true; }
    return false;
  });

  // ── 2. Send seed (plain text, no backticks → stays on /c/ not /notes/) ─────
  const SEED = 'You control Ontosphere knowledge graph editor via this relay.';
  const el = await owuiPage.$('#chat-input');
  if (!el) return { ok: false, error: 'no #chat-input' };
  await el.click();
  await owuiPage.waitForTimeout(200);
  await owuiPage.keyboard.type(SEED, { delay: 2 });
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
      '})();',
    ].join('\n'));
    return src;
  });
  await owuiPage.addScriptTag({ content: relayCode });
  await owuiPage.waitForTimeout(300);

  // ── 4. Wait for seed idle ──────────────────────────────────────────────────
  const deadline1 = Date.now() + 120_000;
  while (Date.now() < deadline1) {
    if (!(await owuiPage.evaluate(() => window.__vgIsStreaming?.() ?? false))) break;
    await owuiPage.waitForTimeout(1000);
  }
  await owuiPage.waitForTimeout(500);

  // ── 5. Inject INSTR — format only, no embedded task ───────────────────────
  //    injectInProgress stays true during trySubmit loop so Turn 0 can't jump
  //    the queue. We wait for flag to clear before injecting Turn 0.
  const INSTR = [
    'RELAY FORMAT — single backtick JSON-RPC 2.0 only. ALL other formats silently ignored:',
    '`{"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":"TOOL","arguments":{...}}}`',
    'WRONG (silently ignored): triple-backtick, <tool_call>, {"tool":"x",...}',
    '',
    'Key tools and signatures:',
    '  addNode(iri, typeIri?, label?)          — add entity to graph',
    '  addLink(subjectIri, predicateIri, objectIri) — add triple',
    '  runLayout(algorithm)                    — dagre-tb | elk-layered | dagre-lr',
    '  getNodeDetails(iri)                     — inspect entity properties',
    '',
    'Useful IRIs:',
    '  owl:Class     = http://www.w3.org/2002/07/owl#Class',
    '  rdfs:subClassOf = http://www.w3.org/2000/01/rdf-schema#subClassOf',
    '  ex:           = http://www.pizza-ontology.com/pizza.owl#',
    '',
    'Respond with ONLY backtick-wrapped calls. No prose.',
  ].join('\n');

  const instrInjected = await owuiPage.evaluate((text) => {
    return typeof window.__vgInjectResult === 'function' ? window.__vgInjectResult(text) : false;
  }, INSTR);

  await owuiPage.waitForTimeout(800);
  const instrBtn = await owuiPage.$('#send-message-button:not([disabled])');
  if (instrBtn) await instrBtn.click();

  // ── 6. Wait for INSTR idle, then let injectInProgress reset ───────────────
  const deadline2 = Date.now() + 120_000;
  while (Date.now() < deadline2) {
    if (!(await owuiPage.evaluate(() => window.__vgIsStreaming?.() ?? false))) break;
    await owuiPage.waitForTimeout(1000);
  }
  // injectInProgress resets to false once trySubmit sees editor cleared.
  // Give it 1s to settle before Turn 0.
  await owuiPage.waitForTimeout(1000);

  // ── 7. Inject Turn 0 — Socratic starter ───────────────────────────────────
  const TURN0 = 'Can you teach me how ontologies work using pizzas as a real-world example? Start by adding the most fundamental concept to the graph.';
  let turn0Ok = false;
  for (let i = 0; i < 8; i++) {
    turn0Ok = await owuiPage.evaluate((text) => window.__vgInjectResult?.(text) ?? false, TURN0);
    if (turn0Ok !== false) break;
    await owuiPage.waitForTimeout(500);
  }

  await owuiPage.waitForTimeout(800);
  const t0btn = await owuiPage.$('#send-message-button:not([disabled])');
  if (t0btn) await t0btn.click();

  return { ok: true, cleared, chatUrl, instrInjected, turn0: turn0Ok };
}
