/**
 * Pizza tutorial demo — real OpenWebUI + Ontosphere side by side.
 *
 * Replaces the mock chat iframe with a live OpenWebUI instance.
 * The bookmarklet is injected into the OpenWebUI frame; the pizza starter
 * prompt drives qwen3:8b to emit JSON-RPC tool calls which the relay executes
 * in Ontosphere on the right.
 *
 * Prerequisites:
 *   1. npm run dev                     # Ontosphere dev server
 *   2. npm run demo:owui:auth          # login once, saves .playwright/owui-auth.json
 *
 * Run (records video):
 *   OWUI_URL=https://gpuserver1-sit.iwm.fraunhofer.de \
 *   npx playwright test e2e/demo-openwebui-pizza.spec.ts \
 *     --config=playwright.openwebui.config.ts
 *
 * Or without recording (headed, for manual testing):
 *   OWUI_URL=https://... npx playwright test e2e/demo-openwebui-pizza.spec.ts \
 *     --config=playwright.openwebui.config.ts --headed
 */

import { test, Frame, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const OWUI_URL  = process.env.OWUI_URL  || 'https://gpuserver1-sit.iwm.fraunhofer.de';
const VG_URL    = process.env.DEMO_BASE_URL || 'http://localhost:8080';
const AUTH_FILE = path.resolve(__dirname, '../.playwright/owui-auth.json');

// Bookmarklet patched to point at local Ontosphere instance
const bookmarkletSrc = fs.readFileSync(
  path.resolve(__dirname, '../public/relay-bookmarklet.js'), 'utf8',
)
  .replace("var RELAY_ORIGIN = '__RELAY_ORIGIN__';", `var RELAY_ORIGIN = '${VG_URL}';`)
  .replace("var RELAY_URL    = '__RELAY_URL__';",    `var RELAY_URL = '${VG_URL}/relay.html';`);

// System prompt injected into OpenWebUI before the demo starts
const SYSTEM_PROMPT = `You control Ontosphere (browser-based RDF knowledge graph editor) via this relay.

⚠️ RELAY INTERCEPTION — READ FIRST
This relay ONLY intercepts JSON-RPC 2.0 wrapped in single backticks.
ALL other formats are SILENTLY IGNORED — no response, no error, nothing:
  • OpenAI function_call / tool_calls
  • Claude tool_use blocks
  • Gemini functionCall
  • {"tool":"x","input":{}} style
  • <tool_call> XML tags
  • Plain prose describing a tool call
If you do not use the exact format below, your call will never be executed.

CALL FORMAT — single backtick per JSON-RPC object, up to 5 per message:
\`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"TOOLNAME","arguments":ARGS}}\`

Example:
\`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://example.org/Pizza","label":"Pizza","typeIri":"http://www.w3.org/2002/07/owl#Class"}}}\`

RULES:
1. Single backtick, NOT triple. Increment id per call.
2. Batch up to 5 non-dependent calls per message.
3. addLink: both nodes must already exist.
4. 5+ individuals: use loadRdf(turtle) not N×addNode.
5. Tool failed? Call help({tool:"name"}) for the exact schema.

Full docs: call help({}).`;

// Opening message sent to trigger the pizza tutorial
const PIZZA_STARTER = `Let's build a Manchester-style pizza ontology step by step!

Please add three root OWL classes to the canvas:
- Pizza  (IRI: http://www.pizza-ontology.com/pizza.owl#Pizza)
- PizzaBase  (IRI: http://www.pizza-ontology.com/pizza.owl#PizzaBase)
- PizzaTopping  (IRI: http://www.pizza-ontology.com/pizza.owl#PizzaTopping)

All use typeIri http://www.w3.org/2002/07/owl#Class. After adding all three, run a layered layout with spacing 200.`;

// ── Helpers ────────────────────────────────────────────────────────────────

async function waitForFrame(page: Page, predicate: (f: Frame) => boolean, timeout = 30_000): Promise<Frame> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = page.frames().find(predicate);
    if (found) return found;
    await page.waitForTimeout(300);
  }
  throw new Error('waitForFrame timed out');
}

async function selectModel(owuiFrame: Frame, modelName: string): Promise<void> {
  // Remove extra model slots (keep only first)
  while (true) {
    const removeBtn = owuiFrame.locator('button[aria-label*="Remove Model"]').first();
    if (await removeBtn.count() === 0) break;
    await removeBtn.click();
    await owuiFrame.waitForTimeout(300);
  }

  // Open model selector dropdown (first slot)
  await owuiFrame.locator('#model-selector-0-button').click();
  await owuiFrame.waitForTimeout(300);

  // Type model name to filter, then click match
  const searchInput = owuiFrame.locator('input[placeholder*="Search"], input[placeholder*="search"]').first();
  await searchInput.fill(modelName);
  await owuiFrame.waitForTimeout(400);
  await owuiFrame.locator(`button:has-text("${modelName}")`).first().click();
  await owuiFrame.waitForTimeout(400);
}

async function setSystemPrompt(owuiFrame: Frame, systemPrompt: string): Promise<void> {
  // Open Controls panel
  const controlsBtn = owuiFrame.locator(
    'button[aria-label*="Controls" i], button[aria-label*="Settings" i], button:has-text("Controls")',
  ).first();
  await controlsBtn.click();
  await owuiFrame.waitForTimeout(800);

  // OpenWebUI system prompt: textarea or contenteditable — try multiple selectors
  const sysField = owuiFrame.locator([
    '#system-prompt-input',
    'textarea[placeholder*="system" i]',
    'textarea[id*="system" i]',
    'div[contenteditable][id*="system" i]',
    'div[contenteditable][placeholder*="system" i]',
  ].join(', ')).first();

  if (await sysField.count() > 0) {
    const tag = await sysField.evaluate(el => el.tagName.toLowerCase());
    if (tag === 'textarea') {
      await sysField.click();
      await sysField.fill(systemPrompt);
    } else {
      // contenteditable
      await sysField.click();
      await sysField.evaluate((el, text) => {
        (el as HTMLElement).focus();
        document.execCommand('selectAll');
        document.execCommand('insertText', false, text);
      }, systemPrompt);
    }
    await owuiFrame.waitForTimeout(400);
  }

  // Close via the panel's own ✕ button (class="self-center", SVG ×).
  // The toolbar Controls button is behind the modal overlay and cannot be clicked.
  await owuiFrame.locator('div.modal button.self-center').click({ timeout: 5_000 });
  await owuiFrame.waitForTimeout(400);
}

async function sendMessage(owuiFrame: Frame, text: string): Promise<void> {
  const input = owuiFrame.locator('#chat-input');
  await input.click();
  await input.fill(text);
  await owuiFrame.waitForTimeout(200);
  // Click send button
  await owuiFrame.locator('button[aria-label*="send" i], button[type="submit"]').last().click();
}

// ── Test ───────────────────────────────────────────────────────────────────

test('openwebui-pizza: pizza tutorial demo with real OpenWebUI', async ({ page, context }) => {
  test.setTimeout(600_000);

  // ── 1. Restore auth state ────────────────────────────────────────────────
  if (fs.existsSync(AUTH_FILE)) {
    const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) as {
      cookies?: Array<Record<string, unknown>>;
      origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
    };
    if (state.cookies?.length) {
      await context.addCookies(state.cookies as Parameters<typeof context.addCookies>[0]);
    }
    // Inject localStorage for OWUI origin into every frame before load
    if (state.origins?.length) {
      await context.addInitScript((origins) => {
        const entry = origins.find(o => o.origin === location.origin);
        if (entry?.localStorage) {
          for (const { name, value } of entry.localStorage) {
            try { localStorage.setItem(name, value); } catch { /* ignore */ }
          }
        }
      }, state.origins);
    }
  }

  // ── 2. Strip X-Frame-Options so OWUI loads inside our iframe ────────────
  await context.route(`${OWUI_URL}/**`, async route => {
    try {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers['x-frame-options'];
      delete headers['content-security-policy'];
      await route.fulfill({ response, headers });
    } catch {
      await route.continue();
    }
  });

  // ── 3. Open the side-by-side stage ──────────────────────────────────────
  const stageUrl =
    `${VG_URL}/demo-stage-owui.html` +
    `?owui=${encodeURIComponent(OWUI_URL + '/')}` +
    `&app=${encodeURIComponent(VG_URL + '/')}`;
  await page.goto(stageUrl);

  // ── 4. Wait for Ontosphere app ───────────────────────────────────────────
  const appFrame = await waitForFrame(page, f =>
    f.url().startsWith(VG_URL) && !f.url().includes('demo-stage'),
  );
  await appFrame.waitForFunction(
    () => !!(window as any).__mcpTools?.addNode,
    { timeout: 30_000 },
  );

  // ── 5. Wait for OpenWebUI chat input ─────────────────────────────────────
  const owuiFrame = await waitForFrame(page, f => f.url().startsWith(OWUI_URL));
  await owuiFrame.waitForSelector('#chat-input', { timeout: 30_000 });
  await page.waitForTimeout(1_000); // let UI settle

  // ── 6. Select qwen3:8b ───────────────────────────────────────────────────
  await selectModel(owuiFrame, 'qwen3:8b');

  // ── 7. Set system prompt ─────────────────────────────────────────────────
  await setSystemPrompt(owuiFrame, SYSTEM_PROMPT);

  // ── 8. Inject bookmarklet ────────────────────────────────────────────────
  // The OWUI iframe uses allow-popups-to-escape-sandbox, so window.open()
  // produces a top-level browser window → context.waitForEvent('page'), not
  // page.waitForEvent('popup').
  const relayPagePromise = context.waitForEvent('page', { timeout: 15_000 });
  await owuiFrame.evaluate((src) => {
    (window as any).__vgRelayActive = false;
    new Function(src)();
  }, bookmarkletSrc);
  const relayPopup = await relayPagePromise;
  await relayPopup.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(800);

  // ── 9. Send pizza starter prompt ─────────────────────────────────────────
  await sendMessage(owuiFrame, PIZZA_STARTER);

  // ── 10. Wait for relay result in chat ────────────────────────────────────
  await owuiFrame.waitForFunction(
    () => document.body.innerText.includes('[Ontosphere'),
    { timeout: 120_000 },
  );

  await page.waitForTimeout(3_000); // viewer reads result
});
