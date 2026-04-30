async (page, TASK) => {
  // Generic task injection — waits for model idle, injects TASK via relay, fallback-clicks send.
  // TASK: string — the message to send. Caller sets this before passing to page.evaluate or
  //       when using directly:  node -e "require('./.playwright/send-task.js')"  (not typical).
  // Typical usage from a thin wrapper:
  //   const sendTask = await fs.readFile('.playwright/send-task.js', 'utf8');
  //   await page.evaluate(new Function('page', sendTask), TASK);

  // Wait for model idle — rating buttons are reliable for qwen3 (no false negatives during think phase)
  await page.waitForSelector('button[aria-label="Good Response"]', { timeout: 120000 }).catch(() => {});
  await page.waitForFunction(
    () => typeof window.__vgIsStreaming !== 'function' || !window.__vgIsStreaming(),
    { timeout: 30000, polling: 500 }
  ).catch(() => {});
  await page.waitForTimeout(500);

  const injected = await page.evaluate((text) => {
    if (typeof window.__vgInjectResult !== 'function') return false;
    return window.__vgInjectResult(text);
  }, TASK);

  // doSubmit is async — fallback click if it didn't fire
  await page.waitForTimeout(800);
  const btn = await page.$('#send-message-button:not([disabled])');
  if (btn) await btn.click();

  return { ok: true, injected };
}
