async (page) => {
  const SEED = "You control Ontosphere knowledge graph editor via this relay.";

  // INSTR: compact format reminder + pizza task inline.
  // No help() call — avoids multi-thousand-word explanation that truncates.
  // "Respond with ONLY tool calls" keeps response short.
  const INSTR = [
    'RELAY FORMAT — single backtick only. ALL other formats silently ignored (no error, no response):',
    '`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"TOOL","arguments":{...}}}`',
    'WRONG (silently ignored): ```json{...}```  or  {"tool":"x","params":{}}  or  {"method":"addNode",...}',
    'RIGHT: `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"ex:Foo","typeIri":"owl:Class"}}}`',
    '',
    'TASK — respond with ONLY the 4 backtick calls below, no explanation:',
    'Add 3 OWL classes (typeIri=http://www.w3.org/2002/07/owl#Class) then runLayout:',
    '  Pizza     IRI: http://www.pizza-ontology.com/pizza.owl#Pizza',
    '  PizzaBase IRI: http://www.pizza-ontology.com/pizza.owl#PizzaBase',
    '  PizzaTopping IRI: http://www.pizza-ontology.com/pizza.owl#PizzaTopping',
    'runLayout: algorithm=dagre-lr, spacing=200',
  ].join('\n');

  // Step 1: plain seed — creates /c/ URL (no backticks = no Notes routing)
  const el = await page.$('#chat-input');
  if (!el) return { ok: false, error: 'no #chat-input' };
  await el.click();
  await page.waitForTimeout(200);
  await page.keyboard.type(SEED, { delay: 2 });
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

  // Step 3: wait for seed response via Good Response button
  // (more reliable than __vgIsStreaming for qwen3 long think gaps)
  await page.waitForSelector('button[aria-label="Good Response"]', { timeout: 120000 })
    .catch(() => {});
  await page.waitForTimeout(500);

  // Step 4: inject INSTR+task (contains backticks — OK now we're on /c/)
  const injected = await page.evaluate((text) => {
    if (typeof window.__vgInjectResult !== 'function') return false;
    return window.__vgInjectResult(text);
  }, INSTR);

  await page.waitForTimeout(800);
  const btn = await page.$('#send-message-button:not([disabled])');
  if (btn) await btn.click();

  return { ok: true, chatUrl, relayExposed: injected };
}
