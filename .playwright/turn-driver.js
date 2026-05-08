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
    // Three subclasses of Pizza — laid out before the equivalentClass axioms are added.
    'There are many specific kinds of pizza. Add three named pizza classes: ex:SalamiPizza, ex:HawaiianPizza, and ex:MargheritaPizza. Each is a subclass of ex:Pizza — add all three nodes and all three rdfs:subClassOf ex:Pizza edges. Then arrange the hierarchy. Wait for my next question.',

    // T4 — Socratic: owl:equivalentClass + owl:Restriction + owl:someValuesFrom.
    // Characteristic toppings: Salami → SalamiTopping, Hawaiian → PineappleTopping,
    // Margherita → TomatoTopping. Must match ABox individuals added in T7/T8.
    'In OWL a class can be defined by a necessary-and-sufficient condition using owl:equivalentClass and owl:Restriction with owl:someValuesFrom. Define each named pizza class with such a condition — SalamiPizza by its characteristic SalamiTopping, HawaiianPizza by PineappleTopping, MargheritaPizza by TomatoTopping. Wait for my next question.',

    // T5 — expandNode all + runLayout
    // Reveal property cards across all TBox classes before switching to ABox.
    'Expand all class nodes on the canvas to reveal their asserted properties, then arrange. Wait for my next question.',

    // T6 — ABox: setViewMode + 3 untyped NamedIndividuals
    // No class assertion — prp-domain (hasPart domain Pizza) will infer Pizza type.
    // cls-svf1 + cax-eqc2 will later classify each into its named pizza type.
    'Everything so far is the TBox — the schema. Switch to the individuals view (ABox) and create three pizza individuals: ex:pizza1, ex:pizza2, and ex:pizza3. Give each only the owl:NamedIndividual type — do NOT assert any pizza class (not Pizza, not SalamiPizza, nothing). Only the three bare nodes. The reasoner will classify them once we add ingredients. Arrange. Wait for my next question.',

    // T7 — build pizza1 (Salami): typed parts + hasPart connections
    // SalamiTopping is the characteristic for SalamiPizza (T4 equivalentClass).
    'Build ex:pizza1 as a Salami pizza. Add three ingredient individuals to the canvas: ex:salami1 of type ex:SalamiTopping, ex:mozz1 of type ex:MozzarellaTopping, and ex:base1 of type ex:ThinCrustBase. Connect all three to ex:pizza1 using ex:hasPart. Do not assert any pizza class on ex:pizza1 — leave it untyped; the reasoner will classify it. Wait for my next question.',

    // T8 — build pizza2 (Hawaiian) + pizza3 (Margherita) + layout
    // PineappleTopping is characteristic for HawaiianPizza; TomatoTopping for MargheritaPizza.
    // Must NOT reuse TBox class IRIs as ABox individuals.
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
