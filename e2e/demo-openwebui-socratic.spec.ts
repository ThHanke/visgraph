/**
 * Socratic pizza ontology demo — live qwen3:4b via OWUI relay.
 *
 * Records a side-by-side stage: OWUI live chat (left iframe) + Ontosphere canvas
 * (right iframe). qwen3:4b is guided through a pizza ontology via purely
 * conceptual Socratic questions — TBox, ABox, OWL-RL reasoning (T0–T9).
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

// Caption shown briefly before injection — tells viewer what's being asked
const TURN_TOPICS = [
  'Asking: what is the most fundamental OWL building block for a concept?',
  'Guide: build full ingredient hierarchy — PizzaTopping, PizzaBase, and 7 leaf varieties.',
  'Guide: model hasPart as an ObjectProperty with rdfs:domain and rdfs:range.',
  'Guide: add named pizza classes — SalamiPizza, HawaiianPizza, MargheritaPizza.',
  'Guide: define equivalentClass axioms via loadRdf — anonymous someValuesFrom restrictions.',
  'Guide: expand all TBox nodes to reveal their asserted properties.',
  'Guide: switch to ABox — create 3 untyped pizza individuals.',
  'Guide: build pizza1 — add Salami, Mozzarella, ThinCrust parts and hasPart links.',
  'Guide: build pizza2 (Hawaiian) and pizza3 (Margherita) — add parts and links.',
  'Guide: apply OWL-RL reasoning to derive all inferred triples.',
  'Guide: inspect pizza1, pizza2, pizza3 — trace the classification inference chain.',
];

// Caption shown after idle — describes what was just built
const AFTER_CAPTIONS = [
  'Pizza class on canvas — owl:Class, the atomic unit of OWL.',
  'Ingredient hierarchies — PizzaTopping and PizzaBase as independent classes, each with 5 and 2 leaf subclasses.',
  'hasPart ObjectProperty with rdfs:domain Pizza — ingredients stay semantically independent.',
  'Named pizza classes — SalamiPizza · HawaiianPizza · MargheritaPizza, each subClassOf Pizza.',
  'equivalentClass axioms loaded — pizza types defined by necessary-and-sufficient conditions.',
  'All TBox nodes expanded — asserted properties visible across the hierarchy.',
  'ABox view — pizza1 · pizza2 · pizza3 as bare NamedIndividuals, no class asserted.',
  'pizza1 built — salami1 · mozz1 · base1 typed and linked via hasPart.',
  'pizza2 (Hawaiian) and pizza3 (Margherita) built — all parts typed and linked.',
  'OWL-RL reasoning complete — inferred triples materialised in urn:vg:inferred.',
  'Classification! pizza1 → SalamiPizza · pizza2 → HawaiianPizza · pizza3 → MargheritaPizza — all inferred, none asserted.',
];

// T0–T10: Socratic arc guiding qwen3 through a rich pizza ontology.
// Named pizza types (SalamiPizza/HawaiianPizza/MargheritaPizza) with equivalentClass
// axioms; 3 untyped ABox pizzas classified by OWL-RL reasoning.
// Source of truth: .playwright/pizza-demo-setup.js (T0) + .playwright/turn-driver.js (T1–T10).
const TURNS = [
  // T0 — root class
  'I want to learn OWL ontology concepts through a hands-on example. I will guide you through the pizza domain step by step — one concept at a time. Rule: for each question I ask, model exactly the concept I ask about on the canvas, then stop and wait. Do not add anything beyond what I asked. Do not arrange nodes automatically. Use the ex: prefix for all IRIs (ex: maps to http://example.org/). First question: in OWL, what is the most fundamental building block for representing a concept? Create a single Pizza class — just this one node, nothing more. Wait for my next question.',

  // T1 — ingredient hierarchy: PizzaTopping + PizzaBase as INDEPENDENT classes (NOT subClassOf Pizza)
  // PizzaTopping/PizzaBase must be siblings of Pizza, not children — avoids semantic leak where
  // ingredients get inferred as Pizza via subclass chain or prp-range.
  'A pizza is made of two kinds of ingredient — a topping and a base. In OWL these form their own separate class hierarchies, distinct from the pizza itself. Add ex:PizzaTopping and ex:PizzaBase as independent owl:Class nodes — they are not a kind of pizza, so do not add any subClassOf edge to ex:Pizza. Then add five specific topping subclasses (each rdfs:subClassOf ex:PizzaTopping): ex:SalamiTopping, ex:HamTopping, ex:PineappleTopping, ex:MozzarellaTopping, ex:TomatoTopping. Add two base subclasses (each rdfs:subClassOf ex:PizzaBase): ex:ThinCrustBase, ex:DeepPanBase. All nodes and all subClassOf edges required. Then arrange the canvas. Wait for my next question.',

  // T2 — owl:ObjectProperty hasPart with rdfs:domain only (NO range)
  // Range must be omitted — declaring range=Pizza would cause prp-range to infer that ingredients
  // are pizzas, which is semantically wrong. Domain alone is sufficient for classification.
  // CRITICAL: rdfs:domain — OWL-RL does NOT read owl:domain.
  'In OWL, the relationship between a pizza and its parts is an owl:ObjectProperty. Create ex:hasPart as an ObjectProperty on the canvas. Declare its domain using rdfs:domain pointing to ex:Pizza — this tells the reasoner that anything with a hasPart connection is a pizza. Do not declare a range — leaving it open keeps ingredients semantically clean. Important: use rdfs:domain, not owl:domain. Wait for my next question.',

  // T3 — named pizza subclasses: SalamiPizza, HawaiianPizza, MargheritaPizza
  'There are many specific kinds of pizza. Add three named pizza classes: ex:SalamiPizza, ex:HawaiianPizza, and ex:MargheritaPizza. Each is a subclass of ex:Pizza — add all three nodes and all three rdfs:subClassOf ex:Pizza edges. Then arrange the hierarchy. Wait for my next question.',

  // T4 — owl:equivalentClass + owl:someValuesFrom via loadRdf
  // Blank-node restrictions are mandatory — named restriction nodes sharing owl:onProperty
  // collapse into one equivalence group (scm-svf1 bug). loadRdf is the only reliable path.
  // The manifest already tells the model addTriple cannot encode blank nodes; no need to
  // repeat that here. Prompt provides exact Turtle so qwen3 copies it verbatim.
  'In OWL a class can be defined by a necessary-and-sufficient condition — any individual that satisfies it is automatically a member. This is expressed with owl:equivalentClass using an anonymous existential restriction (owl:someValuesFrom). These three axioms define each named pizza by its characteristic topping:\n\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n@prefix ex: <http://example.org/> .\nex:SalamiPizza owl:equivalentClass [ rdf:type owl:Restriction ; owl:onProperty ex:hasPart ; owl:someValuesFrom ex:SalamiTopping ] .\nex:HawaiianPizza owl:equivalentClass [ rdf:type owl:Restriction ; owl:onProperty ex:hasPart ; owl:someValuesFrom ex:PineappleTopping ] .\nex:MargheritaPizza owl:equivalentClass [ rdf:type owl:Restriction ; owl:onProperty ex:hasPart ; owl:someValuesFrom ex:TomatoTopping ] .\n\nLoad this Turtle block into the ontology as-is — the blank nodes are intentional. Wait for my next question.',

  // T5 — expandNode all + runLayout
  'Expand all class nodes on the canvas to reveal their asserted properties, then arrange. Wait for my next question.',

  // T6 — ABox: setViewMode + 3 untyped NamedIndividuals
  // No class assertion — prp-domain (hasPart domain Pizza) will infer Pizza type.
  'Everything so far is the TBox — the schema. Switch to the individuals view (ABox) and create three pizza individuals: ex:pizza1, ex:pizza2, and ex:pizza3. Give each only the owl:NamedIndividual type — do NOT assert any pizza class (not Pizza, not SalamiPizza, nothing). Only the three bare nodes. The reasoner will classify them once we add ingredients. Arrange. Wait for my next question.',

  // T7 — build pizza1 (Salami): typed parts + hasPart connections
  // SalamiTopping is the characteristic for SalamiPizza (T4 equivalentClass).
  'Build ex:pizza1 as a Salami pizza. Add three ingredient individuals to the canvas: ex:salami1 of type ex:SalamiTopping, ex:mozz1 of type ex:MozzarellaTopping, and ex:base1 of type ex:ThinCrustBase. Connect all three to ex:pizza1 using ex:hasPart. Do not assert any pizza class on ex:pizza1 — leave it untyped; the reasoner will classify it. Wait for my next question.',

  // T8 — build pizza2 (Hawaiian) + pizza3 (Margherita) + layout
  // PineappleTopping is characteristic for HawaiianPizza; TomatoTopping for MargheritaPizza.
  'Build ex:pizza2 as a Hawaiian pizza and ex:pizza3 as a Margherita pizza. For ex:pizza2: add ex:pineapple1 of type ex:PineappleTopping, ex:ham1 of type ex:HamTopping, and ex:base2 of type ex:DeepPanBase, then connect all three to ex:pizza2 via ex:hasPart. For ex:pizza3: add ex:tom1 of type ex:TomatoTopping, ex:mozz2 of type ex:MozzarellaTopping, and ex:base3 of type ex:ThinCrustBase, then connect all three to ex:pizza3 via ex:hasPart. Do not assert any class type on pizza2 or pizza3. Reveal all node properties and arrange the canvas. Wait for my next question.',

  // T9 — runReasoning
  'The schema and all three pizzas are in place. Now apply OWL-RL reasoning to derive everything that can be inferred. Wait for my next question.',

  // T10 — classification showcase via graph query
  // queryGraph covers urn:vg:data + urn:vg:inferred by default — model should reach for it
  // naturally when asked to "verify" classification. getNodeDetails is acceptable fallback.
  // cls-svf1: pizza1 hasPart salami1 ∧ salami1 type SalamiTopping → pizza1 type _:restriction
  // cax-eqc2: _:restriction subClassOf SalamiPizza → pizza1 type SalamiPizza
  'The equivalentClass axioms we defined in the TBox should have been applied consistently across all three pizzas. Verify that the classification held: did each pizza receive the type its ingredient composition implies? Use whatever tool gives you the clearest proof — querying the graph or inspecting individual nodes. Show the evidence, state which types are inferred vs asserted, and trace the OWL-RL rule chain for at least one pizza.',
];

// ── Helpers ────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const demoStart = Date.now();
function demoLog(...args: unknown[]) {
  const s = ((Date.now() - demoStart) / 1000).toFixed(1);
  console.log(`[demo +${s}s]`, ...args);
}

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

// Shared busy-check: content-length growth OR relay has queued work.
// isAiStreaming() is NOT used — newer OWUI keeps the send button enabled while
// generating so button-state detection gives false negatives.
// We walk the DOM skipping <details> subtrees so qwen3 chain-of-thought tokens
// (streamed into hidden thinking blocks) don't keep isBusy returning true after
// the visible response has settled.
async function isBusy(frame: Frame, prevLen: number): Promise<{ busy: boolean; len: number }> {
  const state = await frame.evaluate(() => {
    const relayBusy = !((window as any).__vgIsRelayIdle?.() ?? true);
    // Walk body text nodes, skipping <details> subtrees (thinking/CoT blocks).
    let len = 0;
    function walk(node: Node) {
      if (node.nodeType === Node.TEXT_NODE) {
        len += (node.textContent ?? '').length;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        if ((node as Element).tagName === 'DETAILS') return;
        for (const child of node.childNodes) walk(child);
      }
    }
    walk(document.body);
    return { relayBusy, len };
  }).catch(() => ({ relayBusy: false, len: prevLen }));
  const growing = prevLen >= 0 && state.len !== prevLen;
  return { busy: state.relayBusy || growing, len: state.len };
}

// Wait until quiet for stableMs. Used for SEED/INSTR phases (short window).
async function waitIdle(frame: Frame, timeout = 300_000, stableMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  const pollMs = 500;
  let silentMs = 0;
  let lastLen = -1;
  while (Date.now() < deadline) {
    const { busy, len } = await isBusy(frame, lastLen);
    lastLen = len;
    if (busy) silentMs = 0; else silentMs += pollMs;
    if (silentMs >= stableMs) return true;
    await sleep(pollMs);
  }
  return false;
}

// Wait for quietMs of continuous silence — relay fully drained, no content growth.
// Resets if the model spontaneously makes more calls during the gap.
// maxMs caps the total wait so OWUI background updates (thinking dots, timestamps)
// can't reset the timer indefinitely and stall the run.
async function waitQuiet(frame: Frame, quietMs = 10_000, maxMs = 45_000): Promise<void> {
  const pollMs = 500;
  let silentMs = 0;
  let lastLen = -1;
  const deadline = Date.now() + maxMs;
  while (silentMs < quietMs && Date.now() < deadline) {
    const { busy, len } = await isBusy(frame, lastLen);
    lastLen = len;
    if (busy) silentMs = 0; else silentMs += pollMs;
    await sleep(pollMs);
  }
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
  await frame.locator('#send-message-button:not([disabled])').click({ timeout: 3_000 }).catch(() => {});
}

// Type text character-by-character into the chat input and press Enter.
// Looks like the user is typing — makes the demo easy to follow.
async function typeAndSend(frame: Frame, page: Page, text: string): Promise<void> {
  await frame.locator('#chat-input').click();
  await page.keyboard.type(text, { delay: 18 });
  await sleep(400);
  await page.keyboard.press('Enter');
}

// ── Test ──────────────────────────────────────────────────────────────────────

test('openwebui-socratic: Socratic pizza ontology — live qwen3:4b via OWUI relay', async ({ page, context }) => {
  test.setTimeout(2_700_000); // 45 min — qwen3 reasoning turns can be slow

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

  // ── 2. Pre-auth throwaway pages ───────────────────────────────────────────
  // addInitScript only runs in top-level frames, not iframes. Navigate to each
  // origin on a real page first — this seeds localStorage for both OWUI and the
  // Ontosphere app in the shared context storage. Their iframes then read it.
  demoLog('step 1: auth pre-seed — navigating to OWUI');
  const authPage = await context.newPage();
  await authPage.goto(`${OWUI_URL}/`);
  await authPage.waitForSelector('#chat-input', { timeout: 60_000 });
  await authPage.close();
  demoLog('step 1: OWUI auth OK');

  const appAuthPage = await context.newPage();
  await appAuthPage.goto(`${VG_URL}/`);
  await appAuthPage.waitForFunction(() => !!(window as any).__mcpTools?.addNode, { timeout: 30_000 });
  await appAuthPage.evaluate(() => {
    localStorage.setItem('ontology-painter-config', JSON.stringify({
      config: { autoApplyLayout: true, workflowCatalogEnabled: false },
    }));
  });
  await appAuthPage.close();
  demoLog('step 1: app auth OK');

  // ── 3. Load side-by-side stage (this is the recorded page) ────────────────
  // ?ontologies=owl,rdf,rdfs on the app URL replaces the 6 default additionalOntologies
  // (PROV/P-PLAN/QUDT + core W3C) with only the 3 W3C vocabs needed for OWL-RL reasoning.
  const appUrl = `${VG_URL}/?ontologies=${encodeURIComponent('owl,rdf,rdfs')}`;
  const stageUrl = `${VG_URL}/demo-stage-owui.html`
    + `?owui=${encodeURIComponent(OWUI_URL + '/')}`
    + `&app=${encodeURIComponent(appUrl)}`;
  demoLog('step 2: loading stage page');
  await page.goto(stageUrl);
  await caption(page, 'Loading Ontosphere × OpenWebUI demo stage…');

  // ── 4. Wait for both iframes to become active ─────────────────────────────
  const appFrame  = await waitForFrame(page, VG_URL);
  const chatFrame = await waitForFrame(page, OWUI_URL, 90_000);
  await appFrame.waitForFunction(() => !!(window as any).__mcpTools?.addNode, { timeout: 30_000 });
  await chatFrame.locator('#chat-input').waitFor({ timeout: 90_000 });
  demoLog('step 3: both frames ready');
  // Hide broken model avatar images — profile pic URLs don't resolve in the iframe context,
  // leaving a broken-image placeholder next to every model response. MutationObserver ensures
  // dynamically added images (new chat messages) are also caught.
  await chatFrame.evaluate(() => {
    const hide = (img: HTMLImageElement) => { img.style.display = 'none'; };
    document.querySelectorAll<HTMLImageElement>('img').forEach(img => {
      img.addEventListener('error', () => hide(img), { once: true });
      if (img.complete && img.naturalWidth === 0) hide(img);
    });
    new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        if ((n as Element).querySelectorAll)
          (n as Element).querySelectorAll<HTMLImageElement>('img').forEach(img =>
            img.addEventListener('error', () => hide(img), { once: true })
          );
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
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

  // ── 6. Type full README starter prompt → creates /c/ URL ──────────────────
  // Source of truth: README.md "Starter prompt" section.
  // Typed line-by-line with Shift+Enter — same mechanism as Socratic questions.
  // The embedded id:0 help() call is pre-seeded by the relay on startup and will
  // NOT be re-executed. Only the model's own help() call in its response fires.
  await caption(page, 'Sending relay starter prompt…');
  const STARTER_LINES = [
    'You are connected to Ontosphere via a relay. A script in this tab intercepts your tool calls, runs them in Ontosphere, and injects results back as a user message. Ask the user what they would like to build.',
    '',
    'Output format — one JSON-RPC 2.0 call per line, backtick-wrapped:',
    '`{"jsonrpc":"2.0","id":<N>,"method":"tools/call","params":{"name":"<toolName>","arguments":{...}}}`',
    '',
    'Call help first to get full instructions and the tool list:',
    '`{"jsonrpc":"2.0","id":0,"method":"tools/call","params":{"name":"help","arguments":{}}}`',
  ];
  await chatFrame.locator('#chat-input').click();
  for (let i = 0; i < STARTER_LINES.length; i++) {
    if (STARTER_LINES[i]) await page.keyboard.type(STARTER_LINES[i], { delay: 2 });
    if (i < STARTER_LINES.length - 1) await page.keyboard.press('Shift+Enter');
  }
  demoLog('step 5: sending starter prompt');
  await page.keyboard.press('Enter');
  await chatFrame.waitForFunction(() => location.pathname.startsWith('/c/'), { timeout: 15_000 });
  demoLog('step 5: starter prompt sent, chat URL:', await chatFrame.evaluate(() => location.pathname));

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
      '  window.__vgIsRelayIdle  = function() { return callQueue.length === 0 && !isProcessing; };',
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

  // ── 9. Wait for model's help() cycle to complete ──────────────────────────
  // Model reads starter prompt → calls help() itself → relay executes → model reads
  // manifest and responds. waitIdle waits for 3 s of content+relay silence.
  demoLog('step 6: relay injected — waiting for model help() cycle (up to 3 min)');
  await caption(page, 'Model familiarising with MCP tools — calling help()…');
  await waitIdle(chatFrame, 180_000);
  demoLog('step 6: help() cycle done');
  // Hold 10 s so viewers can see the model reading the tool manifest before we start.
  await sleep(10_000);
  await clearCaption(page);

  // ── 10. Socratic turns ────────────────────────────────────────────────────
  await clearCaption(page);
  for (let i = 0; i < TURNS.length; i++) {
    demoLog(`turn ${i + 1}/${TURNS.length}: "${TURN_TOPICS[i]}" — sending`);
    // Before: brief label so viewer knows what concept is being asked about
    await caption(page, TURN_TOPICS[i]);
    await sleep(2_000);

    // Type the question visually — looks like the user is writing it live
    await typeAndSend(chatFrame, page, TURNS[i]);

    // Clear caption while model generates — the live chat + canvas are the show
    await clearCaption(page);
    await waitIdle(chatFrame, 300_000);
    demoLog(`turn ${i + 1}/${TURNS.length}: idle — model done`);

    // Caption goes up the moment the model first goes idle so viewers can read
    // what was built. waitQuiet holds for 10 s of continuous silence — resets
    // if the model spontaneously makes more tool calls during that window.
    await caption(page, AFTER_CAPTIONS[i]);
    await waitQuiet(chatFrame, 10_000);
    await clearCaption(page);
    await sleep(1_000);
  }

  // ── 11. End card ──────────────────────────────────────────────────────────
  demoLog('all turns done — end card');
  await caption(page, 'Pizza ontology — TBox · ABox · named pizza classes · equivalentClass axioms · OWL-RL classification — built through Socratic questioning alone');
  await sleep(6_000);
  await clearCaption(page);

  // ── 12. Save video ────────────────────────────────────────────────────────
  // saveAs() waits for the page to close before it can finalise the video.
  // Closing the page here lets saveAs complete immediately rather than blocking.
  const videoOutDir = path.resolve(__dirname, '../test-results/demo/demo-openwebui-socratic-op-52070-ive-qwen3-4b-via-OWUI-relay-openwebui-demo');
  fs.mkdirSync(videoOutDir, { recursive: true });
  const videoPath = path.join(videoOutDir, 'video.webm');
  const video = page.video();
  await page.close();
  await video?.saveAs(videoPath).catch(() => {/* video unavailable — non-fatal */});
  demoLog('video saved →', videoPath);
});
