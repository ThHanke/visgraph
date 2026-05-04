async (page) => {
  const TASK = "Build a pizza ontology. Add these three OWL classes:\n- Pizza (IRI: http://www.pizza-ontology.com/pizza.owl#Pizza)\n- PizzaBase (IRI: http://www.pizza-ontology.com/pizza.owl#PizzaBase)\n- PizzaTopping (IRI: http://www.pizza-ontology.com/pizza.owl#PizzaTopping)\n\nAll typeIri: http://www.w3.org/2002/07/owl#Class. After all three are added, run a layered layout with spacing 200.";

  // Wait for model idle using rating buttons — more reliable than __vgIsStreaming for qwen3.
  await page.waitForSelector('button[aria-label="Good Response"]', { timeout: 120000 })
    .catch(() => {});
  // Extra guard: wait for __vgIsStreaming if available
  await page.waitForFunction(
    () => typeof window.__vgIsStreaming !== 'function' || !window.__vgIsStreaming(),
    { timeout: 30000, polling: 500 }
  ).catch(() => {});
  await page.waitForTimeout(500);

  const reply = await page.evaluate(() => {
    const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
    return msgs[msgs.length - 1]?.innerText?.slice(0, 400) ?? '';
  });
  console.log('[QWEN][RESPONSE]', reply.replace(/\n+/g, ' '));

  const toolMsgs = await page.evaluate(() => {
    const msgs = document.querySelectorAll('[data-message-author-role="user"]');
    return [...msgs].filter(m => m.innerText?.includes('[Ontosphere')).map(m => m.innerText?.slice(0, 200));
  });
  toolMsgs.forEach(t => console.log('[TOOL]', t.replace(/\n+/g, ' ')));

  console.log('[INJECT][TASK]', TASK.slice(0, 120));
  const injected = await page.evaluate((text) => {
    if (typeof window.__vgInjectResult !== 'function') return false;
    return window.__vgInjectResult(text);
  }, TASK);

  await page.waitForTimeout(800);
  const btn = await page.$('#send-message-button:not([disabled])');
  if (btn) await btn.click();

  return { ok: true, injected };
}
