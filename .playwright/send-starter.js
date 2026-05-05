async (page) => {
  // Canonical starter prompt — must match README.md "Starter prompt" section (plain-text line only, no backticks).
  const SEED = "You are connected to Ontosphere via a relay. A script in this tab intercepts your tool calls, runs them in Ontosphere, and injects results back as a user message. Ask the user what they would like to build.";

  // INSTR: compact format reminder + pizza task inline.
  // No help() call — avoids multi-thousand-word explanation that truncates.
  // "Respond with ONLY tool calls" keeps response short.
  const INSTR = [
    'RELAY FORMAT — single backtick only. ALL other formats silently ignored (no error, no response):',
    '`{"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":"TOOL_NAME","arguments":{...}}}`',
    'WRONG (silently ignored): ```json{...}```  or  {"tool":"x","params":{}}  or  {"method":"addNode",...}',
    'Respond only with backtick-wrapped JSON-RPC 2.0 calls. No prose.',
  ].join('\n');

  // Step 1: plain seed — creates /c/ URL (no backticks = no Notes routing)
  const el = await page.$('#chat-input');
  if (!el) return { ok: false, error: 'no #chat-input' };
  await el.click();
  await page.waitForTimeout(200);
  await page.keyboard.type(SEED, { delay: 2 });
  console.log('[INJECT][SEED]', SEED);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.pathname.startsWith('/c/'), { timeout: 8000 });
  const chatUrl = page.url();

  // Step 2: inject relay with exposed internals
  const pages = page.context().pages();
  const vgPage = pages.find(p => p.url().includes('docker-dev'));
  if (!vgPage) return { ok: false, error: 'no Ontosphere tab', chatUrl };
  const code = await vgPage.evaluate(async () => {
    const r = await fetch('/relay-bookmarklet.js');
    let src = await r.text();
    src = src.replace(/__RELAY_URL__/g, 'http://docker-dev.iwm.fraunhofer.de:8080/relay.html');
    src = src.replace(/__RELAY_ORIGIN__/g, 'http://docker-dev.iwm.fraunhofer.de:8080');
    src = src.replace(/\}\)\(\);\s*$/, [
      '  window.__vgInjectResult = injectResult;',
      '  window.__vgIsStreaming   = isAiStreaming;',
      '  window.__vgWaitForIdle  = waitForIdle;',
      '})();'
    ].join('\n'));
    return src;
  });
  await page.addScriptTag({ content: code });

  // Step 3: wait for seed response via relay __vgIsStreaming poll
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => window.__vgIsStreaming?.() ?? false);
    if (!s) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(500);
  console.log('[QWEN][SEED] idle');

  // Step 4: inject INSTR+task (contains backticks — OK now we're on /c/)
  console.log('[INJECT][INSTR]', INSTR.slice(0, 120));
  const injected = await page.evaluate((text) => {
    if (typeof window.__vgInjectResult !== 'function') return false;
    return window.__vgInjectResult(text);
  }, INSTR);

  await page.waitForTimeout(800);
  const btn = await page.$('#send-message-button:not([disabled])');
  if (btn) await btn.click();

  return { ok: true, chatUrl, relayExposed: injected };
}
