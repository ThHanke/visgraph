/**
 * Socratic pizza ontology demo — live qwen3:4b via OWUI relay.
 *
 * Records the Ontosphere canvas (full viewport) with caption overlays.
 * OWUI runs in a background page — relay tool calls fire as toasts on the
 * canvas so the viewer sees the ontology build in real time.
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

import { test, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OWUI_URL  = process.env.OWUI_URL  || 'https://gpuserver1-sit.iwm.fraunhofer.de';
const VG_URL    = process.env.DEMO_BASE_URL || 'http://localhost:8080';
const AUTH_FILE = path.resolve(__dirname, '../.playwright/owui-auth.json');
const MODEL     = 'qwen3:4b';

const INSTR = [
  'RELAY FORMAT — single backtick JSON-RPC 2.0 only. ALL other formats silently ignored:',
  '`{"jsonrpc":"2.0","id":N,"method":"tools/call","params":{"name":"TOOL","arguments":{...}}}`',
  'WRONG (silently ignored): triple-backtick, <tool_call>, {"tool":"x",...}',
  '',
  'Key tools:',
  '  addNode(iri, typeIri?, label?)                         — add class/property/individual',
  '  addLink(subjectIri, predicateIri, objectIri)           — add triple',
  '  loadRdf(turtle)                                        — load Turtle string (for blank nodes / restrictions)',
  '  setViewMode(mode)                                      — "tbox" | "abox"',
  '  runLayout(algorithm)                                   — dagre-tb | elk-layered | dagre-lr',
  '  runReasoning({})                                       — run OWL-RL forward-chaining reasoner',
  '  expandAll({})                                          — expand all canvas nodes',
  '  focusNode(iri)                                         — focus a node',
  '  expandNode(iri, expand)                                — expand/collapse a node',
  '  getNodeDetails(iri)                                    — inspect entity properties',
  '',
  'Key IRIs:',
  '  owl:Class            = http://www.w3.org/2002/07/owl#Class',
  '  owl:ObjectProperty   = http://www.w3.org/2002/07/owl#ObjectProperty',
  '  owl:disjointWith     = http://www.w3.org/2002/07/owl#disjointWith',
  '  owl:inverseOf        = http://www.w3.org/2002/07/owl#inverseOf',
  '  rdfs:subClassOf      = http://www.w3.org/2000/01/rdf-schema#subClassOf',
  '  rdfs:domain          = http://www.w3.org/2000/01/rdf-schema#domain',
  '  rdfs:range           = http://www.w3.org/2000/01/rdf-schema#range',
  '  ex:                  = http://www.pizza-ontology.com/pizza.owl#',
  '',
  'Respond with ONLY backtick-wrapped calls. No prose.',
].join('\n');

const TURNS = [
  // T0 — root classes
  'Can you teach me how ontologies work using pizzas as an example? Start by adding the three fundamental categories — Pizza, PizzaBase, and PizzaTopping — and switch to TBox view first.',
  // T1 — disjointness
  'Those three classes look separate, but how does OWL know they truly cannot overlap? Can you add the disjointWith declarations?',
  // T2 — base subclasses
  'How do I model different kinds of pizza base — thin crust versus deep pan? Add them as subclasses and declare them disjoint from each other.',
  // T3 — named pizzas
  'Can hierarchies go deeper? Add a NamedPizza intermediate class, then place Margherita, AmericanHot, and FruttiDiMare beneath it.',
  // T4 — topping categories
  'What about toppings — should they all sit directly under PizzaTopping, or is a category structure better? Add CheeseTopping, MeatTopping, VegetableTopping, and FishTopping.',
  // T5 — topping disjointness
  'Why do the topping categories also need owl:disjointWith? Add those disjointness assertions.',
  // T6 — leaf toppings
  'Now add the real ingredients: Mozzarella and Parmesan under Cheese, PeperoniSausage under Meat, Tomato + Olive + Garlic under Vegetable, Anchovies under Fish.',
  // T7 — object properties
  'The classes are ready, but how do we link pizzas to their toppings and bases? Add object properties hasTopping and hasBase with domain and range constraints.',
  // T8 — inverse properties
  'Can we navigate in the opposite direction — from a topping back to its pizza? Add isToppingOf and isBaseOf as inverse properties.',
  // T9 — OWL restrictions
  'The reasoner can infer pizza1 is a Pizza from the domain constraint — but how would it know it\'s a Margherita specifically? Add the owl:equivalentClass someValuesFrom restriction for Margherita, AmericanHot, and FruttiDiMare using loadRdf.',
  // T10 — ABox
  "Those were all class definitions — the TBox. When do we add actual pizza individuals? Switch to ABox view and add pizza1, pizza2, pizza3 without asserting their types.",
  // T11 — pizza1
  'Build a Margherita-style pizza1: add mozzarella and tomato topping individuals, a thin-and-crispy base, and connect them to pizza1 with hasTopping and hasBase.',
  // T12 — pizza2
  'Now pizza2 — an AmericanHot. What toppings and base does it need? Add and connect them.',
  // T13 — pizza3
  'And pizza3 — FruttiDiMare. Add anchovies and garlic as toppings on a thin-and-crispy base.',
  // T14 — reasoning
  'We have the schema and the data but no inferred facts. Can you run the OWL-RL reasoner to materialise all the entailed triples?',
  // T15 — inspect pizza1
  'What did the reasoner figure out about pizza1? Focus on it and expand its properties.',
  // T16 — inspect mozz1
  'What about mozz1 — what types did the reasoner infer for that individual? Focus on it.',
];

const CAPTIONS = [
  { before: 'T0 — Asking qwen3 to add the three root OWL classes in TBox view.',
    after:  'Pizza, PizzaBase, PizzaTopping added. Next: disjointness.' },
  { before: 'T1 — Explaining owl:disjointWith — the Open World Assumption.',
    after:  'Pairwise disjoint declared. Next: base subclasses.' },
  { before: 'T2 — DeepPanBase and ThinAndCrispyBase as rdfs:subClassOf PizzaBase.',
    after:  'Base hierarchy complete. Next: named pizza subclasses.' },
  { before: 'T3 — Introducing NamedPizza + Margherita, AmericanHot, FruttiDiMare.',
    after:  'Named pizza classes placed. Next: topping categories.' },
  { before: 'T4 — Mid-level topping categories: Cheese, Meat, Vegetable, Fish.',
    after:  'Topping hierarchy established. Next: topping disjointness.' },
  { before: 'T5 — owl:disjointWith between all four topping categories.',
    after:  'Topping disjointness declared. Next: leaf ingredient classes.' },
  { before: 'T6 — Populating categories with real ingredient classes.',
    after:  'Seven leaf toppings added. Next: object properties.' },
  { before: 'T7 — hasTopping and hasBase with domain/range constraints.',
    after:  'Object properties connected. Next: inverse properties.' },
  { before: 'T8 — isToppingOf and isBaseOf as owl:inverseOf.',
    after:  'Inverse properties declared. Next: OWL restrictions.' },
  { before: 'T9 — owl:equivalentClass + owl:someValuesFrom defines named pizza types.',
    after:  'Restrictions loaded. Next: switching to ABox for individuals.' },
  { before: 'T10 — ABox view: three untyped pizza individuals.',
    after:  'Individuals added without type assertions. Next: Margherita.' },
  { before: 'T11 — pizza1: Margherita — mozzarella + tomato + thin base.',
    after:  'pizza1 built. Next: pizza2 AmericanHot.' },
  { before: 'T12 — pizza2: AmericanHot — peperoni + mozzarella + olive + deep pan.',
    after:  'pizza2 built. Next: pizza3 FruttiDiMare.' },
  { before: 'T13 — pizza3: FruttiDiMare — anchovies + garlic + thin base.',
    after:  'All three pizzas built. Next: running OWL-RL reasoner.' },
  { before: 'T14 — Running OWL-RL forward-chaining reasoner.',
    after:  'Reasoning complete — inferred types materialised. Next: inspect pizza1.' },
  { before: 'T15 — Inspecting pizza1: expect Margherita type via cls-svf1.',
    after:  'pizza1 classified as Margherita by the reasoner! Next: inspect mozz1.' },
  { before: 'T16 — Inspecting mozz1: expect PizzaTopping via range constraint + subClassOf chain.',
    after:  'Full Manchester Pizza Ontology — built and reasoned via Socratic questioning.' },
];

// ── Caption overlay ────────────────────────────────────────────────────────

async function caption(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    let el = document.getElementById('__cap__');
    if (!el) {
      el = document.createElement('div');
      el.id = '__cap__';
      Object.assign(el.style, {
        position: 'fixed', bottom: '36px', left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(0,0,0,0.84)', color: '#fff',
        font: '600 17px/1.45 "Inter",sans-serif',
        padding: '13px 30px', borderRadius: '8px',
        zIndex: '99999', pointerEvents: 'none',
        maxWidth: '80%', textAlign: 'center',
        boxShadow: '0 4px 28px rgba(0,0,0,0.45)',
      });
      document.body.appendChild(el);
    }
    el.textContent = t;
    (el as HTMLElement).style.display = 'block';
  }, text);
}

async function clearCaption(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById('__cap__');
    if (el) el.style.display = 'none';
  });
}

// ── OWUI helpers ──────────────────────────────────────────────────────────

async function waitIdle(owui: Page, timeout = 180_000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const streaming = await owui.evaluate(() => (window as any).__vgIsStreaming?.() ?? false).catch(() => false);
    if (!streaming) return true;
    await owui.waitForTimeout(1000);
  }
  return false;
}

async function inject(owui: Page, text: string, retries = 8): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    const ok = await owui.evaluate(
      (t) => typeof (window as any).__vgInjectResult === 'function'
        ? (window as any).__vgInjectResult(t) : false,
      text,
    ).catch(() => false);
    if (ok !== false) return true;
    await owui.waitForTimeout(500);
  }
  return false;
}

async function clickSend(owui: Page): Promise<void> {
  const btn = await owui.$('#send-message-button:not([disabled])');
  if (btn) await btn.click();
}

// ── Test ──────────────────────────────────────────────────────────────────

test('openwebui-socratic: Socratic pizza ontology — live qwen3:4b via OWUI relay', async ({ page, context }) => {
  test.setTimeout(900_000);

  // ── 1. Recorded page: Ontosphere canvas ───────────────────────────────
  await page.goto(VG_URL);
  await page.waitForFunction(() => !!(window as any).__mcpTools?.addNode, { timeout: 30_000 });

  await caption(page, 'Connecting qwen3:4b to the Ontosphere relay…');
  await page.waitForTimeout(2_000);

  // ── 2. Background OWUI page — restore auth ───────────────────────────
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

  const owui = await context.newPage();
  await owui.goto(`${OWUI_URL}/`);
  await owui.waitForSelector('#chat-input', { timeout: 60_000 });
  await owui.waitForTimeout(1_500);

  // ── 3. Select model ──────────────────────────────────────────────────
  while (true) {
    const rm = await owui.$('button[aria-label*="Remove Model"]');
    if (!rm) break;
    await rm.click();
    await owui.waitForTimeout(300);
  }
  const modelBtn = await owui.$('#model-selector-0-button');
  if (modelBtn) {
    await modelBtn.click();
    await owui.waitForTimeout(400);
    const search = await owui.$('input[placeholder*="Search" i]');
    if (search) { await search.fill(MODEL); await owui.waitForTimeout(400); }
    const pick = await owui.$(`button:has-text("${MODEL}")`);
    if (pick) { await pick.click(); await owui.waitForTimeout(400); }
  }

  // ── 4. Send plain-text seed → creates /c/ URL ────────────────────────
  await caption(page, 'Seeding the relay session…');
  const SEED = 'You control Ontosphere knowledge graph editor via this relay.';
  await owui.locator('#chat-input').click();
  await owui.keyboard.type(SEED, { delay: 2 });
  await owui.keyboard.press('Enter');
  await owui.waitForFunction(() => location.pathname.startsWith('/c/'), { timeout: 15_000 });

  // ── 5. Inject relay bookmarklet (no popup — expose internals) ────────
  const relayCode = await page.evaluate(async (vgUrl: string) => {
    const r = await fetch('/relay-bookmarklet.js');
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

  const relayPopupPromise = context.waitForEvent('page', { timeout: 15_000 });
  await owui.evaluate((src) => { (window as any).__vgRelayActive = false; new Function(src)(); }, relayCode);
  const relayPopup = await relayPopupPromise;
  await relayPopup.waitForLoadState('domcontentloaded');
  await owui.waitForTimeout(500);

  // ── 6. Wait for seed idle ────────────────────────────────────────────
  await waitIdle(owui, 120_000);
  await owui.waitForTimeout(500);

  // ── 7. Send INSTR (format only) ──────────────────────────────────────
  await caption(page, 'Sending relay format instructions…');
  await inject(owui, INSTR);
  await owui.waitForTimeout(800);
  await clickSend(owui);
  await waitIdle(owui, 120_000);
  await owui.waitForTimeout(1_000);

  // ── 8. T0–T6: Socratic turns ─────────────────────────────────────────
  for (let i = 0; i < TURNS.length; i++) {
    await caption(page, CAPTIONS[i].before);
    await page.waitForTimeout(2_500);

    await inject(owui, TURNS[i]);
    await owui.waitForTimeout(800);
    await clickSend(owui);

    await clearCaption(page);
    await waitIdle(owui, 180_000);
    await owui.waitForTimeout(800);

    await caption(page, CAPTIONS[i].after);
    await page.waitForTimeout(3_500);
    await clearCaption(page);
    await page.waitForTimeout(600);
  }

  // ── 9. End card ──────────────────────────────────────────────────────
  await caption(page, 'Full Manchester Pizza Ontology — built and classified by OWL-RL reasoning via Socratic questioning');
  await page.waitForTimeout(5_500);
  await clearCaption(page);
});
