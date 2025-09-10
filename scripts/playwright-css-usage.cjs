#!/usr/bin/env node

/**
 * scripts/playwright-css-usage.cjs
 *
 * CommonJS version of the Playwright runner to start the dev server,
 * detect its URL from stdout, launch a headless Chromium, wait until no
 * console logs are emitted for 2s, collect classes and stylesheet contents,
 * and save a JSON report to ./playwright-reports/css-usage-report.json
 *
 * Usage:
 *   node scripts/playwright-css-usage.cjs
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

async function waitForUrlFromStdout(child, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const urlRegex = /(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+(?:\/?))/i;
    const localLineRegex = /(Local|localhost|Network).*?(https?:\/\/[^\s]+)/i;
    let stdoutBuffer = '';
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Timed out waiting for dev server URL in stdout'));
      }
    }, timeout);

    function tryParse(line) {
      let m = urlRegex.exec(line);
      if (m && m[1]) return m[1];
      m = localLineRegex.exec(line);
      if (m && m[2]) return m[2];
      return null;
    }

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdoutBuffer += text;
      const parts = stdoutBuffer.split(/\r?\n/).slice(-10);
      for (const p of parts) {
        const u = tryParse(p);
        if (u) {
          clearTimeout(timer);
          if (!resolved) {
            resolved = true;
            resolve(u);
          }
          return;
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      const u = tryParse(text);
      if (u && !resolved) {
        clearTimeout(timer);
        resolved = true;
        resolve(u);
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        clearTimeout(timer);
        resolved = true;
        reject(new Error('Dev server exited prematurely with code ' + code));
      }
    });
  });
}

async function run() {
  const outDir = path.join(process.cwd(), 'playwright-reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  console.log('Starting dev server (npm run dev)...');
  const dev = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'dev'], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  dev.stdout.pipe(process.stdout);
  dev.stderr.pipe(process.stderr);

  let url;
  try {
    url = await waitForUrlFromStdout(dev, 30000);
    console.log('Detected dev server url:', url);
  } catch (err) {
    console.error('Failed to detect dev server URL:', err);
    dev.kill();
    process.exit(1);
  }

  // Launch Playwright
  let pw;
  try {
    pw = require('playwright');
  } catch (err) {
    console.error('Playwright is not installed. Install with: npm i -D playwright');
    dev.kill();
    process.exit(1);
  }

  const browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // Capture console messages and forward to our stdout + keep timestamp
  let lastConsoleTs = Date.now();
  page.on('console', (msg) => {
    try {
      console.log(`[page][console][${msg.type()}] ${msg.text()}`);
    } catch (e) {
      console.log('[page][console] (error reading message)');
    }
    lastConsoleTs = Date.now();
  });

  page.on('pageerror', (err) => {
    console.error('[page][error]', err && (err.stack || err.message || String(err)));
    lastConsoleTs = Date.now();
  });

  console.log('Opening page:', url);
  await page.goto(url, { waitUntil: 'load', timeout: 60000 });

  const consoleEntries = [];
  page.on('console', (msg) => {
    consoleEntries.push({ type: msg.type(), text: msg.text(), ts: Date.now() });
  });

  const QUIET_MS = 2000;
  const MAX_RUN_MS = 120000;
  const started = Date.now();
  console.log(`Now waiting until no new console logs for ${QUIET_MS}ms (max ${MAX_RUN_MS}ms total)...`);

  await new Promise((resolve) => {
    const interval = setInterval(() => {
      const age = Date.now() - lastConsoleTs;
      if (age >= QUIET_MS) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - started > MAX_RUN_MS) {
        clearInterval(interval);
        resolve();
      }
    }, 200);
  });

  console.log('No console logs seen for the quiet period. Collecting CSS usage data...');

  const report = await page.evaluate(async () => {
    function collectClasses() {
      const elems = Array.from(document.querySelectorAll('[class]'));
      const classSet = new Set();
      elems.forEach((el) => {
        const classAttr = el.getAttribute('class') || '';
        classAttr
          .split(/\s+/)
          .map((c) => c.trim())
          .filter(Boolean)
          .forEach((c) => classSet.add(c));
      });
      return Array.from(classSet).sort();
    }

    function getStyleSheetHrefs() {
      const sheets = Array.from(document.styleSheets || []);
      return sheets
        .map((s) => (s && s.href ? s.href : null))
        .filter(Boolean);
    }

    const classes = collectClasses();
    const styleSheetHrefs = getStyleSheetHrefs();

    const propsOfInterest = [
      'display', 'position', 'top', 'left', 'right', 'bottom',
      'width', 'height', 'margin', 'margin-top', 'margin-right',
      'margin-bottom', 'margin-left', 'padding', 'padding-top',
      'padding-right', 'padding-bottom', 'padding-left', 'color',
      'background-color', 'font-size', 'font-weight', 'line-height',
      'opacity', 'visibility', 'border', 'border-top', 'border-right',
      'border-bottom', 'border-left', 'flex', 'grid-template-columns',
      'grid-template-rows',
    ];

    const report = {};

    classes.forEach((cls) => {
      const el = Array.from(document.querySelectorAll('[class]')).find((n) => Array.from(n.classList).includes(cls));
      const computed = {};
      if (el) {
        const cs = window.getComputedStyle(el);
        propsOfInterest.forEach((p) => {
          const v = cs.getPropertyValue(p);
          if (v && v !== '') computed[p] = v;
        });
      }
      report[cls] = {
        sampleTag: el ? el.tagName.toLowerCase() : null,
        computed,
      };
    });

    const cssFiles = {};
    for (const href of styleSheetHrefs) {
      try {
        const r = await fetch(href, { mode: 'cors' });
        if (r.ok) {
          const txt = await r.text();
          cssFiles[href] = txt;
        } else {
          cssFiles[href] = null;
        }
      } catch (e) {
        cssFiles[href] = null;
      }
    }

    return {
      url: location.href,
      classes,
      cssFiles,
      consoleEntries: window.__collectedConsoleEntries || null,
    };
  });

  const outPath = path.join(outDir, 'css-usage-report.json');
  fs.writeFileSync(outPath, JSON.stringify({ timestamp: new Date().toISOString(), url, consoleEntries, report }, null, 2), 'utf8');
  console.log('Report written to', outPath);

  try {
    await browser.close();
  } catch (e) {}

  try {
    if (dev && !dev.killed) {
      dev.kill();
    }
  } catch (e) {}

  console.log('Done.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Fatal error in script:', err && (err.stack || err.message || String(err)));
  process.exit(2);
});
