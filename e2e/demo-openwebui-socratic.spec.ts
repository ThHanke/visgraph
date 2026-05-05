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

// Bare help() call — relay executes it and injects the full manifest + format
// instructions as a user message. No inline tool list needed.
const INSTR = '`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"help","arguments":{}}}`';

// Caption shown briefly before injection — tells viewer what's being asked
const TURN_TOPICS = [
  'Asking: what is the most fundamental OWL building block for a concept?',
  'Guide: model the two building blocks of a pizza as sub-categories.',
  'Guide: can the two building blocks ever belong to the same individual?',
  'Guide: add two concrete varieties under each building block.',
  'Guide: how does OWL express that a Pizza is composed of its parts?',
  'Guide: reveal all asserted properties on the Pizza class node.',
  'Guide: switch to individuals — create a real pizza instance.',
  'Guide: give the pizza individual its parts and connect them.',
  'Guide: apply OWL-RL reasoning to derive everything implicit.',
  'Guide: what did the reasoner infer about the pizza individual?',
];

// Caption shown after idle — describes what was just built
const AFTER_CAPTIONS = [
  'Pizza class on canvas — owl:Class, the atomic unit of OWL.',
  'rdfs:subClassOf hierarchy — two building blocks visible beneath Pizza.',
  'owl:disjointWith asserted — the two blocks can never overlap.',
  'Third level of hierarchy — concrete varieties under each building block.',
  'owl:ObjectProperty with domain + range — named composition link in the ontology.',
  'expandNode reveals all asserted properties on the Pizza class.',
  'owl:NamedIndividual in ABox view — TBox/ABox separation demonstrated.',
  'Individual linked to its parts via the object property.',
  'OWL-RL reasoning complete — inferred triples materialised.',
  'Pizza ontology complete — built through Socratic questioning alone.',
];

// T0–T9: validated Socratic arc — purely conceptual, no tool-name references.
// Model maps OWL concept → tool from the manifest returned by help().
// Source of truth: .playwright/pizza-demo-setup.js (T0) + .playwright/turn-driver.js (T1–T9).
const TURNS = [
  // T0 — root class
  'I want to learn OWL ontology concepts through a hands-on example. I will guide you through the pizza domain step by step — one concept at a time. Rule: for each question I ask, model exactly the concept I ask about on the canvas, then stop and wait. Do not add anything beyond what I asked. Do not arrange nodes automatically. Use the ex: prefix for all IRIs (ex: maps to http://example.org/). First question: in OWL, what is the most fundamental building block for representing a concept? Create a single Pizza class — just this one node, nothing more. Wait for my next question.',

  // T1 — rdfs:subClassOf hierarchy + runLayout
  'A pizza is made from two distinct building blocks. What are they in OWL terms? Model them as sub-categories of Pizza using the correct OWL relationship, then arrange the hierarchy so it is visible. Wait for my next question.',

  // T2 — owl:disjointWith
  'In OWL, classes can be declared mutually exclusive — no individual can belong to both at the same time. Should the two building blocks of a pizza be disjoint from each other? If so, express that relationship on the canvas. Wait for my next question.',

  // T3 — deepen hierarchy + runLayout
  'Good. Each building block has concrete varieties — for example a dough might be thin-crust or thick-crust. Add two specific sub-types under each building block, then arrange the hierarchy. Wait for my next question.',

  // T4 — owl:ObjectProperty with domain + range
  'The hierarchy shows how classes relate by type. But OWL has a formal construct for expressing that a Pizza is composed of its parts — a named relationship that is itself an entity in the ontology, with a defined source class and target class. How would you model that composition? Wait for my next question.',

  // T5 — expandNode
  'Expand the Pizza class node on the canvas so I can see all its asserted properties. Wait for my next question.',

  // T6 — ABox individual
  'Everything so far is the schema — the TBox. I want to see a real pizza instance. In OWL, concrete instances are called Named Individuals. Switch to the individuals view and add one. Wait for my next question.',

  // T7 — connect individual to parts
  'Give your pizza individual some parts — one individual topping and one individual dough. Connect them to the pizza using the object property you defined earlier. Wait for my next question.',

  // T8 — OWL-RL reasoning
  'The schema and data are in place. Now apply OWL-RL reasoning to derive everything that can be inferred. Wait for my next question.',

  // T9 — getNodeDetails (returns asserted + inferred)
  'What did the reasoner infer about your pizza individual? Fetch its details from the graph and report which types are now attached to it.',
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
  // SEED: canonical text — must match README.md "Starter prompt" section exactly.
  // No backticks — plain text so OWUI routes to /c/ not /notes/.
  await caption(page, 'Seeding the relay session…');
  const SEED = 'You are connected to Ontosphere via a relay. A script in this tab intercepts your tool calls, runs them in Ontosphere, and injects results back as a user message. Ask the user what they would like to build.';
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

  // ── 11. Socratic turns ────────────────────────────────────────────────────
  await clearCaption(page);
  for (let i = 0; i < TURNS.length; i++) {
    // Brief topic label — what's being asked right now
    await caption(page, TURN_TOPICS[i]);
    await sleep(2_000);

    await inject(chatFrame, TURNS[i]);
    await sleep(800);
    await clickSend(chatFrame);

    // Clear during model generation — live OWUI chat + canvas are the show
    await clearCaption(page);
    await waitIdle(chatFrame, 300_000);
    await sleep(800);

    // After idle — describe what was just built
    await caption(page, AFTER_CAPTIONS[i]);
    await sleep(4_000);
    await clearCaption(page);
    await sleep(400);
  }

  // ── 12. End card ──────────────────────────────────────────────────────────
  await caption(page, 'Pizza ontology — TBox · ABox · OWL-RL reasoning — built through Socratic questioning alone');
  await sleep(6_000);
  await clearCaption(page);
});
