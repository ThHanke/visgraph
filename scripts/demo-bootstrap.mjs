/**
 * scripts/demo-bootstrap.mjs
 *
 * Shared Playwright bootstrap for all MCP demo runner scripts.
 * Starts (optionally) a Vite dev server, launches a headless browser, injects
 * the MCP polyfill, and registers the MCP tools.
 *
 * Usage:
 *   import { startBrowser, callTool, sleep } from './demo-bootstrap.mjs';
 *   const { page, browser, cleanup } = await startBrowser({ baseUrl, noServer });
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import http from 'http';
import { spawn } from 'child_process';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');

// ── util ────────────────────────────────────────────────────────────────────

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function detectPort() {
  try {
    const cfg = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
    const m = cfg.match(/port\s*:\s*(\d{2,5})/);
    if (m) return parseInt(m[1], 10);
  } catch (_) {}
  return 8080;
}

function httpGet(url, ms = 3000) {
  return new Promise(resolve => {
    try {
      const req = http.request(new URL(url), { method: 'GET', timeout: ms }, res => {
        resolve(res.statusCode < 500);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch (_) { resolve(false); }
  });
}

export async function waitFor(url, ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await httpGet(url)) return true;
    await sleep(500);
  }
  return false;
}

// ── MCP tool call ────────────────────────────────────────────────────────────

export async function callTool(page, name, params = {}) {
  return page.evaluate(async ([n, p]) => {
    const tool = window.__mcpTools?.[n];
    if (!tool) return { success: false, error: `Tool not registered: ${n}` };
    try { return await tool(p); } catch (e) { return { success: false, error: String(e) }; }
  }, [name, params]);
}

// ── Browser startup ──────────────────────────────────────────────────────────

/**
 * @param {{ baseUrl?: string, noServer?: boolean, idleMs?: number, viewport?: {width,height} }} opts
 * @returns {{ page, browser, cleanup, idleMs }}
 */
export async function startBrowser(opts = {}) {
  const port = detectPort();
  const baseUrl = opts.baseUrl ?? `http://localhost:${port}/`;
  const noServer = opts.noServer ?? false;
  const idleMs = opts.idleMs ?? 2500;
  const viewport = opts.viewport ?? { width: 1440, height: 900 };

  let serverProc = null;
  if (!noServer && baseUrl.startsWith('http://localhost')) {
    console.log('Starting dev server…');
    serverProc = spawn('npm', ['run', 'dev'], {
      cwd: ROOT,
      stdio: 'ignore',
      detached: true,
      env: { ...process.env },
    });
    if (!await waitFor(baseUrl, 120000)) {
      console.error('Dev server not ready after 2 min');
      process.exit(1);
    }
    console.log('Dev server ready');
  }

  const browser = await chromium.launch({ headless: true });
  const bctx = await browser.newContext({ viewport });
  const page = await bctx.newPage();

  page.on('pageerror', e => console.error('[page error]', String(e)));

  // Inject MCP polyfill before the app initialises
  await page.addInitScript(() => {
    const tools = {};
    Object.defineProperty(navigator, 'modelContext', {
      value: { registerTool: async (n, _d, _s, h) => { tools[n] = h; } },
      configurable: true,
    });
    window.__mcpTools = tools;
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(idleMs);

  // Register MCP tools via dynamic import
  await page.evaluate(async () => {
    const mod = await import('/src/mcp/visgraphMcpServer.ts');
    await mod.registerMcpTools();
  });
  console.log('MCP tools registered');

  async function cleanup() {
    await browser.close();
    if (serverProc) {
      try { process.kill(-serverProc.pid); } catch (_) {}
    }
  }

  return { page, browser, cleanup, idleMs, baseUrl };
}
