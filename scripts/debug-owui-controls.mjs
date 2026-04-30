/**
 * Quick debug: open OWUI, navigate to new chat, click Controls, screenshot.
 * Reads auth state from .playwright/owui-auth.json
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OWUI_URL = process.env.OWUI_URL || 'https://gpuserver1-sit.iwm.fraunhofer.de';
const AUTH_FILE = path.resolve(__dirname, '../.playwright/owui-auth.json');
const OUT_DIR   = path.resolve(__dirname, '../.playwright/debug-screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function shot(page, name) {
  const p = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`  📸 ${name} → ${p}`);
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-web-security', '--ignore-certificate-errors'],
  });
  const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  const context = await browser.newContext({ ignoreHTTPSErrors: true, storageState: state });
  const page = await context.newPage();

  console.log('→ navigate to OWUI new chat…');
  await page.goto(`${OWUI_URL}/`);
  await page.waitForTimeout(3000);
  await shot(page, '01-home');

  // Click Controls button
  console.log('→ clicking Controls…');
  const controlsBtn = page.locator('button[aria-label*="Controls" i]').first();
  await controlsBtn.click();
  await page.waitForTimeout(1500);
  await shot(page, '02-controls-open');

  // Snapshot accessibility tree
  const snap = await page.accessibility.snapshot();
  const snapPath = path.join(OUT_DIR, 'a11y-snapshot.json');
  fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2));
  console.log(`  🌲 a11y snapshot → ${snapPath}`);

  // Inspect modal & buttons
  const modalBtns = await page.locator('div.modal button').all();
  console.log(`  modal buttons count: ${modalBtns.length}`);
  for (let i = 0; i < Math.min(5, modalBtns.length); i++) {
    const txt = await modalBtns[i].textContent();
    const lbl = await modalBtns[i].getAttribute('aria-label');
    console.log(`    [${i}] text="${txt?.trim()}" aria-label="${lbl}"`);
  }

  // Look for system prompt textarea
  const sysField = page.locator([
    '#system-prompt-input',
    'textarea[placeholder*="system" i]',
    'textarea[id*="system" i]',
  ].join(', ')).first();
  const sysCount = await sysField.count();
  console.log(`  system prompt field found: ${sysCount > 0}`);
  if (sysCount > 0) {
    const tag  = await sysField.evaluate(el => el.tagName.toLowerCase());
    const phld = await sysField.getAttribute('placeholder');
    console.log(`    tag=${tag}  placeholder="${phld}"`);
  }

  // Fill system prompt
  if (sysCount > 0) {
    await sysField.click();
    await sysField.fill('DEBUG TEST');
    await page.waitForTimeout(500);
    await shot(page, '03-prompt-filled');
  }

  // Try closing via first modal button (the ✕)
  if (modalBtns.length > 0) {
    console.log('→ clicking first modal button (✕ close)…');
    await modalBtns[0].click();
    await page.waitForTimeout(800);
    await shot(page, '04-after-close');
  }

  await browser.close();
  console.log('Done. Check .playwright/debug-screenshots/');
}
main().catch(e => { console.error(e); process.exit(1); });
