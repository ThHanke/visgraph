#!/usr/bin/env node
/**
 * scripts/playwright-startup-autoload.cjs
 *
 * Lightweight Playwright runner tuned for "autoload additional ontologies" verification.
 * - Injects persistedAutoload=true into localStorage before page load
 * - Loads the demo RDF via rdfUrl query param (if none provided)
 * - Waits for canvas rebuild and layout application console logs
 * - Captures a screenshot and writes a JSON report into playwright-reports/
 *
 * Usage:
 *   node scripts/playwright-startup-autoload.cjs [url] [idleMs] [--start-server] [--autoload]
 *
 * The script is intentionally small and DOES NOT perform UI clicks.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');

function detectPortFromViteConfig() {
  try {
    const cfgPath = path.join(process.cwd(), 'vite.config.ts');
    if (!fs.existsSync(cfgPath)) return 8080;
    const content = fs.readFileSync(cfgPath, 'utf8');
    const m = content.match(/port\s*:\s*(\d{2,5})/);
    if (m && m[1]) return parseInt(m[1], 10);
  } catch (_) {}
  return 8080;
}

function httpGetStatus(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, { method: 'GET', timeout: timeoutMs }, (res) => {
        resolve({ ok: true, status: res.statusCode || 0 });
        res.resume();
      });
      req.on('error', () => resolve({ ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false }); });
      req.end();
    } catch (e) {
      resolve({ ok: false });
    }
  });
}

async function waitForUrl(url, timeoutMs = 120000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await httpGetStatus(url, Math.min(3000, intervalMs));
    if (r.ok) return true;
    await new Promise((r2) => setTimeout(r2, intervalMs));
  }
  return false;
}

async function run() {
  const argv = process.argv.slice(2);
  const disableStart = argv.includes('--no-start-server') || argv.includes('--no-server') || argv.includes('-n');
  const startServerFlag = !disableStart;
  const idleArg = argv.find(a => /^\d+$/.test(a));
  const idleMs = idleArg ? parseInt(idleArg, 10) : 1500;
  const maybeUrl = argv.find(a => typeof a === 'string' && (a.startsWith('http://') || a.startsWith('https://')));
  const autoloadArgRaw = argv.find(a => typeof a === 'string' && (a === '--persisted-autoload' || a === '--autoload'));
  const autoloadFlag = !!autoloadArgRaw;

  const portFromCfg = detectPortFromViteConfig();
  const defaultUrlBase = `http://localhost:${portFromCfg}/`;
  const defaultFixture = 'https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/refs/heads/main/LengthMeasurement.ttl';

  // Build final URL: if caller provided a URL use it; otherwise include rdfUrl and vg_debug
  let url = maybeUrl || defaultUrlBase;
  try {
    if (!maybeUrl) {
      url = url + (url.includes('?') ? '&' : '?') + 'rdfUrl=' + encodeURIComponent(defaultFixture);
    }
    if (!url.includes('vg_debug=')) {
      url = url + (url.includes('?') ? '&' : '?') + 'vg_debug=1';
    }
  } catch (_) {}

  const outDir = path.join(process.cwd(), 'playwright-reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let serverPid = null;
  if (startServerFlag) {
    console.log('Starting dev server (npm run dev)...');
    const child = spawn('npm', ['run', 'dev'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      env: { ...process.env }
    });
    serverPid = child.pid;
    if (serverPid) console.log('Dev server spawned, pid=', serverPid);
    const ready = await waitForUrl(url, 120000, 500);
    if (!ready) console.warn(`Dev server did not respond on ${url} within timeout.`);
    else console.log(`Dev server is responding at ${url}`);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });

  // Inject persisted config to enable autoload (if requested)
  if (autoloadFlag) {
    try {
      const injectedConfig = {
        persistedAutoload: true
      };
      const injectedJson = JSON.stringify(injectedConfig).replace(/'/g, "\\'");
      await context.addInitScript(`try { const prev = JSON.parse(localStorage.getItem('ontology-painter-config') || '{}'); const merged = Object.assign({}, prev, ${JSON.stringify(injectedConfig)}); localStorage.setItem('ontology-painter-config', JSON.stringify(merged)); } catch(e) { /* ignore */ }`);
      console.log('Injected persisted-autoload into localStorage for test');
    } catch (e) {
      console.warn('Failed to inject autoload config:', e && e.message ? e.message : e);
    }
  }

  const page = await context.newPage();

  const consoleEntries = [];
  function noteEntry(kind, payload) {
    consoleEntries.push({ ts: new Date().toISOString(), kind, payload });
    if (consoleEntries.length > 5000) consoleEntries.shift();
  }

  page.on('console', (msg) => {
    try {
      const text = msg.text ? msg.text() : '';
      noteEntry('console', { type: msg.type(), text });
    } catch (e) { noteEntry('console', { type: 'error', text: String(e) }); }
  });
  page.on('request', (r) => noteEntry('request', { url: r.url(), method: r.method(), resourceType: r.resourceType() }));
  page.on('requestfinished', (r) => noteEntry('requestfinished', { url: r.url() }));
  page.on('requestfailed', (r) => noteEntry('requestfailed', { url: r.url(), failure: (r.failure && r.failure().errorText) || 'unknown' }));

  console.log('Navigating to', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => noteEntry('navigation.error', { message: String(e) }));

  // Wait for initial mapping finished marker then for layout apply completed
  // We will wait up to 30s total for the sequence.
  const start = Date.now();
  let sawRebuild = false;
  let sawLayout = false;
  while (Date.now() - start < 30000) {
    // Inspect consoleEntries for markers
    for (const e of consoleEntries.slice()) {
      try {
        if (!sawRebuild && e.kind === 'console' && typeof e.payload.text === 'string' && e.payload.text.includes('canvas.rebuild.end')) sawRebuild = true;
        if (!sawLayout && e.kind === 'console' && typeof e.payload.text === 'string' && e.payload.text.includes('canvas.layout.apply.completed')) sawLayout = true;
      } catch (_) {}
    }
    if (sawRebuild && sawLayout) break;
    await new Promise(r => setTimeout(r, 250));
  }

  // Capture screenshot after waiting
  const screenshotPath = path.join(outDir, 'layout-autoload.png');
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log('Captured screenshot to', screenshotPath);
  } catch (e) {
    console.warn('Screenshot failed:', e && e.message ? e.message : e);
  }

  // Build result JSON
  const result = {
    url,
    startTime: new Date().toISOString(),
    sawRebuild,
    sawLayout,
    consoleEntries,
    screenshotPath,
    serverPid: serverPid || null
  };
  fs.writeFileSync(path.join(outDir, 'startup-debug-autoload.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log('Wrote report playwright-reports/startup-debug-autoload.json');

  await browser.close();

  if (serverPid) {
    const shutdownDelayMs = parseInt(process.env.PLAYWRIGHT_SERVER_SHUTDOWN_MS || '2000', 10);
    await new Promise((r) => setTimeout(r, shutdownDelayMs));
    try {
      process.kill(serverPid, 'SIGTERM');
    } catch (_) {}
  }

  process.exit(0);
}

run().catch(err => {
  console.error('playwright-startup-autoload failed:', err && err.stack ? err.stack : err);
  process.exit(2);
});
