/**
 * Socratic pizza ontology demo — live qwen3:4b via OWUI relay.
 *
 * A small local AI model is guided to discover and build a pizza ontology
 * through Socratic questions.  No direct instructions — only leading questions.
 * The model responds with JSON-RPC tool calls; the relay executes them live
 * in Ontosphere.  Caption overlays explain each turn for viewers.
 *
 * Prerequisites:
 *   1. npm run dev                      # Ontosphere at localhost:8080
 *   2. npm run demo:owui:auth           # save .playwright/owui-auth.json
 *
 * Run (records video):
 *   OWUI_URL=https://gpuserver1-sit.iwm.fraunhofer.de \
 *   npm run demo:owui:video
 *
 * Output: docs/demo-videos/openwebui-socratic.webm / .mp4
 */

import { test, Frame, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OWUI_URL  = process.env.OWUI_URL  || 'https://gpuserver1-sit.iwm.fraunhofer.de';
const VG_URL    = process.env.DEMO_BASE_URL || 'http://localhost:8080';
const AUTH_FILE = path.resolve(__dirname, '../.playwright/owui-auth.json');
const MODEL     = 'qwen3:4b';

// ── Captions ──────────────────────────────────────────────────────────────
const CAPTIONS = [
  // T0
  { before: 'Turn 0 — Asking qwen3 to add the most fundamental concept: what is a pizza?',
    after:  'qwen3 added the root Pizza class. Next: its two building blocks.' },
  // T1
  { before: 'Turn 1 — Guiding the model to split Pizza into base and toppings.',
    after:  'Pizza → PizzaBase and PizzaTopping via rdfs:subClassOf. Next: specific base types.' },
  // T2
  { before: 'Turn 2 — Asking for concrete PizzaBase specialisations.',
    after:  'DeepPanBase and ThinAndCrispyBase added. Next: real toppings.' },
  // T3
  { before: 'Turn 3 — Populating the topping hierarchy with real ingredients.',
    after:  'Mozzarella, TomatoSauce, Pepperoni linked as PizzaTopping sub-classes. Next: composition.' },
  // T4
  { before: 'Turn 4 — Introducing object properties: how does a Pizza relate to its parts?',
    after:  'Pizza hasPart PizzaBase and PizzaTopping. Next: visual layout.' },
  // T5
  { before: 'Turn 5 — Asking the model to arrange the hierarchy for readability.',
    after:  'dagre-tb layout applied. Next: inspecting what was built.' },
  // T6
  { before: 'Turn 6 — Asking the model to verify its own work via getNodeDetails.',
    after:  'Pizza ontology complete — built entirely through Socratic questioning.' },
];

// ── Format INSTR ──────────────────────────────────────────────────────────
const INSTR = [
  'RELAY FORMAT — single backtick JSON-RPC 2.0 only. ALL other formats silently ignored:',
  '`{"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":"TOOL","arguments":{...}}}`',
  'WRONG (silently ignored): triple-backtick, <tool_call>, {"tool":"x",...}',
  '',
  'Key tools and signatures:',
  '  addNode(iri, typeIri?, label?)             — add entity to graph',
  '  addLink(subjectIri, predicateIri, objectIri) — add triple',
  '  runLayout(algorithm)                       — dagre-tb | elk-layered | dagre-lr',
  '  getNodeDetails(iri)                        — inspect entity properties',
  '',
  'Useful IRIs:',
  '  owl:Class       = http://www.w3.org/2002/07/owl#Class',
  '  rdfs:subClassOf = http://www.w3.org/2000/01/rdf-schema#subClassOf',
  '  ex:             = http://www.pizza-ontology.com/pizza.owl#',
  '',
  'Respond with ONLY backtick-wrapped calls. No prose.',
].join('\n');

// ── Socratic turns T0–T6 ──────────────────────────────────────────────────
const TURNS = [
  'Can you teach me how ontologies work using pizzas as a real-world example? Start by adding the most fundamental concept to the graph.',
  'Great start! A pizza is made of two main building blocks — its base and its toppings. Could you model those as more specific types of Pizza in the ontology?',
  'Nice! PizzaBase can be either deep pan or thin and crispy. Can you add those two variants as more specific types of PizzaBase?',
  "Now let's add some real toppings. Can you add Mozzarella, TomatoSauce, and Pepperoni as specific types of PizzaTopping?",
  "The graph has the building blocks, but a Pizza isn't linked to its parts yet. Can you express that a Pizza has both a PizzaBase and a PizzaTopping using an addLink call?",
  'The graph is getting complex. Can you arrange the nodes so the hierarchy is easy to read?',
  "Let's verify what we've built. Can you look up the details of the Pizza concept and tell me what you see?",
];

// ── Helpers ────────────────────────────────────────────────────────────────

async function waitForFrame(page: Page, predicate: (f: Frame) => boolean, timeout = 90_000): Promise<Frame> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = page.frames().find(predicate);
    if (found) return found;
    await page.waitForTimeout(400);
  }
  throw new Error('waitForFrame timed out');
}

async function showCaption(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    let el = document.getElementById('__demo_cap__');
    if (!el) {
      el = document.createElement('div');
      el.id = '__demo_cap__';
      Object.assign(el.style, {
        position: 'fixed', bottom: '32px', left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(0,0,0,0.82)', color: '#fff',
        font: '600 16px/1.4 "Inter", sans-serif',
        padding: '12px 28px', borderRadius: '8px',
        zIndex: '99999', pointerEvents: 'none',
        maxWidth: '85%', textAlign: 'center',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      });
      document.body.appendChild(el);
    }
    el.textContent = t;
    (el as HTMLElement).style.display = 'block';
  }, text);
}

async function clearCaption(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById('__demo_cap__');
    if (el) el.style.display = 'none';
  });
}

async function selectModel(owuiFrame: Frame, modelName: string): Promise<void> {
  while (true) {
    const removeBtn = owuiFrame.locator('button[aria-label*="Remove Model"]').first();
    if (await removeBtn.count() === 0) break;
    await removeBtn.click();
    await owuiFrame.waitForTimeout(300);
  }
  await owuiFrame.locator('#model-selector-0-button').click();
  await owuiFrame.waitForTimeout(400);
  const search = owuiFrame.locator('input[placeholder*="Search" i]').first();
  if (await search.count() > 0) {
    await search.fill(modelName);
    await owuiFrame.waitForTimeout(400);
  }
  await owuiFrame.locator(`button:has-text("${modelName}")`).first().click();
  await owuiFrame.waitForTimeout(400);
}

async function waitIdle(owuiFrame: Frame, timeout = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const streaming = await owuiFrame.evaluate(() => (window as any).__vgIsStreaming?.() ?? false);
    if (!streaming) return true;
    await owuiFrame.waitForTimeout(1000);
  }
  return false;
}

async function injectText(owuiFrame: Frame, text: string, retries = 8): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    const ok = await owuiFrame.evaluate(
      (t) => typeof (window as any).__vgInjectResult === 'function'
        ? (window as any).__vgInjectResult(t) : false,
      text,
    );
    if (ok !== false) return true;
    await owuiFrame.waitForTimeout(500);
  }
  return false;
}

async function clickSend(owuiFrame: Frame): Promise<void> {
  const btn = owuiFrame.locator('#send-message-button:not([disabled])');
  if (await btn.count() > 0) await btn.click();
}

// ── Test ──────────────────────────────────────────────────────────────────

test('openwebui-socratic: Socratic pizza ontology — live qwen3:4b via OWUI relay', async ({ page, context }) => {
  test.setTimeout(900_000);

  // ── 1. Auth cookies ──────────────────────────────────────────────────────
  if (fs.existsSync(AUTH_FILE)) {
    const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) as {
      cookies?: Array<Record<string, unknown>>;
      origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
    };
    if (state.cookies?.length)
      await context.addCookies(state.cookies as Parameters<typeof context.addCookies>[0]);
    if (state.origins?.length) {
      await context.addInitScript((origins) => {
        const entry = (origins as Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>)
          .find(o => o.origin === location.origin);
        if (entry?.localStorage)
          for (const { name, value } of entry.localStorage)
            try { localStorage.setItem(name, value); } catch { /* ignore */ }
      }, state.origins);
    }
  }

  // ── 2. Strip X-Frame-Options so OWUI iframe loads ─────────────────────
  await context.route(`${OWUI_URL}/**`, async route => {
    try {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers['x-frame-options'];
      delete headers['content-security-policy'];
      await route.fulfill({ response, headers });
    } catch { await route.continue(); }
  });

  // ── 3. Stage page ────────────────────────────────────────────────────────
  const stageUrl = `${VG_URL}/demo-stage-owui.html`
    + `?owui=${encodeURIComponent(OWUI_URL + '/')}`
    + `&app=${encodeURIComponent(VG_URL + '/')}`;
  await page.goto(stageUrl);

  // ── 4. Wait for Ontosphere frame ─────────────────────────────────────────
  const appFrame = await waitForFrame(page, f =>
    f.url().startsWith(VG_URL) && !f.url().includes('demo-stage'),
  );
  await appFrame.waitForFunction(
    () => !!(window as any).__mcpTools?.addNode, { timeout: 30_000 },
  );

  // ── 5. Wait for OWUI frame — match on any gpuserver1 URL (auth redirect OK)
  const owuiFrame = await waitForFrame(
    page,
    f => f.url().includes('gpuserver1-sit'),
    90_000,
  );
  // Wait until chat input is ready (may take time after SPA hydration)
  await owuiFrame.waitForSelector('#chat-input', { timeout: 60_000 });
  await page.waitForTimeout(1_500);

  // ── 6. Select model ──────────────────────────────────────────────────────
  await selectModel(owuiFrame, MODEL);

  // ── 7. Navigate to fresh chat & send plain-text seed ─────────────────────
  await showCaption(page, 'Connecting qwen3:4b to the Ontosphere relay…');
  await owuiFrame.goto(`${OWUI_URL}/`);
  await owuiFrame.waitForSelector('#chat-input', { timeout: 30_000 });
  await owuiFrame.waitForTimeout(1_000);

  const SEED = 'You control Ontosphere knowledge graph editor via this relay.';
  await owuiFrame.locator('#chat-input').click();
  await owuiFrame.keyboard.type(SEED, { delay: 2 });
  await owuiFrame.keyboard.press('Enter');
  await owuiFrame.waitForFunction(() => location.pathname.startsWith('/c/'), { timeout: 15_000 });

  // ── 8. Inject relay bookmarklet (fetch from app frame — same HTTP origin)
  const bookmarkletSrc = await appFrame.evaluate(async (vgUrl) => {
    const r = await (window as any).fetch('/relay-bookmarklet.js');
    let src: string = await r.text();
    src = src.replace(/__RELAY_URL__/g,    `${vgUrl}/relay.html`);
    src = src.replace(/__RELAY_ORIGIN__/g, vgUrl);
    src = src.replace(/\}\)\(\);\s*$/, [
      '  window.__vgInjectResult = injectResult;',
      '  window.__vgIsStreaming   = isAiStreaming;',
      '  window.__vgWaitForIdle  = waitForIdle;',
      '})();',
    ].join('\n'));
    return src;
  }, VG_URL);

  // Relay bookmarklet opens relay.html as a popup — wait for it
  const relayPagePromise = context.waitForEvent('page', { timeout: 15_000 });
  await owuiFrame.evaluate((src) => { (window as any).__vgRelayActive = false; new Function(src)(); }, bookmarkletSrc);
  const relayPopup = await relayPagePromise;
  await relayPopup.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(800);

  // ── 9. Wait for seed response to finish ──────────────────────────────────
  await waitIdle(owuiFrame, 120_000);
  await page.waitForTimeout(500);

  // ── 10. Send format INSTR ────────────────────────────────────────────────
  await showCaption(page, 'Sending relay format instructions to qwen3…');
  await injectText(owuiFrame, INSTR);
  await page.waitForTimeout(800);
  await clickSend(owuiFrame);
  await waitIdle(owuiFrame, 120_000);
  await page.waitForTimeout(1_000); // let injectInProgress flag reset

  // ── 11. T0–T6: Socratic turns ────────────────────────────────────────────
  for (let i = 0; i < TURNS.length; i++) {
    // "before" caption
    await showCaption(page, CAPTIONS[i].before);
    await page.waitForTimeout(2_000);

    // Inject question
    await injectText(owuiFrame, TURNS[i]);
    await page.waitForTimeout(800);
    await clickSend(owuiFrame);

    // Watch model think
    await clearCaption(page);
    await waitIdle(owuiFrame, 180_000);
    await page.waitForTimeout(800);

    // "after" caption
    await showCaption(page, CAPTIONS[i].after);
    await page.waitForTimeout(3_000);
    await clearCaption(page);
    await page.waitForTimeout(600);
  }

  // ── 12. End card ─────────────────────────────────────────────────────────
  await showCaption(page, 'Pizza ontology built step by step — guided by questions, not instructions');
  await page.waitForTimeout(5_000);
  await clearCaption(page);
});
