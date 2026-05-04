/**
 * Socratic pizza ontology demo — live qwen3:4b via OWUI relay.
 *
 * Records a side-by-side stage: OWUI live chat (left iframe) + Ontosphere canvas
 * (right iframe). qwen3:4b is guided through the full Manchester Pizza Ontology
 * tutorial via Socratic questions — TBox, ABox, OWL-RL reasoning.
 *
 * Auth note: context.addInitScript does not run inside iframes. Fix: a throwaway
 * authPage pre-seeds OWUI localStorage in the browser context before the stage
 * loads; the OWUI iframe then reads pre-existing storage on its own.
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

import { test, Page, Frame } from '@playwright/test';
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
  'Can you teach me how ontologies work using pizzas as an example? Start by switching to TBox view and adding the three fundamental categories: Pizza, PizzaBase, and PizzaTopping.',
  // T1 — disjointness
  'Those three classes look separate, but how does OWL know they truly cannot overlap? Can you add the disjointWith declarations between them?',
  // T2 — base subclasses
  'How do I model different kinds of pizza base — thin crust versus deep pan? Add them as subclasses of PizzaBase and declare them disjoint from each other.',
  // T3 — named pizzas
  'Can hierarchies go deeper? Add a NamedPizza intermediate class, then place Margherita, AmericanHot, and FruttiDiMare beneath it as subclasses.',
  // T4 — topping categories
  'What about toppings — should they all sit directly under PizzaTopping, or is a category structure better? Add CheeseTopping, MeatTopping, VegetableTopping, and FishTopping as topping sub-categories.',
  // T5 — topping disjointness
  'Why do the topping categories also need owl:disjointWith? Add those disjointness assertions between all four categories.',
  // T6 — leaf toppings
  'Now add the real ingredients: Mozzarella and Parmesan under CheeseTopping, PeperoniSausage under MeatTopping, Tomato + Olive + Garlic under VegetableTopping, Anchovies under FishTopping.',
  // T7 — object properties
  'The classes are ready, but how do we link pizzas to their toppings and bases? Add object properties hasTopping and hasBase with domain and range constraints.',
  // T8 — inverse properties
  'Can we navigate in the opposite direction — from a topping back to its pizza? Add isToppingOf and isBaseOf as inverse properties with their own domain and range.',
  // T9 — OWL restrictions
  'The reasoner can infer pizza1 is a Pizza from the domain constraint — but how would it know it\'s a Margherita specifically? Use loadRdf to add the owl:equivalentClass someValuesFrom restriction for Margherita (TomatoTopping), AmericanHot (PeperoniSausageTopping), and FruttiDiMare (AnchoviesTopping). Use ex: prefix = http://www.pizza-ontology.com/pizza.owl#',
  // T10 — ABox
  "Those were the class definitions — the TBox. Now add actual pizza individuals. Switch to ABox view and add pizza1, pizza2, pizza3 as individuals WITHOUT asserting their types.",
  // T11 — pizza1 (Margherita)
  'Build a Margherita-style pizza1: add mozz1 as MozzarellaTopping individual, tom1 as TomatoTopping, thin1 as ThinAndCrispyBase, then connect them to pizza1 with hasTopping and hasBase.',
  // T12 — pizza2 (AmericanHot)
  'Now pizza2 — an AmericanHot. Add pep1 as PeperoniSausageTopping, mozz2 as MozzarellaTopping, olive1 as OliveTopping, deep1 as DeepPanBase, then connect them to pizza2.',
  // T13 — pizza3 (FruttiDiMare)
  'And pizza3 — FruttiDiMare. Add anch1 as AnchoviesTopping, garlic1 as GarlicTopping, thin2 as ThinAndCrispyBase, then connect them to pizza3.',
  // T14 — reasoning
  'We have schema and data but no inferred facts yet. Can you run the OWL-RL reasoner to materialise all entailed triples? Call runReasoning with empty arguments.',
  // T15 — inspect pizza1
  'What did the reasoner figure out about pizza1? Use focusNode and expandNode to inspect it.',
  // T16 — inspect mozz1
  'What about mozz1 — what types did the reasoner infer for that individual? Use focusNode and expandNode to inspect it.',
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

// ── Helpers ────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function waitForFrame(page: Page, urlPrefix: string, timeout = 60_000): Promise<Frame> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // parentFrame() !== null excludes the main frame when VG_URL matches both
    const f = page.frames().find(fr => fr.url().startsWith(urlPrefix) && fr.parentFrame() !== null);
    if (f) return f;
    await sleep(500);
  }
  throw new Error(`Timeout waiting for frame with URL prefix: ${urlPrefix}`);
}

async function caption(page: Page, text: string): Promise<void> {
  await page.evaluate((t) => {
    let el = document.getElementById('__cap__') as HTMLElement | null;
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
    el.style.display = 'block';
  }, text);
}

async function clearCaption(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById('__cap__');
    if (el) el.style.display = 'none';
  });
}

async function waitIdle(frame: Frame, timeout = 300_000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const streaming = await frame.evaluate(() => (window as any).__vgIsStreaming?.() ?? false).catch(() => false);
    if (!streaming) return true;
    await sleep(1000);
  }
  return false;
}

async function inject(frame: Frame, text: string, retries = 8): Promise<boolean> {
  for (let i = 0; i < retries; i++) {
    const ok = await frame.evaluate(
      (t) => typeof (window as any).__vgInjectResult === 'function'
        ? (window as any).__vgInjectResult(t) : false,
      text,
    ).catch(() => false);
    if (ok !== false) return true;
    await sleep(500);
  }
  return false;
}

async function clickSend(frame: Frame): Promise<void> {
  const btn = await frame.$('#send-message-button:not([disabled])');
  if (btn) await btn.click();
}

// ── Test ──────────────────────────────────────────────────────────────────────

test('openwebui-socratic: Socratic pizza ontology — live qwen3:4b via OWUI relay', async ({ page, context }) => {
  test.setTimeout(900_000);

  // ── 1. Restore cookies; register init script for localStorage ──────────────
  if (fs.existsSync(AUTH_FILE)) {
    const state = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')) as {
      cookies?: Array<Record<string, unknown>>;
      origins?: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
    };
    if (state.cookies?.length)
      await context.addCookies(state.cookies as unknown as Parameters<typeof context.addCookies>[0]);
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

  // ── 2. Pre-auth throwaway page ─────────────────────────────────────────────
  // addInitScript only runs in top-level frames, not iframes. Navigate to OWUI
  // on a real page first — this seeds localStorage for the OWUI origin in the
  // shared context storage. The OWUI iframe in the stage then reads it directly.
  const authPage = await context.newPage();
  await authPage.goto(`${OWUI_URL}/`);
  await authPage.waitForSelector('#chat-input', { timeout: 60_000 });
  await authPage.close();

  // ── 3. Load side-by-side stage (this is the recorded page) ────────────────
  const stageUrl = `${VG_URL}/demo-stage-owui.html`
    + `?owui=${encodeURIComponent(OWUI_URL + '/')}`
    + `&app=${encodeURIComponent(VG_URL + '/')}`;
  await page.goto(stageUrl);
  await caption(page, 'Loading Ontosphere × OpenWebUI demo stage…');

  // ── 4. Wait for both iframes to become active ─────────────────────────────
  const appFrame  = await waitForFrame(page, VG_URL);
  const chatFrame = await waitForFrame(page, OWUI_URL, 90_000);
  await appFrame.waitForFunction(() => !!(window as any).__mcpTools?.addNode, { timeout: 30_000 });
  await chatFrame.locator('#chat-input').waitFor({ timeout: 90_000 });
  await sleep(1_500);

  // ── 5. Select model ────────────────────────────────────────────────────────
  while (true) {
    const rm = await chatFrame.$('button[aria-label*="Remove Model"]');
    if (!rm) break;
    await rm.click();
    await sleep(300);
  }
  const modelBtn = await chatFrame.$('#model-selector-0-button');
  if (modelBtn) {
    await modelBtn.click();
    await sleep(400);
    const search = await chatFrame.$('input[placeholder*="Search" i]');
    if (search) { await search.fill(MODEL); await sleep(400); }
    const pick = await chatFrame.$(`button:has-text("${MODEL}")`);
    if (pick) { await pick.click(); await sleep(400); }
  }

  // ── 6. Send plain-text seed → creates /c/ URL ─────────────────────────────
  await caption(page, 'Seeding the relay session…');
  const SEED = 'You control Ontosphere knowledge graph editor via this relay.';
  await chatFrame.locator('#chat-input').click();
  await page.keyboard.type(SEED, { delay: 2 });
  await page.keyboard.press('Enter');
  await chatFrame.waitForFunction(() => location.pathname.startsWith('/c/'), { timeout: 15_000 });

  // ── 7. Fetch relay code from appFrame (HTTP — no mixed-content) ───────────
  const relayCode = await appFrame.evaluate(async (vgUrl: string) => {
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

  // ── 8. Inject relay into OWUI frame — opens relay popup ───────────────────
  const relayPopupPromise = context.waitForEvent('page', { timeout: 20_000 });
  await chatFrame.evaluate((src: string) => { new Function(src)(); }, relayCode);
  const relayPopup = await relayPopupPromise;
  await relayPopup.waitForLoadState('domcontentloaded');
  await sleep(500);

  // ── 9. Wait for seed idle ─────────────────────────────────────────────────
  await clearCaption(page);
  await waitIdle(chatFrame, 120_000);
  await sleep(500);

  // ── 10. Send INSTR (format only, no task) ─────────────────────────────────
  await caption(page, 'Sending relay format instructions…');
  await inject(chatFrame, INSTR);
  await sleep(800);
  await clickSend(chatFrame);
  await waitIdle(chatFrame, 120_000);
  await sleep(1_000); // let injectInProgress flag reset before T0

  // ── 11. T0–T16: Socratic turns ────────────────────────────────────────────
  await clearCaption(page);
  for (let i = 0; i < TURNS.length; i++) {
    await caption(page, CAPTIONS[i].before);
    await sleep(2_500);

    await inject(chatFrame, TURNS[i]);
    await sleep(800);
    await clickSend(chatFrame);

    await clearCaption(page);
    await waitIdle(chatFrame, 300_000);
    await sleep(800);

    await caption(page, CAPTIONS[i].after);
    await sleep(3_500);
    await clearCaption(page);
    await sleep(600);
  }

  // ── 12. End card ──────────────────────────────────────────────────────────
  await caption(page, 'Full Manchester Pizza Ontology — built and classified by OWL-RL reasoning via Socratic questioning');
  await sleep(5_500);
  await clearCaption(page);
});
