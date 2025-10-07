#!/usr/bin/env node
/**
 * scripts/playwright-startup-debug.cjs
 *
 * Enhanced startup debug runner:
 *  - Determines dev server port from vite.config.ts (fallback 8080)
 *  - Optionally starts the dev server (npm run dev) when invoked with "--start-server"
 *  - Navigates to the app URL, captures console + network events, waits for "idle" period,
 *    and writes playwright-reports/startup-debug.json
 *
 * Usage:
 *   node scripts/playwright-startup-debug.cjs [url] [idleMs] [--start-server]
 *
 * If url is omitted the script will use the port found in vite.config.ts (or 8080 fallback).
 * If --start-server is provided the script will spawn `npm run dev` in a detached background
 * process and wait until the server responds on the chosen URL (max wait 120s).
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
    // naive regex to find "port: <digits>" inside server config
    const m = content.match(/port\s*:\s*(\d{2,5})/);
    if (m && m[1]) return parseInt(m[1], 10);
  } catch (_) { /* ignore */ }
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
  // Parse arguments more flexibly:
  // - any explicit URL (http/https) passed will be used
  // - numeric argument selects idleMs
  // - flags --start-server / -s enable starting the dev server
  const argv = process.argv.slice(2);
  // Start the dev server by default. Provide flags to opt-out:
  //   --no-start-server | --no-server | -n
  const disableStart = argv.includes('--no-start-server') || argv.includes('--no-server') || argv.includes('-n');
  const startServerFlag = !disableStart;
  const idleArg = argv.find(a => /^\d+$/.test(a));
  const idleMs = idleArg ? parseInt(idleArg, 10) : 1500;
  const maybeUrl = argv.find(a => typeof a === 'string' && (a.startsWith('http://') || a.startsWith('https://')));

  // Parse optional test automation flags:
  // --apply-layout=<layoutKey> or --layout=<layoutKey>
  // --view-mode=<abox|tbox>
  const layoutArgRaw = argv.find(a => typeof a === 'string' && (a.startsWith('--apply-layout=') || a.startsWith('--layout=')));
  const layoutKey = layoutArgRaw ? layoutArgRaw.split('=')[1] : null;
  const viewModeArgRaw = argv.find(a => typeof a === 'string' && a.startsWith('--view-mode='));
  const requestedViewMode = viewModeArgRaw ? (viewModeArgRaw.split('=')[1] || null) : null;

  const portFromCfg = detectPortFromViteConfig();
  const defaultUrl = `http://localhost:${portFromCfg}/`;
  const urlRaw = maybeUrl || defaultUrl;

  // When running the startup debug runner with no explicit URL provided, default
  // to loading a representative fixture so the canvas populates deterministically.
  // Do not override an explicit URL (maybeUrl) supplied by the caller.
  const defaultFixture = 'https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/refs/heads/main/LengthMeasurement.ttl';
  let url = urlRaw;
  try {
    if (!maybeUrl && typeof url === 'string' && !url.includes('rdfUrl=')) {
      try {
        const u = new URL(url, 'http://localhost');
        const hasQuery = u.search && u.search.length > 0;
        url = url + (hasQuery ? '&rdfUrl=' + encodeURIComponent(defaultFixture) : '?rdfUrl=' + encodeURIComponent(defaultFixture));
      } catch (_) {
        // fallback if URL parsing fails
        url = url + (url.includes('?') ? '&rdfUrl=' + encodeURIComponent(defaultFixture) : '?rdfUrl=' + encodeURIComponent(defaultFixture));
      }
    }

    // Ensure vg_debug=1 is present when running the startup debug runner so the app
    // auto-enables gated debug output. Do not override an explicit vg_debug param
    // if the caller already provided one.
    if (typeof url === 'string' && !url.includes('vg_debug=')) {
      try {
        const u2 = new URL(url, 'http://localhost');
        const hasQuery2 = u2.search && u2.search.length > 0;
        url = url + (hasQuery2 ? '&vg_debug=1' : '?vg_debug=1');
      } catch (_) {
        // If URL parsing fails (malformed URL), fallback to simple append heuristic
        url = url + (url.includes('?') ? '&vg_debug=1' : '?vg_debug=1');
      }
    }
  } catch (_) { /* ignore */ }

  const outDir = path.join(process.cwd(), 'playwright-reports');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let serverPid = null;
  if (startServerFlag) {
    console.log('Starting dev server (npm run dev)...');
    // Spawn npm run dev in a detached process so it continues after this script exits.
    const child = spawn('npm', ['run', 'dev'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      env: { ...process.env }
    });

    serverPid = child.pid;
    if (serverPid) {
      console.log('Dev server spawned, pid=', serverPid);
    } else {
      console.warn('Failed to obtain dev server pid');
    }

    // Give Vite some time to boot, but also poll the URL to detect readiness
    const ready = await waitForUrl(url, 120000, 500);
    if (!ready) {
      console.warn(`Dev server did not respond on ${url} within timeout. Proceeding to attempt page navigation anyway.`);
    } else {
      console.log(`Dev server is responding at ${url}`);
    }
  }

  const browser = await chromium.launch({ headless: true });
  // Ensure downloads are accepted so programmatic anchor-click downloads are captured by Playwright.
  const context = await browser.newContext({ acceptDownloads: true });

  // If a layout was requested for the test, inject it into localStorage before the page loads
  // so the app boots with a deterministic layout/view-mode for testing.
  if (layoutKey || requestedViewMode) {
    try {
      const injectedConfig = {
        currentLayout: layoutKey || undefined,
        viewMode: requestedViewMode || undefined,
        // keep other fields minimal so the app merges with defaults
        recentLayouts: [],
        recentOntologies: []
      };
      // Escape single quotes to safely embed in the inline script string
      const injectedJson = JSON.stringify(injectedConfig).replace(/'/g, "\\'");
      // Use the string form of addInitScript (Playwright expects a script string or a path)
      await context.addInitScript(`try { localStorage.setItem('ontology-painter-config', '${injectedJson}'); } catch(e) { /* ignore */ }`);
      // Also expose a small window flag derived from the same persisted config so the app can
      // detect a test-directed layout early and apply it programmatically.
      await context.addInitScript(`try { const cfg = localStorage.getItem('ontology-painter-config'); if (cfg) { try { const o = JSON.parse(cfg); if (o && o.currentLayout) { window.__VG_TEST_APPLY_LAYOUT = o.currentLayout; } } catch(_){} } } catch(e) { /* ignore */ }`);
      console.log('Injected persisted config for test:', injectedConfig);
    } catch (e) {
      console.warn('Failed to inject test config into localStorage:', e && e.message ? e.message : e);
    }
  }

  const page = await context.newPage();

  // If we defaulted to using the built-in fixture (when no explicit URL passed),
  // pre-fetch the fixture content so we can load it via the app's file-input
  // handler (simulates a user uploading a file with the fixture content). This
  // ensures the app receives the raw RDF text rather than relying on cross-origin
  // requests from the browser which may be blocked or proxied differently in CI.
  let startupFixtureContent = null;
  try {
    if (!maybeUrl && typeof defaultFixture === 'string' && defaultFixture.length > 0) {
      // Helper to GET text content (uses http/https similar to httpGetStatus).
      const fetchText = (u, timeoutMs = 15000) => new Promise((resolve, reject) => {
        try {
          const parsed = new URL(u);
          const lib = parsed.protocol === 'https:' ? https : http;
          const req = lib.request(parsed, { method: 'GET', timeout: timeoutMs }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => resolve(data));
          });
          req.on('error', (err) => reject(err));
          req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
          req.end();
        } catch (err) { reject(err); }
      });

      try {
        startupFixtureContent = await fetchText(defaultFixture).catch(() => null);
        if (startupFixtureContent) {
          console.log('Pre-fetched startup fixture content (length=' + String(startupFixtureContent.length) + ')');
        } else {
          console.warn('Failed to pre-fetch startup fixture content; will rely on browser fetch via rdfUrl param');
        }
      } catch (err) {
        console.warn('Error fetching startup fixture:', err && err.message ? err.message : err);
        startupFixtureContent = null;
      }
    }
  } catch (e) {
    startupFixtureContent = null;
  }

  const consoleEntries = [];
  const requests = [];
  const requestFinished = [];
  const requestFailed = [];

  let lastEventTs = Date.now();
  const startTs = Date.now();
  // Tracks whether the requested layout was observed to be applied (via debug console).
  // If a --apply-layout flag was provided we will require this to be true and fail the run otherwise.
  let layoutAppliedFlag = false;

  function noteEvent(kind, payload) {
    lastEventTs = Date.now();
    const entry = { ts: new Date().toISOString(), kind, payload };
    consoleEntries.push(entry);
    if (consoleEntries.length > 5000) consoleEntries.shift();
  }

  page.on('console', (msg) => {
    try {
      const text = msg.text ? msg.text() : (msg.args ? msg.args.map(a => String(a)).join(' ') : '');
      noteEvent('console', { type: msg.type(), text });
    } catch (e) {
      noteEvent('console', { type: 'unknown', text: String(e && e.message ? e.message : e) });
    }
  });

  page.on('pageerror', (err) => {
    noteEvent('pageerror', { message: String(err && err.stack ? err.stack : err) });
  });

  page.on('request', (req) => {
    try {
      const info = { url: req.url(), method: req.method(), resourceType: req.resourceType() };
      requests.push({ ts: new Date().toISOString(), ...info });
      noteEvent('request', info);
    } catch (e) {
      noteEvent('request', { url: 'error', message: String(e) });
    }
  });

  page.on('requestfinished', (req) => {
    try {
      const info = { url: req.url() };
      requestFinished.push({ ts: new Date().toISOString(), ...info });
      noteEvent('requestfinished', info);
    } catch (e) {
      noteEvent('requestfinished', { url: 'error', message: String(e) });
    }
  });

  page.on('requestfailed', (req) => {
    try {
      const f = req.failure ? req.failure() : null;
      const info = { url: req.url(), failure: f ? (f.errorText || String(f)) : 'unknown' };
      requestFailed.push({ ts: new Date().toISOString(), ...info });
      noteEvent('requestfailed', info);
    } catch (e) {
      noteEvent('requestfailed', { url: 'error', message: String(e) });
    }
  });

  console.log('Playwright startup debug: navigating to', url);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (e) {
    noteEvent('navigation.error', { message: String(e && e.message ? e.message : e) });
  }

  // If we pre-fetched the startup fixture content, inject it into the app via
  // the "Load Ontology" dialog's Paste RDF workflow so the app processes the
  // raw RDF string exactly as a user would paste-and-load it.
  try {
    if (startupFixtureContent && typeof startupFixtureContent === 'string' && startupFixtureContent.length > 0) {
      try {
        // Open the Load Ontology dialog (button text "Load Ontology")
        try {
          const loadBtn = await page.locator('button:has-text("Load Ontology")').first();
          await loadBtn.waitFor({ state: 'visible', timeout: 5000 });
          await loadBtn.click();
        } catch (_) {
          // Fallback: click any element that contains the text
          try { await page.click('text="Load Ontology"', { timeout: 5000 }); } catch (_) { /* ignore */ }
        }

        // Wait for the paste textarea to appear and set its value
        try {
          await page.waitForSelector('#rdfPaste', { timeout: 5000 });
          await page.fill('#rdfPaste', startupFixtureContent);
          // Click the "Load RDF" button inside the dialog
          const loadRdfBtn = await page.locator('button:has-text("Load RDF")').first();
          await loadRdfBtn.waitFor({ state: 'visible', timeout: 5000 });
          await loadRdfBtn.click();
          console.log('Injected startup fixture via paste-load workflow');
          noteEvent('console', { type: 'info', text: 'startup.fixture.injected_via_paste' });
        } catch (errInner) {
          console.warn('Failed to inject fixture via paste workflow:', errInner && errInner.message ? errInner.message : errInner);
          noteEvent('console', { type: 'warning', text: 'startup.fixture.inject_failed' });
        }
      } catch (err) {
        console.warn('Error while attempting to paste startup fixture:', err && err.message ? err.message : err);
      }
    }
  } catch (_) { /* ignore */ }

  // Ensure the requested layout is applied via UI interaction.
  const startupHasRdfUrl = String(url || '').includes('rdfUrl=');
  if (!startupHasRdfUrl) {
  // The user requested this must be applied (not a fallback) — so we always attempt the UI click sequence.
  try {
    // Wait for the initial canvas build to finish so we apply the requested layout afterwards.
    // The app may apply its configured default layout during startup; applying the test layout
    // must happen after that to ensure it takes effect.
    try {
      await page.waitForEvent('console', {
        timeout: 10000,
        predicate: (msg) => {
          try {
            const t = msg.text ? msg.text() : '';
            return t.includes('canvas.rebuild.end');
          } catch (_) { return false; }
        }
      });
      noteEvent('console', { type: 'info', text: 'ui.layout.apply.waited_for_initial_rebuild' });
    } catch (_) {
      // If no rebuild log observed, proceed anyway after a short delay.
      await page.waitForTimeout(800);
      noteEvent('console', { type: 'warning', text: 'ui.layout.apply.no_initial_rebuild_observed' });
    }

    // Capture a "before" screenshot of the canvas to provide a baseline for debugging layout changes.
    // Saved as playwright-reports/layout-before.png and recorded in consoleEntries via noteEvent.
    let screenshotPathBefore = null;
    try {
      const beforePath = path.join(outDir, 'layout-before.png');
      await page.screenshot({ path: beforePath, fullPage: false });
      screenshotPathBefore = beforePath;
      noteEvent('console', { type: 'info', text: `ui.layout.capture.before ${beforePath}` });
    } catch (e) {
      noteEvent('console', { type: 'warning', text: `ui.layout.capture.before_failed ${String(e && e.message ? e.message : e)}` });
    }

    const layoutToApply = layoutKey || 'force-directed';

    // First try a programmatic hook injected by the app (may be available).
    // Record whether the hook succeeded but always proceed with the UI click sequence
    // because the user requested the UI action must be performed.
    let hookAppliedFlag = false;
    try {
      const hookResult = await page.evaluate(async (l) => {
        try {
          // runtime check for a hook exposed by the app
           
          if (typeof window !== 'undefined' && window.__VG_APPLY_LAYOUT && typeof window.__VG_APPLY_LAYOUT === 'function') {
            return await window.__VG_APPLY_LAYOUT(l);
          }
        } catch (e) {
          // swallow and continue to UI clicks below
        }
        return null;
      }, layoutToApply);

      if (hookResult === true) {
        hookAppliedFlag = true;
        layoutAppliedFlag = true; // record success for enforcement later
        noteEvent('console', { type: 'info', text: `ui.layout.apply.via_hook ${layoutToApply}` });
      } else if (hookResult === false) {
        noteEvent('console', { type: 'warning', text: `ui.layout.apply.hook_reported_failure ${layoutToApply}` });
      }
    } catch (e) {
      noteEvent('console', { type: 'warning', text: `ui.layout.apply.hook_exception ${String(e && e.message ? e.message : e)}` });
    }

    // Map layout keys to human-facing labels that appear in the layout menu.
    const labelMap = {
      'force-directed': ['Force Directed', 'Force-Directed', 'Force directed', 'Force'],
      'layered-digraph': ['Layered Graph', 'Layered-Digraph', 'Layered digraph', 'Layered']
      // add other mappings here if new layout types used
    };

    const candidates = labelMap[layoutToApply] || [layoutToApply];

    // Helper to attempt clicking an element by a Playwright text selector with retries.
    async function clickTextSelectorWithRetries(text, attempts = 3, delayMs = 250) {
      for (let i = 0; i < attempts; i++) {
        try {
          const el = await page.locator(`text=${text}`).first();
          await el.waitFor({ state: 'visible', timeout: 2000 });
          await el.click();
          return true;
        } catch (err) {
          // try alternative: button with text, or small delay then retry
          try {
            const btn = await page.locator(`button:has-text("${text}")`).first();
            await btn.waitFor({ state: 'visible', timeout: 2000 });
            await btn.click();
            return true;
          } catch (_) { /* ignore */ }
        }
        await page.waitForTimeout(delayMs);
      }
      return false;
    }

    // Attempt to open the Layout dropdown/menu. This should be present in the Canvas toolbar.
    let opened = await clickTextSelectorWithRetries('Layout', 4, 300);
    if (!opened) {
      // Try common alternatives for the trigger (icons or aria labels).
      opened = await clickTextSelectorWithRetries('Layout options', 2, 300);
    }
    // If still not opened, attempt to click an element that looks like the dropdown by role.
    if (!opened) {
      try {
        const dropdown = await page.locator('button[aria-haspopup="menu"]').first();
        await dropdown.waitFor({ state: 'visible', timeout: 2000 });
        await dropdown.click();
        opened = true;
      } catch (err) {
        // continue - we will still try to click menu items even if trigger wasn't found
      }
    }

    // Try to click the desired layout menu item using candidate labels.
    let applied = false;
    for (const label of candidates) {
      applied = await clickTextSelectorWithRetries(label, 3, 200);
      if (applied) break;
      // Try looser text match using contains via XPath
      try {
        const xpath = `//button[contains(normalize-space(string(.)), "${label}")] | //div[contains(normalize-space(string(.)), "${label}")]`;
        const el = await page.locator(xpath).first();
        await el.waitFor({ state: 'visible', timeout: 1500 });
        await el.click();
        applied = true;
        break;
      } catch (_) { /* ignore and continue */ }
    }

    // If still not applied, perform a direct DOM click inside the page context.
    // This is more robust for portalled menus or when Playwright locators fail.
    if (!applied) {
      try {
        const clicked = await page.evaluate((labels) => {
          // Search candidate elements likely to contain the menu item text.
          const selectors = ['button', 'div', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]'];
          for (const label of labels) {
            for (const sel of selectors) {
              const elems = Array.from(document.querySelectorAll(sel));
              for (const el of elems) {
                try {
                  const text = (el.textContent || '').trim();
                  if (text && text.indexOf(label) !== -1) {
                    // Attempt a programmatic click if possible.
                    try {
                      if (typeof (el).click === 'function') {
                        el.click();
                        return true;
                      }
                    } catch (_) {
                      // ignore click failures
                    }
                  }
                } catch (_) { /* ignore element */ }
              }
            }
          }
          return false;
        }, candidates);
        applied = !!clicked;
        if (applied) {
          noteEvent('console', { type: 'info', text: `ui.layout.apply.clicked_via_dom ${layoutToApply}` });
        } else {
          noteEvent('console', { type: 'warning', text: `ui.layout.apply.dom_click_failed ${layoutToApply}` });
        }
      } catch (e) {
        noteEvent('console', { type: 'error', text: `ui.layout.apply.dom_click_exception ${String(e && e.message ? e.message : e)}` });
      }
    }

    // If the UI click succeeded, wait for the app to emit the debug console indicating layout applied.
    if (applied) {
      try {
        await page.waitForEvent('console', {
          timeout: 10000,
          predicate: (msg) => {
            try {
              const t = msg.text ? msg.text() : '';
              return t.includes('canvas.layout.apply.completed') && t.includes(layoutToApply);
            } catch (_) { return false; }
          }
        }).then(() => {
          layoutAppliedFlag = true;
          noteEvent('console', { type: 'info', text: `ui.layout.apply.confirmed ${layoutToApply}` });
        });
      } catch (e) {
        // If we don't see the console message in time, still record that we attempted the click.
        noteEvent('console', { type: 'warning', text: `ui.layout.apply.attempted ${layoutToApply} (no confirmation in logs)` });
      }
    } else {
      // If no UI interaction could be performed, record an explicit error so the test run shows failure to apply.
      noteEvent('console', { type: 'error', text: `ui.layout.apply.failed to find menu item for ${layoutToApply}` });
    }
  } catch (err) {
    noteEvent('console', { type: 'error', text: `ui.layout.apply.exception ${String(err && err.message ? err.message : err)}` });
  }

  } // end if (!startupHasRdfUrl)

  const maxWaitMs = 120000;
  const deadline = Date.now() + maxWaitMs;
  let settledTime = null;

  while (Date.now() < deadline) {
    const idleFor = Date.now() - lastEventTs;
    if (idleFor >= idleMs) {
      settledTime = Date.now();
      break;
    }
    await new Promise(r => setTimeout(r, 150));
  }

  // Attempt to capture the global debug summary safely
  let vgSummary = null;
  try {
    vgSummary = await page.evaluate(() => {
      try {
        // avoid TS assertions; this runs in the browser context
        return (window && window.__VG_DEBUG_SUMMARY__) ? window.__VG_DEBUG_SUMMARY__ : null;
      } catch (e) {
        return null;
      }
    });
  } catch (e) {
    vgSummary = null;
  }

  // Capture any html-to-image error recorded by the page's export helper so we can diagnose failures.
  let htmlToImageErr = null;
  try {
    htmlToImageErr = await page.evaluate(() => {
      try { return (window && (window).__VG_HTMLTOIMAGE_LAST_ERROR) ? (window).__VG_HTMLTOIMAGE_LAST_ERROR : null; } catch (e) { return null; }
    });
  } catch (e) {
    htmlToImageErr = null;
  }

  const result = {
    url,
    startTime: new Date(startTs).toISOString(),
    settledTime: settledTime ? new Date(settledTime).toISOString() : null,
    loadDurationMs: settledTime ? (settledTime - startTs) : null,
    consoleEntries,
    requests,
    requestFinished,
    requestFailed,
    vgSummary,
    serverPid: serverPid || null
  };

  const outPath = path.join(outDir, 'startup-debug.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');
  console.log('Playwright startup debug written to', outPath);

  // Attempt to capture a screenshot of the page (canvas) after layout application.
  try {
    const screenshotPath = path.join(outDir, 'layout-applied.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    console.log('Captured screenshot to', screenshotPath);
    // Update the written JSON to include the screenshot path for easy discovery.
    try {
      const updated = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      updated.screenshotPath = screenshotPath;
      fs.writeFileSync(outPath, JSON.stringify(updated, null, 2), 'utf8');
    } catch (err) {
      console.warn('Failed to update JSON with screenshot path:', err && err.message ? err.message : err);
    }
  } catch (e) {
    console.warn('Failed to capture screenshot:', e && e.message ? e.message : e);
  }

  // Attempt programmatic exports (SVG then PNG) via the page's export hooks.
  // Capture downloads if the app emits download events; save into playwright-reports/.
  try {
    const nowId = new Date().toISOString().replace(/[:.]/g, '-');
    let svgExportPath = null;
    let pngExportPath = null;

    // Prefer the app signalling readiness; wait a short while for the export hook(s) to attach.
    try {
      await page.waitForFunction(() => {
        try {
          // Access window in the page context
          // eslint-disable-next-line no-undef
          return (typeof window !== 'undefined') && !!window.__VG_KNOWLEDGE_CANVAS_READY && (typeof window.__VG_EXPORT_SVG_FULL === 'function' || typeof window.__VG_EXPORT_PNG_FULL === 'function');
        } catch (e) { return false; }
      }, { timeout: 10000 }).catch(() => null);
    } catch (_) { /* ignore wait failures - we'll still attempt the exports */ }

    // SVG export via programmatic hook only (minimal). Invoke and save the returned SVG string.
    try {
      const invokeSvgResult = await page.evaluate(async () => {
        try {
          if (typeof window.__VG_EXPORT_SVG_FULL === 'function') {
            return await window.__VG_EXPORT_SVG_FULL();
          }
          return null;
        } catch (e) {
          // return null to indicate failure
          return null;
        }
      });

      if (typeof invokeSvgResult === 'string' && invokeSvgResult.length > 0) {
        const suggested = `visgraph-full-${nowId}.svg`;
        svgExportPath = path.join(outDir, `export-svg-${nowId}-${suggested}`);
        fs.writeFileSync(svgExportPath, invokeSvgResult, 'utf8');
        console.log('Saved SVG export from programmatic return to', svgExportPath);
      } else {
        // Minimal behavior: no fallback — record absence and continue
        console.warn('Programmatic SVG export did not return a string.');
      }
    } catch (err) {
      console.warn('SVG export attempt failed:', err && err.message ? err.message : err);
    }

    // PNG export via programmatic hook (expects data URL: data:image/png;base64,...)
    try {
      const invokePngResult = await page.evaluate(async () => {
        try {
          if (typeof window.__VG_EXPORT_PNG_FULL === 'function') {
            return await window.__VG_EXPORT_PNG_FULL();
          }
          return null;
        } catch (e) {
          return null;
        }
      });

      if (typeof invokePngResult === 'string' && invokePngResult.startsWith('data:image/png')) {
        const base64 = invokePngResult.split(',')[1] || '';
        const buf = Buffer.from(base64, 'base64');
        const suggested = `visgraph-full-${nowId}.png`;
        pngExportPath = path.join(outDir, `export-png-${nowId}-${suggested}`);
        fs.writeFileSync(pngExportPath, buf);
        console.log('Saved PNG export from programmatic return to', pngExportPath);
      } else {
        console.warn('Programmatic PNG export did not return a data URL.');
      }
    } catch (err) {
      console.warn('PNG export attempt failed:', err && err.message ? err.message : err);
    }

    // Annotate the startup JSON with export paths if any
    try {
      const updated = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (svgExportPath) updated.svgExportPath = svgExportPath;
      if (pngExportPath) updated.pngExportPath = pngExportPath;
      fs.writeFileSync(outPath, JSON.stringify(updated, null, 2), 'utf8');
    } catch (err) {
      console.warn('Failed to update startup JSON with export paths:', err && err.message ? err.message : err);
    }
  } catch (_) { /* swallow export errors */ }

  // Enforce layout application if the caller requested a layout.
  if (layoutKey) {
    if (!layoutAppliedFlag) {
      // Write an explicit failure entry to the JSON so it's obvious in CI/artifacts.
      try {
        const updated = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        updated.layoutApplied = false;
        updated.layoutRequested = layoutKey;
        fs.writeFileSync(outPath, JSON.stringify(updated, null, 2), 'utf8');
      } catch (_) { /* ignore */ }
      console.error(`Requested layout "${layoutKey}" was not observed as applied (layoutAppliedFlag=false). Failing run.`);
      // Close browser then exit non-zero to signal test failure.
      process.exit(3);
    } else {
      // Mark success in the JSON
      try {
        const updated = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        updated.layoutApplied = true;
        updated.layoutRequested = layoutKey;
        fs.writeFileSync(outPath, JSON.stringify(updated, null, 2), 'utf8');
      } catch (_) { /* ignore */ }
    }
  }

  
  // If we started the server ourselves, wait a short grace period then attempt to stop it.
  if (serverPid) {
    // Allow caller to configure shutdown delay via env var PLAYWRIGHT_SERVER_SHUTDOWN_MS (ms). Default 10000 ms.
    const shutdownDelayMs = parseInt(process.env.PLAYWRIGHT_SERVER_SHUTDOWN_MS || '10000', 10);

    console.log(`Dev server was started by this script (pid=${serverPid}). Will attempt shutdown in ${shutdownDelayMs} ms.`);
    // Give the server a brief grace period before killing, to allow any final work to complete.
    await new Promise((resolve) => setTimeout(resolve, shutdownDelayMs));

    try {
      // First attempt a gentle SIGTERM
      process.kill(serverPid, 'SIGTERM');
      console.log(`Sent SIGTERM to dev server pid=${serverPid}. Waiting 2s for exit.`);
      // Wait up to 2s for process to exit
      await new Promise((resolve) => setTimeout(resolve, 2000));
      try {
        // Check if process still exists
        process.kill(serverPid, 0);
        // Still running — escalate to SIGKILL
        process.kill(serverPid, 'SIGKILL');
        console.log(`Dev server pid=${serverPid} did not exit; sent SIGKILL.`);
      } catch (checkErr) {
        // Process no longer exists
        console.log(`Dev server pid=${serverPid} has exited.`);
      }
    } catch (err) {
      console.warn(`Failed to kill dev server pid=${serverPid}:`, err && (err.stack || err.message) ? (err.stack || err.message) : err);
    }
  }

  process.exit(0);
}

run().catch(err => {
  console.error('playwright-startup-debug failed:', err && err.stack ? err.stack : err);
  process.exit(2);
});
