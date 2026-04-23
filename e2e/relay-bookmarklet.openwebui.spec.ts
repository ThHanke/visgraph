/**
 * End-to-end relay tests against a local OpenWebUI instance.
 *
 * Full chain:
 *   OpenWebUI chat tab (AI message with tool call)
 *     ↓ bookmarklet detects tool call
 *     ↓ postMessage(vg-call) → relay.html popup
 *     ↓ BroadcastChannel → VisGraph app
 *     ↓ __mcpTools[tool](params) executed
 *     ↓ vg-result → relay.html → chat page
 *     ↓ injectResult() → TipTap editor via ProseMirror dispatch
 *     ↓ submitInput() clicks Send
 *     ✓ result message appears in chat
 *
 * Prerequisites:
 *   1. pip install open-webui && open-webui serve   (default: http://localhost:8080)
 *   2. VisGraph dev server running at VG_URL
 *   3. OpenWebUI configured with at least one LLM model
 *
 * Run:
 *   OWUI_URL=http://localhost:8080 VG_URL=http://localhost:5173 npx playwright test e2e/relay-bookmarklet.openwebui.spec.ts --headed
 */

import { test, expect, BrowserContext, Page } from '@playwright/test';
import fs from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OWUI_URL = process.env.OWUI_URL || 'http://localhost:8080';
const VG_URL   = process.env.VG_URL   || 'http://localhost:5173';

// Patch bookmarklet to point at local VisGraph dev server
const bookmarkletSrc = fs.readFileSync(
  path.resolve(__dirname, '../public/relay-bookmarklet.js'), 'utf8',
)
  .replace(
    "var RELAY_ORIGIN = '__RELAY_ORIGIN__';",
    `var RELAY_ORIGIN = '${VG_URL}';`,
  )
  .replace(
    "var RELAY_URL    = '__RELAY_URL__';",
    `var RELAY_URL = '${VG_URL}/relay.html';`,
  );

// ── Helpers ────────────────────────────────────────────────────────────────

async function openVisgraphApp(context: BrowserContext): Promise<Page> {
  const appPage = await context.newPage();
  await appPage.goto(VG_URL);
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

/**
 * The TipTap inject result appears as a sent user message in the chat.
 * This helper waits for the VisGraph result to land in the chat as a user turn.
 */
async function waitForResultInChat(chatPage: Page, timeout = 20_000): Promise<string> {
  // OpenWebUI user messages are in elements with role=none or specific classes;
  // we look for text containing '[VisGraph' in any visible chat message
  await chatPage.waitForFunction(
    () => document.body.innerText.includes('[VisGraph'),
    { timeout },
  );
  return chatPage.evaluate(() => document.body.innerText);
}

// ── The synthetic AI message ────────────────────────────────────────────────
// We don't trigger a real LLM — we inject a fake AI message directly into the
// OpenWebUI chat DOM to simulate what the AI would generate.  This makes the
// test deterministic and fast.

const FAKE_AI_MESSAGE_ADDNODE = [
  'I will add Alice to the graph.',
  '',
  '`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://example.org/Alice","label":"Alice","typeIri":"http://example.org/Person"}}}`',
].join('\n');

async function injectFakeAiMessage(chatPage: Page, text: string) {
  // Append a fake AI message to the chat stream DOM.
  // OpenWebUI renders messages in a scrollable list; we add a div that looks
  // enough like a real AI message for the bookmarklet's observer to pick it up.
  await chatPage.evaluate((msg) => {
    var container = document.querySelector('[id^="messages-"]') || document.querySelector('.messages') || document.body;
    var div = document.createElement('div');
    div.setAttribute('data-vg-test-message', 'ai');
    div.style.cssText = 'padding:8px;margin:8px 0;border:1px solid #ccc;white-space:pre-wrap;font-family:monospace';
    div.textContent = msg;
    container.appendChild(div);
  }, text);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe('relay — OpenWebUI TipTap inject (local)', () => {
  test.setTimeout(60_000);

  let appPage: Page;

  test.beforeEach(async ({ context }) => {
    appPage = await openVisgraphApp(context);
  });

  test.afterEach(async () => {
    await appPage.close();
  });

  test('addNode via fake AI message: result injected into TipTap and submitted', async ({ context, page }) => {
    await page.goto(OWUI_URL);

    // Wait for OpenWebUI to load the TipTap editor
    await page.waitForSelector('#chat-input', { timeout: 15_000 });

    const _relayPopup = await injectBookmarklet(page);

    // Inject synthetic AI message so the bookmarklet detects it
    await injectFakeAiMessage(page, FAKE_AI_MESSAGE_ADDNODE);

    const bodyText = await waitForResultInChat(page);

    expect(bodyText).toContain('[VisGraph — 1 tool ✓]');
    expect(bodyText).toContain('addNode');
    expect(bodyText).toContain('http://example.org/Alice');
  });

  test('addNode: TipTap editor has content and send button is enabled before submit', async ({ context, page }) => {
    await page.goto(OWUI_URL);
    await page.waitForSelector('#chat-input', { timeout: 15_000 });
    await injectBookmarklet(page);
    await injectFakeAiMessage(page, FAKE_AI_MESSAGE_ADDNODE);

    // Before submit fires (within the 500 ms window), the editor should have text
    // and the send button should be enabled
    await page.waitForFunction(() => {
      var editor = document.getElementById('chat-input');
      var text = editor ? (editor.innerText || '').trim() : '';
      return text.includes('[VisGraph');
    }, { timeout: 10_000 });

    const editorText = await page.evaluate(() => {
      var el = document.getElementById('chat-input');
      return el ? el.innerText : '';
    });
    expect(editorText).toContain('[VisGraph');

    // Send button should be enabled (TipTap state updated via PM dispatch)
    const sendEnabled = await page.evaluate(() => {
      var btns = Array.from(document.querySelectorAll('button'));
      var send = btns.find(function(b) {
        var lbl = (b.getAttribute('aria-label') || b.textContent || '').toLowerCase();
        return lbl.includes('send') || lbl.includes('senden');
      });
      return send ? !send.disabled : null;
    });
    expect(sendEnabled).toBe(true);
  });

  test('single tool call only: system prompt example does not cause double dispatch', async ({ context, page }) => {
    await page.goto(OWUI_URL);
    await page.waitForSelector('#chat-input', { timeout: 15_000 });
    await injectBookmarklet(page);

    // Inject a fake AI message with id:1 — the page already has system prompt
    // with id:0 example.  Only id:1 should be dispatched.
    await injectFakeAiMessage(page, [
      'Calling help.',
      '`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"help","arguments":{}}}`',
    ].join('\n'));

    const bodyText = await waitForResultInChat(page, 15_000);

    // Must say "1 tool", not "2 tools"
    expect(bodyText).toMatch(/\[VisGraph — 1 tool/);
    expect(bodyText).not.toMatch(/\[VisGraph — 2 tool/);
  });
});
