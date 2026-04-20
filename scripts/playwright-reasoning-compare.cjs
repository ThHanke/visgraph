#!/usr/bin/env node
/**
 * scripts/playwright-reasoning-compare.cjs
 *
 * Playwright script that:
 *  1. Loads reasoning-demo.ttl via rdfUrl query param
 *  2. Waits for the canvas to fully render
 *  3. Exports "before" SVG via window.__VG_EXPORT_SVG_FULL()
 *  4. Clicks the "Run reasoning" button (run 1)
 *  5. Waits for the canvas to re-render
 *  6. Exports "after-run1" SVG
 *  7. Clicks the "Run reasoning" button again (run 2)
 *  8. Waits for the canvas to re-render
 *  9. Exports "after-run2" SVG
 * 10. Saves all SVGs + HTML + comparison JSON report to playwright-reports/reasoning/
 *
 * Usage:
 *   node scripts/playwright-reasoning-compare.cjs [--no-start-server] [--idle <ms>]
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');

// ── helpers ────────────────────────────────────────────────────────────────

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
    } catch (_) {
      resolve({ ok: false });
    }
  });
}

async function waitForUrl(url, timeoutMs = 120000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await httpGetStatus(url, Math.min(3000, intervalMs));
    if (r.ok) return true;
    await new Promise((r2) => setTimeout(r2, intervalMs));
  }
  return false;
}

/** Wait for [Pipeline] Clustering complete in console entries (indicates canvas render finished). */
async function waitForCanvasReady(consoleEntries, timeoutMs = 45000, fromIndex = 0) {
  const start = Date.now();
  let sawPipeline = false;
  while (Date.now() - start < timeoutMs) {
    for (const e of consoleEntries.slice(fromIndex)) {
      try {
        if (!sawPipeline && e.kind === 'console' && typeof e.payload?.text === 'string' &&
            e.payload.text.includes('[Pipeline] Clustering complete')) {
          sawPipeline = true;
        }
      } catch (_) {}
    }
    if (sawPipeline) return { sawPipeline };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { sawPipeline };
}

/**
 * Simple SVG comparison:
 *  - element count (rough node/edge count from <g> elements)
 *  - presence of stroke-dasharray (inferred/dashed edges)
 *  - total character length delta
 */
function compareSvgs(beforeSvg, afterSvg) {
  const countPattern = (svg, pattern) => (svg.match(pattern) || []).length;

  const beforeEdges = countPattern(beforeSvg, /class="[^"]*react-flow__edge[^"]*"/g);
  const afterEdges = countPattern(afterSvg, /class="[^"]*react-flow__edge[^"]*"/g);

  const beforeDashed = countPattern(beforeSvg, /stroke-dasharray/g);
  const afterDashed = countPattern(afterSvg, /stroke-dasharray/g);

  const beforeNodes = countPattern(beforeSvg, /class="[^"]*react-flow__node[^"]*"/g);
  const afterNodes = countPattern(afterSvg, /class="[^"]*react-flow__node[^"]*"/g);

  const beforeInferredClass = countPattern(beforeSvg, /vg-edge--inferred/g);
  const afterInferredClass = countPattern(afterSvg, /vg-edge--inferred/g);

  return {
    before: {
      svgLength: beforeSvg.length,
      edgeElements: beforeEdges,
      nodeElements: beforeNodes,
      dashedElements: beforeDashed,
      inferredEdgeClass: beforeInferredClass,
    },
    after: {
      svgLength: afterSvg.length,
      edgeElements: afterEdges,
      nodeElements: afterNodes,
      dashedElements: afterDashed,
      inferredEdgeClass: afterInferredClass,
    },
    delta: {
      svgLength: afterSvg.length - beforeSvg.length,
      edgeElements: afterEdges - beforeEdges,
      nodeElements: afterNodes - beforeNodes,
      dashedElements: afterDashed - beforeDashed,
      inferredEdgeClass: afterInferredClass - beforeInferredClass,
    },
    inferredEdgesAdded: afterDashed > beforeDashed || afterInferredClass > beforeInferredClass,
  };
}

/** Export the inner HTML of the react-flow canvas viewport */
async function exportCanvasHtml(page) {
  try {
    return await page.evaluate(() => {
      const viewport = document.querySelector('.react-flow__viewport');
      return viewport ? viewport.outerHTML : '';
    });
  } catch (e) {
    return '';
  }
}

/** Expand all clusters and fit view, then wait for nodes to settle */
async function expandAllAndWait(page, settleMs = 1500) {
  try {
    const hasExpand = await page.evaluate(() => typeof window.__VG_EXPAND_ALL === 'function');
    if (hasExpand) {
      await page.evaluate(() => window.__VG_EXPAND_ALL());
      console.log('Called window.__VG_EXPAND_ALL()');
      await new Promise((r) => setTimeout(r, settleMs));
    } else {
      console.warn('window.__VG_EXPAND_ALL not found — skipping expand');
    }
    const hasFit = await page.evaluate(() => typeof window.__VG_FIT_VIEW === 'function');
    if (hasFit) {
      await page.evaluate(() => window.__VG_FIT_VIEW());
      console.log('Called window.__VG_FIT_VIEW()');
      await new Promise((r) => setTimeout(r, 400));
    }
  } catch (e) {
    console.warn('expandAllAndWait failed:', e && e.message ? e.message : e);
  }
}

async function clickReasoningButton(page, label) {
  try {
    const btn = await page.$('[aria-label="Run reasoning"]');
    if (!btn) throw new Error('Button [aria-label="Run reasoning"] not found in DOM');
    await btn.click();
    console.log(`Clicked "Run reasoning" button (${label})`);
    return true;
  } catch (e) {
    console.error(`Failed to click reasoning button (${label}):`, e && e.message ? e.message : e);
    return false;
  }
}

function printComparison(label, comparison) {
  console.log(`\n── SVG Comparison: ${label} ${'─'.repeat(Math.max(0, 50 - label.length))}`);
  console.log('  Edge elements        before/after:', comparison.before.edgeElements, '/', comparison.after.edgeElements, '(Δ', comparison.delta.edgeElements, ')');
  console.log('  Node elements        before/after:', comparison.before.nodeElements, '/', comparison.after.nodeElements, '(Δ', comparison.delta.nodeElements, ')');
  console.log('  Dashed strokes       before/after:', comparison.before.dashedElements, '/', comparison.after.dashedElements, '(Δ', comparison.delta.dashedElements, ')');
  console.log('  vg-edge--inferred    before/after:', comparison.before.inferredEdgeClass, '/', comparison.after.inferredEdgeClass, '(Δ', comparison.delta.inferredEdgeClass, ')');
  console.log('  Inferred edges added:', comparison.inferredEdgesAdded);
  console.log('─'.repeat(60) + '\n');
}

// ── main ───────────────────────────────────────────────────────────────────

async function run() {
  const argv = process.argv.slice(2);
  const disableStart = argv.includes('--no-start-server') || argv.includes('--no-server') || argv.includes('-n');
  const startServerFlag = !disableStart;

  const idleIdx = argv.indexOf('--idle');
  const idleMs = idleIdx >= 0 && argv[idleIdx + 1] ? parseInt(argv[idleIdx + 1], 10) : 2000;

  const port = detectPortFromViteConfig();
  const baseUrl = `http://localhost:${port}/`;
  const fixtureUrl = `${baseUrl}reasoning-demo.ttl`;

  let url = baseUrl;
  url += (url.includes('?') ? '&' : '?') + 'rdfUrl=' + encodeURIComponent(fixtureUrl);
  if (!url.includes('vg_debug=')) {
    url += (url.includes('?') ? '&' : '?') + 'vg_debug=1';
  }

  const outDir = path.join(process.cwd(), 'playwright-reports', 'reasoning');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Clean up old PNG files
  for (const old of ['before.png', 'after.png']) {
    const p = path.join(outDir, old);
    if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('Deleted old file:', p); }
  }

  // ── optionally start dev server ─────────────────────────────────────────
  let serverPid = null;
  if (startServerFlag) {
    console.log('Starting dev server (npm run dev)...');
    const child = spawn('npm', ['run', 'dev'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      env: { ...process.env },
    });
    serverPid = child.pid;
    if (serverPid) console.log('Dev server spawned, pid=', serverPid);
    const ready = await waitForUrl(baseUrl, 120000, 500);
    if (!ready) console.warn(`Dev server did not respond on ${baseUrl} within timeout.`);
    else console.log(`Dev server is responding at ${baseUrl}`);
  }

  // ── browser setup ──────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleEntries = [];
  function noteEntry(kind, payload) {
    consoleEntries.push({ ts: new Date().toISOString(), kind, payload });
    if (consoleEntries.length > 8000) consoleEntries.shift();
  }
  page.on('console', (msg) => {
    try {
      const text = msg.text ? msg.text() : '';
      noteEntry('console', { type: msg.type(), text });
    } catch (e) { noteEntry('console', { type: 'error', text: String(e) }); }
  });
  page.on('pageerror', (err) => noteEntry('pageerror', { message: String(err) }));

  // ── step 1: navigate and wait for initial render ───────────────────────
  console.log('Navigating to', url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => {
    noteEntry('navigation.error', { message: String(e) });
    console.error('Navigation failed:', e.message || e);
  });

  // Short pause for JS to initialise
  await new Promise((r) => setTimeout(r, idleMs));

  console.log('Waiting for initial canvas render...');
  const beforeReady = await waitForCanvasReady(consoleEntries, 20000, 0);
  console.log('Before-reasoning canvas ready:', beforeReady);

  // Extra idle time for layout to settle
  await new Promise((r) => setTimeout(r, Math.max(500, idleMs / 2)));

  // ── step 2: expand all clusters, then capture "before" snapshot ────────
  await expandAllAndWait(page, 1500);

  let beforeSvg = '';
  try {
    beforeSvg = await page.evaluate(() => {
      if (typeof window.__VG_EXPORT_SVG_FULL === 'function') return window.__VG_EXPORT_SVG_FULL();
      return '';
    });
  } catch (e) {
    console.warn('Before SVG export failed:', e && e.message ? e.message : e);
  }
  if (!beforeSvg) {
    console.error('Before SVG is empty — cannot continue comparison.');
  } else {
    fs.writeFileSync(path.join(outDir, 'before.svg'), beforeSvg, 'utf8');
    console.log('Saved before.svg (' + beforeSvg.length + ' chars)');
  }

  const beforeHtml = await exportCanvasHtml(page);
  if (beforeHtml) {
    fs.writeFileSync(path.join(outDir, 'before-canvas.html'), beforeHtml, 'utf8');
    console.log('Saved before-canvas.html (' + beforeHtml.length + ' chars)');
  }

  // ── step 3: click "Run reasoning" (run 1) ─────────────────────────────
  const preRun1EntryCount = consoleEntries.length;
  const run1Clicked = await clickReasoningButton(page, 'run 1');

  // ── step 4: wait for post-run-1 canvas rebuild ────────────────────────
  let afterRun1Ready = { sawPipeline: false };
  if (run1Clicked) {
    console.log('Waiting for post-run-1 canvas render...');
    afterRun1Ready = await waitForCanvasReady(consoleEntries, 30000, preRun1EntryCount);
    console.log('After-run-1 canvas ready:', afterRun1Ready);
    await new Promise((r) => setTimeout(r, Math.max(500, idleMs / 2)));
  }

  // ── step 5: expand all clusters, then capture "after-run1" snapshot ───
  await expandAllAndWait(page, 1500);

  let afterRun1Svg = '';
  try {
    afterRun1Svg = await page.evaluate(() => {
      if (typeof window.__VG_EXPORT_SVG_FULL === 'function') return window.__VG_EXPORT_SVG_FULL();
      return '';
    });
  } catch (e) {
    console.warn('After-run-1 SVG export failed:', e && e.message ? e.message : e);
  }
  if (!afterRun1Svg) {
    console.warn('After-run-1 SVG is empty.');
  } else {
    fs.writeFileSync(path.join(outDir, 'after-run1.svg'), afterRun1Svg, 'utf8');
    console.log('Saved after-run1.svg (' + afterRun1Svg.length + ' chars)');
  }

  const afterRun1Html = await exportCanvasHtml(page);
  if (afterRun1Html) {
    fs.writeFileSync(path.join(outDir, 'after-run1-canvas.html'), afterRun1Html, 'utf8');
    console.log('Saved after-run1-canvas.html (' + afterRun1Html.length + ' chars)');
  }

  // ── step 6: click "Run reasoning" again (run 2) ───────────────────────
  const preRun2EntryCount = consoleEntries.length;
  const run2Clicked = await clickReasoningButton(page, 'run 2');

  // ── step 7: wait for post-run-2 canvas rebuild ────────────────────────
  let afterRun2Ready = { sawPipeline: false };
  if (run2Clicked) {
    console.log('Waiting for post-run-2 canvas render...');
    afterRun2Ready = await waitForCanvasReady(consoleEntries, 30000, preRun2EntryCount);
    console.log('After-run-2 canvas ready:', afterRun2Ready);
    await new Promise((r) => setTimeout(r, Math.max(500, idleMs / 2)));
  }

  // ── step 8: expand all clusters, then capture "after-run2" snapshot ───
  await expandAllAndWait(page, 1500);

  let afterRun2Svg = '';
  try {
    afterRun2Svg = await page.evaluate(() => {
      if (typeof window.__VG_EXPORT_SVG_FULL === 'function') return window.__VG_EXPORT_SVG_FULL();
      return '';
    });
  } catch (e) {
    console.warn('After-run-2 SVG export failed:', e && e.message ? e.message : e);
  }
  if (!afterRun2Svg) {
    console.warn('After-run-2 SVG is empty.');
  } else {
    fs.writeFileSync(path.join(outDir, 'after-run2.svg'), afterRun2Svg, 'utf8');
    console.log('Saved after-run2.svg (' + afterRun2Svg.length + ' chars)');
  }

  const afterRun2Html = await exportCanvasHtml(page);
  if (afterRun2Html) {
    fs.writeFileSync(path.join(outDir, 'after-run2-canvas.html'), afterRun2Html, 'utf8');
    console.log('Saved after-run2-canvas.html (' + afterRun2Html.length + ' chars)');
  }

  // ── step 9: compare and report ─────────────────────────────────────────
  const comparison1 = (beforeSvg && afterRun1Svg) ? compareSvgs(beforeSvg, afterRun1Svg) : null;
  const comparison2 = (afterRun1Svg && afterRun2Svg) ? compareSvgs(afterRun1Svg, afterRun2Svg) : null;

  if (comparison1) printComparison('Before → Run 1', comparison1);
  if (comparison2) printComparison('Run 1 → Run 2', comparison2);

  const report = {
    url,
    fixture: fixtureUrl,
    runAt: new Date().toISOString(),
    beforeReady,
    run1: { ready: afterRun1Ready, clicked: run1Clicked, comparison: comparison1 },
    run2: { ready: afterRun2Ready, clicked: run2Clicked, comparison: comparison2 },
    consoleEntries,
    serverPid: serverPid || null,
  };

  const reportPath = path.join(outDir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('Wrote report to', reportPath);

  // Outcome summary
  console.log('\n── Outcome Summary ──────────────────────────────────────');
  if (!comparison1) {
    console.log('FAIL (run 1): Could not compare SVGs — one or both exports were empty.');
  } else if (comparison1.inferredEdgesAdded) {
    console.log('PASS (run 1): Inferred edges appeared after reasoning.');
  } else if (comparison1.delta.edgeElements > 0) {
    console.log('PASS soft (run 1): New edges appeared but dashed-stroke check inconclusive.');
  } else {
    console.log('WARN (run 1): No new edges or dashed strokes detected. Check fixture or reasoner.');
  }

  if (!comparison2) {
    console.log('FAIL (run 2): Could not compare SVGs — one or both exports were empty.');
  } else if (comparison2.delta.inferredEdgeClass > 0) {
    console.log('WARN (run 2): MORE inferred edges appeared — confirms urn:vg:inferred accumulation bug!');
    console.log('  Run 1 inferred:', comparison1 ? comparison1.after.inferredEdgeClass : '?',
                '→ Run 2 inferred:', comparison2.after.inferredEdgeClass,
                '(Δ +' + comparison2.delta.inferredEdgeClass + ')');
  } else if (comparison2.delta.edgeElements > 0) {
    console.log('WARN (run 2): More edges appeared on second run (Δ +' + comparison2.delta.edgeElements + ' edges).');
  } else if (comparison2.delta.nodeElements !== 0) {
    console.log('WARN (run 2): Node count changed on second run (Δ ' + comparison2.delta.nodeElements + ' nodes).');
  } else {
    console.log('OK (run 2): No additional changes after second reasoning run (idempotent).');
  }
  console.log('────────────────────────────────────────────────────────\n');

  await browser.close();

  if (serverPid) {
    const shutdownMs = parseInt(process.env.PLAYWRIGHT_SERVER_SHUTDOWN_MS || '2000', 10);
    await new Promise((r) => setTimeout(r, shutdownMs));
    try { process.kill(serverPid, 'SIGTERM'); } catch (_) {}
  }

  process.exit(0);
}

run().catch((err) => {
  console.error('playwright-reasoning-compare failed:', err && err.stack ? err.stack : err);
  process.exit(2);
});
