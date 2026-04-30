async (page) => {
  const fs = await import('node:fs');
  const state = JSON.parse(fs.readFileSync('/home/hanke/ontosphere/.playwright/owui-auth.json', 'utf8'));
  const token = state.cookies?.find(c => c.name === 'token')?.value;
  if (!token) return { ok: false, error: 'no token' };
  await page.evaluate((t) => { document.cookie = `token=${t}; path=/`; }, token);
  await page.reload();
  await page.waitForLoadState('networkidle');
  const loggedIn = await page.evaluate(() => !!document.cookie.includes('token'));
  return { ok: loggedIn, url: page.url() };
}
