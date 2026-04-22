/**
 * FhGenie rendering E2E tests.
 *
 * Verifies the relay bookmarklet correctly extracts TOOL blocks from HTML
 * produced by FhGenie's markdown renderer (Fluent UI + custom CSS modules).
 *
 * The fixture at /relay-fhgenie-mock.html mimics FhGenie's exact class
 * hierarchy:
 *   ._chatMessageStream_c6udf_108
 *     ._chatMessageGpt_c6udf_126
 *       ._body_1gd8t_67   ← bookmarklet scans here
 *
 * Scenarios:
 *   plain        — raw TOOL blocks in a <pre> (baseline)
 *   markdown-p   — each TOOL line wrapped in <p> by markdown renderer
 *   markdown-list — BUG CASE: AI outputs "dagre- lr" → renderer makes <li>lr</li>
 *                   → dagre alias must recover "dagre-lr"
 *   codeblock    — TOOL blocks inside a fenced <pre><code> block
 *   inline-algo  — algorithm param on same line as TOOL name
 *   prefixed     — prefixed IRIs (ex:Alice, owl:Class) expanded by expandIri()
 *
 * Run:
 *   DEV_URL=http://docker-dev.iwm.fraunhofer.de:8080 npx playwright test e2e/relay-bookmarklet.fhgenie.spec.ts
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.DEV_URL || 'http://docker-dev.iwm.fraunhofer.de:8080';

const bookmarkletSrc = fs.readFileSync(
  path.resolve(__dirname, '../public/relay-bookmarklet.js'), 'utf8',
)
  .replace(
    "var RELAY_ORIGIN = 'https://thhanke.github.io';",
    `var RELAY_ORIGIN = '${DEV_URL}';`,
  )
  .replace(
    "var RELAY_URL    = 'https://thhanke.github.io/visgraph/relay.html';",
    `var RELAY_URL = '${DEV_URL}/relay.html';`,
  );

// ── Helpers ────────────────────────────────────────────────────────────────

async function openVisgraphApp(context: BrowserContext): Promise<Page> {
  const appPage = await context.newPage();
  await appPage.goto(DEV_URL);
  await appPage.waitForFunction(
    () => !!(window as any).__mcpTools && typeof (window as any).__mcpTools['addNode'] === 'function',
    { timeout: 20_000 },
  );
  return appPage;
}

async function injectBookmarklet(chatPage: Page): Promise<Page> {
  const popupPromise = chatPage.waitForEvent('popup', { timeout: 10_000 });
  await chatPage.evaluate((src) => {
    (window as any).__vgRelayActive = false;
    new Function(src)();
  }, bookmarkletSrc);
  const relayPopup = await popupPromise;
  await relayPopup.waitForLoadState('domcontentloaded');
  return relayPopup;
}

/** Wait for the bookmarklet result to be submitted and appear in #result-stream. */
async function getSubmittedResult(chatPage: Page, timeout = 15_000): Promise<string> {
  const locator = chatPage.locator('#result-stream .msg-user').last();
  await expect(locator).toContainText('[VisGraph', { timeout });
  return locator.innerText();
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('relay — FhGenie rendering scenarios', () => {
  test.setTimeout(60_000);

  let appPage: Page;

  test.beforeEach(async ({ context }) => {
    appPage = await openVisgraphApp(context);
  });

  test.afterEach(async () => {
    await appPage.close();
  });

  // ── plain text (baseline) ─────────────────────────────────────────────

  test('plain: TOOL blocks in <pre> reach VisGraph correctly', async ({ context, page }) => {
    await page.goto(`${DEV_URL}/relay-fhgenie-mock.html`);
    await injectBookmarklet(page);
    await page.click('button[data-scenario="plain"]');

    const result = await getSubmittedResult(page);
    // 3 tools: runLayout, fitCanvas, exportImage
    expect(result).toContain('[VisGraph — 3 tools ✓]');
    expect(result).toContain('✓ runLayout');
    expect(result).toContain('✓ fitCanvas');
    expect(result).toContain('✓ exportImage');
  });

  // ── <p>-wrapped markdown ──────────────────────────────────────────────

  test('markdown-p: <p>-wrapped TOOL lines parsed correctly', async ({ context, page }) => {
    await page.goto(`${DEV_URL}/relay-fhgenie-mock.html`);
    await injectBookmarklet(page);
    await page.click('button[data-scenario="markdown-p"]');

    const result = await getSubmittedResult(page);
    expect(result).toContain('[VisGraph — 3 tools ✓]');
    expect(result).toContain('✓ runLayout');
    expect(result).toContain('✓ fitCanvas');
    expect(result).toContain('✓ exportImage');
  });

  // ── markdown-list BUG CASE ────────────────────────────────────────────
  // AI outputs "dagre- lr" where renderer makes <li>lr</li>.
  // innerText collapses to "algorithm: dagre\nlr".
  // The dagre alias in runLayout must recover "dagre-lr".

  test('markdown-list: dagre alias recovers dagre-lr from <li>lr</li> rendering', async ({ context, page }) => {
    await page.goto(`${DEV_URL}/relay-fhgenie-mock.html`);
    await injectBookmarklet(page);
    await page.click('button[data-scenario="markdown-list"]');

    const result = await getSubmittedResult(page);
    // runLayout + fitCanvas: both should succeed via dagre alias
    expect(result).toContain('✓ runLayout');
    expect(result).toContain('✓ fitCanvas');
    expect(result).not.toContain('✗ runLayout');
  });

  // ── fenced code block ─────────────────────────────────────────────────

  test('codeblock: TOOL blocks inside <pre><code> parsed correctly', async ({ context, page }) => {
    await page.goto(`${DEV_URL}/relay-fhgenie-mock.html`);
    await injectBookmarklet(page);
    await page.click('button[data-scenario="codeblock"]');

    const result = await getSubmittedResult(page);
    expect(result).toContain('[VisGraph — 3 tools ✓]');
    expect(result).toContain('✓ runLayout');
    expect(result).toContain('✓ fitCanvas');
    expect(result).toContain('✓ exportImage');
  });

  // ── inline algorithm param ────────────────────────────────────────────

  test('inline-algo: algorithm on same line as TOOL name parsed correctly', async ({ context, page }) => {
    await page.goto(`${DEV_URL}/relay-fhgenie-mock.html`);
    await injectBookmarklet(page);
    await page.click('button[data-scenario="inline-algo"]');

    const result = await getSubmittedResult(page);
    expect(result).toContain('✓ runLayout');
    expect(result).toContain('✓ fitCanvas');
    expect(result).not.toContain('✗ runLayout');
  });

  // ── prefixed IRIs ─────────────────────────────────────────────────────

  test('prefixed: ex:Alice + owl:Class expanded and node created in VisGraph', async ({ context, page }) => {
    await page.goto(`${DEV_URL}/relay-fhgenie-mock.html`);
    await injectBookmarklet(page);
    await page.click('button[data-scenario="prefixed"]');

    const result = await getSubmittedResult(page);
    expect(result).toContain('✓ addNode');
    expect(result).not.toContain('✗ addNode');

    // Node with expanded IRI must be in VisGraph canvas
    const nodes = await appPage.evaluate(async () => {
      const tools = (window as any).__mcpTools as Record<string, (p: any) => Promise<any>>;
      const r = await tools['getNodes']({});
      return (r.data as any)?.entities ?? [];
    });
    const iris = (nodes as any[]).map((n: any) => n.iri);
    expect(iris).toContain('http://example.org/Alice');
  });
});
