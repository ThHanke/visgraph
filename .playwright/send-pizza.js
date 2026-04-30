async (page) => {
  const TASK = "Build a pizza ontology. Add these three OWL classes:\n- Pizza (IRI: http://www.pizza-ontology.com/pizza.owl#Pizza)\n- PizzaBase (IRI: http://www.pizza-ontology.com/pizza.owl#PizzaBase)\n- PizzaTopping (IRI: http://www.pizza-ontology.com/pizza.owl#PizzaTopping)\n\nAll typeIri: http://www.w3.org/2002/07/owl#Class. After all three are added, run a layered layout with spacing 200.";

  await page.waitForFunction(
    () => typeof window.__vgIsStreaming === 'function' && !window.__vgIsStreaming(),
    { timeout: 60000, polling: 500 }
  ).catch(() => {});

  const injected = await page.evaluate((text) => {
    if (typeof window.__vgInjectResult !== 'function') return false;
    return window.__vgInjectResult(text);
  }, TASK);

  await page.waitForTimeout(800);
  const btn = await page.$('#send-message-button:not([disabled])');
  if (btn) await btn.click();

  return { ok: true, injected };
}
