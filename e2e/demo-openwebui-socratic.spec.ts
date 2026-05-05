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
  'Guide: model the two building blocks of a pizza as sub-categories.',
  'Guide: can the two building blocks ever belong to the same individual?',
  'Guide: add two concrete varieties under each building block.',
  'Guide: how does OWL express that a Pizza is composed of its parts?',
  'Guide: reveal all asserted properties on the Pizza class node.',
  'Guide: switch to individuals — create a real pizza instance (no class yet).',
  'Guide: add typed part individuals and connect them — leave pizza untyped.',
  'Guide: apply OWL-RL reasoning to derive everything implicit.',
  'Guide: what did the reasoner infer about the pizza individual?',
  'Guide: inspect the part individuals — trace the subclass inference chain.',
];

// Caption shown after idle — describes what was just built
const AFTER_CAPTIONS = [
  'Pizza class on canvas — owl:Class, the atomic unit of OWL.',
  'rdfs:subClassOf hierarchy — two building blocks visible beneath Pizza.',
  'owl:disjointWith asserted — the two blocks can never overlap.',
  'Third level of hierarchy — concrete varieties under each building block.',
  'owl:ObjectProperty with domain + range — named composition link in the ontology.',
  'expandNode reveals all asserted properties on the Pizza class.',
  'owl:NamedIndividual in ABox view — no class asserted yet, only individual type.',
  'Parts typed as specific varieties, linked via hasPart — pizza individual still untyped.',
  'OWL-RL reasoning complete — inferred triples materialised.',
  'Pizza individual now carries inferred rdf:type Pizza — derived via domain rule.',
  'Parts inherit types up the subClass chain — ontology complete.',
];

// T0–T9: validated Socratic arc — purely conceptual, no tool-name references.
// Model maps OWL concept → tool from the manifest returned by help().
// Source of truth: .playwright/pizza-demo-setup.js (T0) + .playwright/turn-driver.js (T1–T9).
const TURNS = [
  // T0 — root class
  'I want to learn OWL ontology concepts through a hands-on example. I will guide you through the pizza domain step by step — one concept at a time. Rule: for each question I ask, model exactly the concept I ask about on the canvas, then stop and wait. Do not add anything beyond what I asked. Do not arrange nodes automatically. Use the ex: prefix for all IRIs (ex: maps to http://example.org/). First question: in OWL, what is the most fundamental building block for representing a concept? Create a single Pizza class — just this one node, nothing more. Wait for my next question.',

  // T1 — rdfs:subClassOf hierarchy + runLayout
  // Both edges mandatory — qwen3 reliably adds only one without explicit AND.
  'A pizza is made from two distinct building blocks — a base and a topping. In OWL, rdfs:subClassOf places a class beneath its parent. Create a class for the base and a class for the topping, then add both subClassOf edges: base subClassOf Pizza AND topping subClassOf Pizza. Both edges are required — do not stop after just one. Keep using the ex: prefix. Then arrange the hierarchy. Wait for my next question.',

  // T2 — owl:disjointWith
  'In OWL, classes can be declared mutually exclusive — no individual can belong to both at the same time. Should the two building blocks of a pizza be disjoint from each other? If so, express that relationship on the canvas. Wait for my next question.',

  // T3 — deepen hierarchy + runLayout
  'Good. Each building block has concrete varieties — for example a dough might be thin-crust or thick-crust. Add two specific sub-types under each building block, then arrange the hierarchy. Wait for my next question.',

  // T4 — owl:ObjectProperty with domain + range
  // Range = Pizza (superclass) to avoid prp-range triggering cax-dw inconsistency.
  // CRITICAL: rdfs:domain / rdfs:range — OWL-RL rules do NOT read owl:domain/range.
  'In OWL, composition is modelled with an owl:ObjectProperty — a named relationship that is itself a first-class node in the ontology, not just an edge. Create an object property called hasPart. Then declare its domain and range using exactly these predicates: rdfs:domain pointing to Pizza, and rdfs:range pointing to Pizza. Important: use rdfs:domain and rdfs:range — not owl:domain or owl:range. Add it to the canvas now. Wait for my next question.',

  // T5 — expandNode
  'Expand the Pizza class node on the canvas so I can see all its asserted properties. Wait for my next question.',

  // T6 — ABox individual with NO class assertion (only owl:NamedIndividual)
  // prp-domain will infer rdf:type Pizza after reasoning — must not be pre-asserted.
  'Everything so far is the schema — the TBox. I want to see a real pizza instance. In OWL, concrete instances are called Named Individuals. Switch to the individuals view and create one NamedIndividual for the pizza. Do not assert any owl:Class membership for it — only the owl:NamedIndividual type. The reasoner will determine its class. Wait for my next question.',

  // T7 — NEW ABox individuals typed as third-level varieties; pizza left untyped
  // addNode(typeIri) avoids rdfs:type vs rdf:type confusion from addTriple.
  // hasPart direction: pizza→part (pizza subject, parts objects).
  'Create two brand-new individual instances with fresh IRIs — one base part (e.g. ex:MyCrust) and one topping part (e.g. ex:MyCheese). Use addNode with typeIri set to the base variety class for MyCrust, and typeIri set to the topping variety class for MyCheese — this sets rdf:type correctly. Then add two hasPart triples where the PIZZA INDIVIDUAL is the subject: ex:MyPizza hasPart ex:MyCrust and ex:MyPizza hasPart ex:MyCheese (not the other way around). Do not assert any class type on the pizza individual. Wait for my next question.',

  // T8 — OWL-RL reasoning
  'The schema and data are in place. Now apply OWL-RL reasoning to derive everything that can be inferred. Wait for my next question.',

  // T9 — inspect pizza individual (prp-domain: hasPart domain Pizza → MyPizza rdf:type Pizza)
  'What did the reasoner infer about your pizza individual? Fetch its details from the graph. Report which types are marked as inferred versus asserted, and explain which OWL-RL rule produced each inferred type. Wait for my next question.',

  // T10 — inspect part individuals (cax-sco chain: variety → building block → Pizza)
  'Now fetch the details of each part individual — the base and the topping. Report their asserted types and their inferred types. Trace the inference chain: how did the reasoner climb the subclass hierarchy to assign additional types to each part?',
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

// Shared busy-check: content-length growth OR relay has queued work.
// isAiStreaming() is NOT used — newer OWUI keeps the send button enabled while
// generating so button-state detection gives false negatives.
// Content-length of the chat area is the reliable signal: if text is still
// appearing, the model or relay is active regardless of button state.
async function isBusy(frame: Frame, prevLen: number): Promise<{ busy: boolean; len: number }> {
  const state = await frame.evaluate(() => ({
    relayBusy: !((window as any).__vgIsRelayIdle?.() ?? true),
    len: (document.body.innerText ?? '').length,
  })).catch(() => ({ relayBusy: false, len: prevLen }));
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
  await clearCaption(page);
  await waitIdle(chatFrame, 180_000);
  await sleep(2_000); // help() manifest is large — give model time to read it

  // ── 10. Socratic turns ────────────────────────────────────────────────────
  await clearCaption(page);
  for (let i = 0; i < TURNS.length; i++) {
    // Before: brief label so viewer knows what concept is being asked about
    await caption(page, TURN_TOPICS[i]);
    await sleep(2_000);

    // Type the question visually — looks like the user is writing it live
    await typeAndSend(chatFrame, page, TURNS[i]);

    // Clear caption while model generates — the live chat + canvas are the show
    await clearCaption(page);
    await waitIdle(chatFrame, 300_000);

    // Caption goes up the moment the model first goes idle so viewers can read
    // what was built. waitQuiet holds for 10 s of continuous silence — resets
    // if the model spontaneously makes more tool calls during that window.
    await caption(page, AFTER_CAPTIONS[i]);
    await waitQuiet(chatFrame, 10_000);
    await clearCaption(page);
    await sleep(1_000);
  }

  // ── 11. End card ──────────────────────────────────────────────────────────
  await caption(page, 'Pizza ontology — TBox · ABox · OWL-RL reasoning — built through Socratic questioning alone');
  await sleep(6_000);
  await clearCaption(page);
});
