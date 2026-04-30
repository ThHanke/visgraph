async (page) => {
  // 1. Remove extra model slots until only one remains
  while (true) {
    const removeBtn = await page.$('button[aria-label*="Remove Model"]');
    if (!removeBtn) break;
    await removeBtn.click();
    await page.waitForTimeout(300);
  }

  // 2. Open model selector and pick qwen3:8b
  const modelBtn = await page.$('#model-selector-0-button');
  if (!modelBtn) return { ok: false, error: 'no model-selector-0-button' };
  await modelBtn.click();
  await page.waitForTimeout(400);

  const searchInput = await page.$('input[placeholder*="Search" i], input[placeholder*="search" i]');
  const MODEL = 'qwen3:8b';
  if (searchInput) {
    await searchInput.fill(MODEL);
    await page.waitForTimeout(400);
  }

  const modelBtn2 = await page.$(`button:has-text("${MODEL}"), [data-value*="${MODEL}"]`);
  if (modelBtn2) {
    await modelBtn2.click();
    await page.waitForTimeout(400);
  }

  // 3. Clear the chat-input via PM dispatch (replace with empty)
  const cleared = await page.evaluate(() => {
    const el = document.getElementById('chat-input');
    if (!el) return false;
    const tiptap = el.editor;
    if (tiptap && tiptap.view) {
      const state = tiptap.view.state;
      tiptap.view.dispatch(state.tr.delete(0, state.doc.content.size));
      return true;
    }
    return false;
  });

  return { ok: true, cleared, url: page.url() };
}
