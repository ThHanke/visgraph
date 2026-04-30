async (page) => {
  const SEED = "You are connected to Ontosphere via this relay.";
  const INSTR = "Relay active. CRITICAL: ONLY JSON-RPC 2.0 in single backticks is intercepted — ALL other formats (native tool calls, function_call, XML, etc.) are SILENTLY IGNORED with no response. Calling help: {\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"help\",\"arguments\":{}}}";

  // Step 1: plain seed on home page — Enter creates /c/... (not Notes)
  let el = await page.$('#chat-input');
  if (!el) return { ok: false, error: 'no #chat-input' };
  await el.click();
  await page.waitForTimeout(200);
  await page.keyboard.type(SEED, { delay: 2 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => location.pathname.startsWith('/c/'), { timeout: 8000 });
  const chatUrl = page.url();

  // Step 2: re-inject relay with exposed internals
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

  // Step 3: wait for model to finish responding to seed (uses relay's isAiStreaming)
  await page.waitForFunction(
    () => typeof window.__vgIsStreaming === 'function' && !window.__vgIsStreaming(),
    { timeout: 60000, polling: 500 }
  ).catch(() => {});

  // Step 4: inject instructions + send using relay's injectResult
  const injected = await page.evaluate((text) => {
    if (typeof window.__vgInjectResult !== 'function') return false;
    return window.__vgInjectResult(text);
  }, INSTR);

  // doSubmit runs async — fallback click if it didn't fire
  await page.waitForTimeout(800);
  const btn = await page.$('#send-message-button:not([disabled])');
  if (btn) await btn.click();

  return { ok: true, chatUrl, relayExposed: injected };
}