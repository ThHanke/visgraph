/**
 * REAL end-to-end relay tests.
 *
 * Confirms the full chain works:
 *
 *   relay-mock-chat.html (AI chat tab)
 *     ↓ bookmarklet detects TOOL block
 *     ↓ postMessage(vg-call) → relay.html popup
 *     ↓ BroadcastChannel('visgraph-relay-v1') → VisGraph app
 *     ↓ __mcpTools[tool](params) executed in app
 *     ↓ BC vg-result → relay.html
 *     ↓ opener.postMessage(vg-result) → chat page
 *     ↓ injectResult() writes summary into chat input
 *     ↓ submitInput() clicks Send
 *     ✓ result appears in chat stream as user message
 *
 * Nothing is mocked. The VisGraph app at DEV_URL must be running and have
 * its relay bridge (BroadcastChannel) and __mcpTools active.
 *
 * Run:
 *   DEV_URL=http://docker-dev.iwm.fraunhofer.de:8080 npx playwright test e2e/relay-bookmarklet.real.spec.ts
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_URL = process.env.DEV_URL || 'http://docker-dev.iwm.fraunhofer.de:8080';

// Patch bookmarklet to use the dev server origin instead of the GitHub Pages URL.
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

/**
 * Open the VisGraph app and wait until __mcpTools is populated and the relay
 * bridge BroadcastChannel is listening.  Returns the app page.
 */
async function openVisgraphApp(context: BrowserContext): Promise<Page> {
  const appPage = await context.newPage();
  await appPage.goto(DEV_URL);
  // Wait for __mcpTools to be registered (app initialises async)
  await appPage.waitForFunction(
    () => !!(window as any).__mcpTools && typeof (window as any).__mcpTools['addNode'] === 'function',
    { timeout: 20_000 },
  );
  return appPage;
}

/**
 * Inject the real bookmarklet into the chat page.
 * Lets window.open() happen naturally so Playwright can capture the relay.html popup.
 */
async function injectBookmarklet(chatPage: Page): Promise<Page> {
  const popupPromise = chatPage.waitForEvent('popup', { timeout: 10_000 });
  await chatPage.evaluate((src) => {
    (window as any).__vgRelayActive = false; // reset so bookmarklet re-runs on reinject
    new Function(src)();
  }, bookmarkletSrc);
  const relayPopup = await popupPromise;
  // Wait for relay.html to load and open its BroadcastChannel
  await relayPopup.waitForLoadState('domcontentloaded');
  return relayPopup;
}

/**
 * Wait for the injected result to land in the chat stream as a submitted user message.
 * After injectResult() sets the input and submitInput() fires, the mock chat moves
 * the text into #chat-stream as a .msg-user div.
 */
async function getSubmittedResult(chatPage: Page, timeout = 15_000): Promise<string> {
  const locator = chatPage.locator('#chat-stream .msg-user').last();
  await expect(locator).toContainText('[VisGraph', { timeout });
  return locator.innerText();
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('relay — real end-to-end (dev server)', () => {
  test.setTimeout(60_000);

  let appPage: Page;

  test.beforeEach(async ({ context }) => {
    // Open VisGraph app once per test — relay bridge starts automatically.
    appPage = await openVisgraphApp(context);
  });

  test.afterEach(async () => {
    await appPage.close();
  });

  // ── addNode via real chain ─────────────────────────────────────────────

  test('addNode: tool call reaches VisGraph, node created, result injected into chat', async ({ context, page }) => {
    await page.goto(`${DEV_URL}/relay-mock-chat.html`);
    const _relayPopup = await injectBookmarklet(page);

    // Trigger single addNode scenario
    await page.click('button[data-scenario="single"]');

    const result = await getSubmittedResult(page);

    // Header: 1 tool succeeded
    expect(result).toContain('[VisGraph — 1 tool ✓]');
    expect(result).toContain('✓ addNode');
    // IRI confirmed
    expect(result).toContain('http://example.org/Alice');
    // Canvas summary from real app (e.g. "Canvas: 1 node (Alice), 0 links")
    expect(result).toMatch(/Canvas:\s*\d+ node/);
  });

  // ── Verify node actually exists in VisGraph ────────────────────────────

  test('addNode: node verifiably present in VisGraph canvas after injection', async ({ context, page }) => {
    await page.goto(`${DEV_URL}/relay-mock-chat.html`);
    await injectBookmarklet(page);
    await page.click('button[data-scenario="single"]');
    await getSubmittedResult(page); // wait for round-trip to complete

    // Ask the real app for its current nodes
    const nodes = await appPage.evaluate(async () => {
      const tools = (window as any).__mcpTools as Record<string, (p: any) => Promise<any>>;
      const result = await tools['getNodes']({});
      return (result.data as any)?.entities ?? [];
    });
    const iris = (nodes as any[]).map((n: any) => n.iri);
    expect(iris).toContain('http://example.org/Alice');
  });

  // ── Batch: 3 nodes, all reach VisGraph ────────────────────────────────

  test('batch 3 addNode: all nodes created in VisGraph, combined result injected', async ({ context, page }) => {
    await page.goto(`${DEV_URL}/relay-mock-chat.html`);
    await injectBookmarklet(page);
    await page.click('button[data-scenario="batch"]');

    const result = await getSubmittedResult(page, 20_000);

    expect(result).toContain('[VisGraph — 3 tools ✓]');
    const lines = result.match(/✓ addNode:/g);
    expect(lines).toHaveLength(3);

    // All 3 nodes actually in the app
    const nodes = await appPage.evaluate(async () => {
      const tools = (window as any).__mcpTools as Record<string, (p: any) => Promise<any>>;
      const result = await tools['getNodes']({});
      return (result.data as any)?.entities ?? [];
    });
    const iris = (nodes as any[]).map((n: any) => n.iri);
    expect(iris).toContain('http://example.org/Alice');
    expect(iris).toContain('http://example.org/Bob');
    expect(iris).toContain('http://example.org/Carol');
  });

  // ── Open WebUI mode: contenteditable injection through real chain ──────

  test('Open WebUI (contenteditable): result from real app injected and submitted', async ({ context, page }) => {
    await page.goto(`${DEV_URL}/relay-mock-chat.html`);
    await page.click('#mode-openwebui');
    await injectBookmarklet(page);
    await page.click('button[data-scenario="single"]');

    const result = await getSubmittedResult(page);
    expect(result).toContain('[VisGraph — 1 tool ✓]');
    expect(result).toContain('✓ addNode');
  });

  // ── ChatGPT ProseMirror mode ───────────────────────────────────────────

  test('ChatGPT ProseMirror (contenteditable): result from real app injected and submitted', async ({ context, page }) => {
    await page.goto(`${DEV_URL}/relay-mock-chat.html`);
    await page.click('#mode-chatgpt');
    await injectBookmarklet(page);
    await page.click('button[data-scenario="single"]');

    const result = await getSubmittedResult(page);
    expect(result).toContain('[VisGraph — 1 tool ✓]');
    expect(result).toContain('✓ addNode');
  });

  // ── Unknown tool: real error from VisGraph ─────────────────────────────

  test('unknown tool: VisGraph returns error, ✗ appears in chat', async ({ context, page }) => {
    await page.goto(`${DEV_URL}/relay-mock-chat.html`);
    await injectBookmarklet(page);
    await page.click('button[data-scenario="unknown-tool"]');

    const result = await getSubmittedResult(page);
    expect(result).toContain('✗ nonExistentTool');
    expect(result).toContain('(some failed)');
  });

  // ── relay.html shows correct status ───────────────────────────────────

  test('relay.html: shows "active" for opener and BC connection after first tool call', async ({ context, page }) => {
    await page.goto(`${DEV_URL}/relay-mock-chat.html`);
    const relayPopup = await injectBookmarklet(page);
    await page.click('button[data-scenario="single"]');
    await getSubmittedResult(page);

    // relay.html DOM should show connected state
    await expect(relayPopup.locator('#val-opener')).toHaveText(/active|connected/, { timeout: 5000 });
    await expect(relayPopup.locator('#dot-bc')).toHaveClass(/ok/, { timeout: 5000 });
  });
});
