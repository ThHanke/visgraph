/**
 * turn-driver.js — Drive Socratic pizza ontology session via OWUI relay.
 *
 * Usage: mcp__playwright__browser_run_code_unsafe filename=.playwright/turn-driver.js
 *
 * Prerequisites:
 *   - pizza-demo-setup.js ran: relay injected, help() call sent, Turn 0 in flight or idle
 *   - window.__vgIsStreaming and window.__vgInjectResult exposed on OWUI tab
 *
 * Arc: T1–T10 demonstrating OWL concepts through Socratic questions.
 * Questions guide toward OWL features without prescribing class names —
 * qwen3 decides structure, we steer toward the concept to showcase.
 *
 * Logs full model response text after each turn for analysis.
 */

async (page) => {
  const IDLE_TIMEOUT_MS    = 300_000; // 5 min per turn (reasoning can be slow)
  const INJECT_RETRIES     = 8;
  const INJECT_RETRY_DELAY = 500;

  const pages = page.context().pages();
  const owuiPage = pages.find(p => p.url().includes('gpuserver1-sit'));
  if (!owuiPage) return { ok: false, error: 'no OWUI tab' };

  const TURNS = [
    // T1 — rdfs:subClassOf hierarchy + runLayout
    // Goal: subClassOf edges visible on canvas, then runLayout.
    // Both edges are mandatory — qwen3 reliably adds only one without explicit AND.
    // The full base→Pizza and topping→Pizza chain is required for T10 subClass inference.
    'A pizza is made from two distinct building blocks — a base and a topping. In OWL, rdfs:subClassOf places a class beneath its parent. Create a class for the base and a class for the topping, then add both subClassOf edges: base subClassOf Pizza AND topping subClassOf Pizza. Both edges are required — do not stop after just one. Keep using the ex: prefix. Then arrange the hierarchy. Wait for my next question.',

    // T2 — owl:disjointWith
    // Goal: disjointWith between the two sibling classes.
    'In OWL, classes can be declared mutually exclusive — no individual can belong to both at the same time. Should the two building blocks of a pizza be disjoint from each other? If so, express that relationship on the canvas. Wait for my next question.',

    // T3 — deepen the hierarchy + runLayout
    // Goal: third level of rdfs:subClassOf.
    'Good. Each building block has concrete varieties — for example a dough might be thin-crust or thick-crust. Add two specific sub-types under each building block, then arrange the hierarchy. Wait for my next question.',

    // T4 — owl:ObjectProperty with domain and range
    // Goal: ObjectProperty as a named entity on canvas with domain + range.
    // Range = Pizza (superclass of both building blocks) — avoids prp-range firing
    // on both sibling classes simultaneously, which would trigger cax-dw (disjointWith
    // inconsistency) because every part would be inferred as BOTH PizzaBase and PizzaTopping.
    // CRITICAL: must use rdfs:domain / rdfs:range — the OWL-RL reasoner does NOT read
    // owl:domain / owl:range. Using the wrong prefix breaks all domain/range inference.
    'In OWL, composition is modelled with an owl:ObjectProperty — a named relationship that is itself a first-class node in the ontology, not just an edge. Create an object property called hasPart. Then declare its domain and range using exactly these predicates: rdfs:domain pointing to Pizza, and rdfs:range pointing to Pizza. Important: use rdfs:domain and rdfs:range — not owl:domain or owl:range. Add it to the canvas now. Wait for my next question.',

    // T5 — expandNode
    // Goal: reveal annotation property cards on the Pizza node.
    'Expand the Pizza class node on the canvas so I can see all its asserted properties. Wait for my next question.',

    // T6 — ABox: setViewMode + addNode(NamedIndividual)
    // Goal: individual with NO class assertion — just owl:NamedIndividual.
    // The reasoner must infer rdf:type Pizza via prp-domain (hasPart domain Pizza).
    // Explicitly forbid class assertion so the inference is visible and impressive.
    'Everything so far is the schema — the TBox. I want to see a real pizza instance. In OWL, concrete instances are called Named Individuals. Switch to the individuals view and create one NamedIndividual for the pizza. Do not assert any owl:Class membership for it — only the owl:NamedIndividual type. The reasoner will determine its class. Wait for my next question.',

    // T7 — connect individual to part individuals via the object property
    // Goal: NEW ABox individuals typed as third-level varieties (not the class nodes).
    // The model must NOT reuse TBox class nodes as ABox individuals — fresh IRIs only.
    // Typing parts as third-level varieties lets cax-sco chain inference run:
    //   ex:MyCrust rdf:type ThinCrust → inferred Base → inferred Pizza (T10 showcase).
    // Use addNode(typeIri=varietyClass) for type — avoids rdfs:type vs rdf:type confusion.
    // hasPart direction: pizza→part (pizza is the subject, the part is the object).
    'Create two brand-new individual instances with fresh IRIs — one base part (e.g. ex:MyCrust) and one topping part (e.g. ex:MyCheese). Use addNode with typeIri set to the base variety class for MyCrust, and typeIri set to the topping variety class for MyCheese — this sets rdf:type correctly. Then add two hasPart triples where the PIZZA INDIVIDUAL is the subject: ex:MyPizza hasPart ex:MyCrust and ex:MyPizza hasPart ex:MyCheese (not the other way around). Do not assert any class type on the pizza individual. Wait for my next question.',

    // T8 — runReasoning
    // Goal: OWL-RL forward-chaining materialises inferred triples.
    'The schema and data are in place. Now apply OWL-RL reasoning to derive everything that can be inferred. Wait for my next question.',

    // T9 — inspect pizza individual (prp-domain inference)
    // Goal: show inferred rdf:type Pizza on the pizza individual via domain rule.
    'What did the reasoner infer about your pizza individual? Fetch its details from the graph. Report which types are marked as inferred versus asserted, and explain which OWL-RL rule produced each inferred type. Wait for my next question.',

    // T10 — inspect part individuals (subClass chain inference)
    // Goal: show inferred types on base and topping individuals via cax-sco chain.
    'Now fetch the details of each part individual — the base and the topping. Report their asserted types and their inferred types. Trace the inference chain: how did the reasoner climb the subclass hierarchy to assign additional types to each part?',
  ];

  // Reliable idle: content-length stability + relay queue drained.
  // isAiStreaming() is NOT used — newer OWUI keeps send-button enabled while
  // generating, causing false-idle readings. Content growth is the true signal.
  let _lastLen = -1;
  async function isBusy() {
    const state = await owuiPage.evaluate(() => ({
      relayBusy: !(window.__vgIsRelayIdle?.() ?? true),
      len: document.body.innerText?.length ?? 0,
    })).catch(() => ({ relayBusy: false, len: _lastLen }));
    const growing = _lastLen >= 0 && state.len !== _lastLen;
    _lastLen = state.len;
    return state.relayBusy || growing;
  }

  async function waitIdle(stableMs = 3_000) {
    const deadline = Date.now() + IDLE_TIMEOUT_MS;
    const pollMs = 500;
    let silentMs = 0;
    while (Date.now() < deadline) {
      const busy = await isBusy();
      if (busy) silentMs = 0; else silentMs += pollMs;
      if (silentMs >= stableMs) return true;
      await owuiPage.waitForTimeout(pollMs);
    }
    return false;
  }

  // 10-second continuous silence before typing — resets on any activity.
  async function waitQuiet(quietMs = 10_000, maxMs = 45_000) {
    const pollMs = 500;
    let silentMs = 0;
    const deadline = Date.now() + maxMs;
    while (silentMs < quietMs && Date.now() < deadline) {
      const busy = await isBusy();
      if (busy) silentMs = 0; else silentMs += pollMs;
      await owuiPage.waitForTimeout(pollMs);
    }
  }

  async function injectTurn(text) {
    for (let i = 0; i < INJECT_RETRIES; i++) {
      const ok = await owuiPage.evaluate(
        (t) => typeof window.__vgInjectResult === 'function' ? window.__vgInjectResult(t) : false,
        text,
      );
      if (ok !== false) return true;
      await owuiPage.waitForTimeout(INJECT_RETRY_DELAY);
    }
    return false;
  }

  // Read the last assistant message text from the OWUI DOM for response analysis.
  async function captureLastResponse() {
    return owuiPage.evaluate(() => {
      // OWUI marks assistant messages with data-message-role or a class like 'assistant'
      const byRole = document.querySelectorAll('[data-message-role="assistant"]');
      if (byRole.length) return byRole[byRole.length - 1].innerText || '';
      // Fallback: last .message.assistant or similar
      const byClass = document.querySelectorAll('.message.assistant, [class*="assistant"]');
      if (byClass.length) return byClass[byClass.length - 1].innerText || '';
      return '';
    });
  }

  const results = [];

  for (let i = 0; i < TURNS.length; i++) {
    const turnNum = i + 1;

    // Wait until truly idle (3s stability), then 10s of continuous silence
    // before typing to ensure relay queue is drained and model isn't mid-think.
    const idleReached = await waitIdle();
    await waitQuiet();
    await owuiPage.waitForTimeout(600);

    // Capture previous response before injecting next turn
    const prevResponse = await captureLastResponse();
    if (prevResponse) {
      console.log(`[TURN-DRIVER] T${turnNum - 1} model response:\n---\n${prevResponse.slice(0, 2000)}\n---`);
    }

    const injected = await injectTurn(TURNS[i]);
    await owuiPage.waitForTimeout(800);

    const btn = await owuiPage.$('#send-message-button:not([disabled])');
    if (btn) await btn.click();

    results.push({ turn: turnNum, injected, idleReached });
    console.log(`[TURN-DRIVER] T${turnNum} sent — idle=${idleReached} injected=${injected}`);

    await owuiPage.waitForTimeout(1000);
  }

  // Capture final response after last turn finishes
  await waitIdle();
  await owuiPage.waitForTimeout(600);
  const finalResponse = await captureLastResponse();
  if (finalResponse) {
    console.log(`[TURN-DRIVER] T${TURNS.length} model response:\n---\n${finalResponse.slice(0, 2000)}\n---`);
  }

  return { ok: true, turns: results };
}
