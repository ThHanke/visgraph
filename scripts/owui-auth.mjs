/**
 * Login to OpenWebUI and save Playwright auth state.
 *
 * Credentials come exclusively from env vars — never from CLI args or files.
 * The output file (.playwright/owui-auth.json) is gitignored.
 *
 * Usage:
 *   OWUI_URL=https://...  OWUI_EMAIL=user@example.com  OWUI_PASSWORD=secret \
 *   node scripts/owui-auth.mjs
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OWUI_URL = process.env.OWUI_URL;
const EMAIL    = process.env.OWUI_EMAIL;
const PASSWORD = process.env.OWUI_PASSWORD;

if (!OWUI_URL || !EMAIL || !PASSWORD) {
  console.error('Missing env vars: OWUI_URL, OWUI_EMAIL, OWUI_PASSWORD');
  process.exit(1);
}

const OUT = path.resolve(__dirname, '../.playwright/owui-auth.json');

async function main() {
  const browser = await chromium.launch({
    args: ['--ignore-certificate-errors'],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page    = await context.newPage();

  console.log(`Logging in to ${OWUI_URL} …`);
  await page.goto(`${OWUI_URL}/auth`);

  await page.fill('input[placeholder*="Email"], input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button:has-text("Sign in")');
  await page.waitForURL(`${OWUI_URL}/`, { timeout: 20_000 });

  console.log('Login OK. Saving auth state…');
  const state = await context.storageState();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(state, null, 2));
  console.log(`Saved → ${OUT}`);

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
