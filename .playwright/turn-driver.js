/**
 * turn-driver.js — Drive Socratic pizza ontology session via OWUI relay.
 *
 * Usage: mcp__playwright__browser_run_code_unsafe filename=.playwright/turn-driver.js
 *
 * Prerequisites:
 *   - pizza-demo-setup.js ran: relay injected, help() call sent, Turn 0 in flight or idle
 *   - window.__vgIsStreaming and window.__vgInjectResult exposed on OWUI tab
 *
 * Arc: T1–T9 demonstrating OWL concepts through Socratic questions.
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
    'A pizza is made from two distinct building blocks. What are they in OWL terms? Model them as sub-categories of Pizza using the correct OWL relationship, then arrange the hierarchy so it is visible. Wait for my next question.',

    // T2 — owl:disjointWith
    // Goal: disjointWith between the two sibling classes.
    'In OWL, classes can be declared mutually exclusive — no individual can belong to both at the same time. Should the two building blocks of a pizza be disjoint from each other? If so, express that relationship on the canvas. Wait for my next question.',

    // T3 — deepen the hierarchy + runLayout
    // Goal: third level of rdfs:subClassOf.
    'Good. Each building block has concrete varieties — for example a dough might be thin-crust or thick-crust. Add two specific sub-types under each building block, then arrange the hierarchy. Wait for my next question.',

    // T4 — owl:ObjectProperty with domain and range
    // Goal: ObjectProperty as a named entity. addNode description now spells this out explicitly.
    'The hierarchy shows how classes relate by type. But OWL has a formal construct for expressing that a Pizza is composed of its parts — a named relationship that is itself an entity in the ontology, with a defined source class and target class. How would you model that composition? Wait for my next question.',

    // T5 — expandNode
    // Goal: reveal annotation property cards on the Pizza node.
    'Expand the Pizza class node on the canvas so I can see all its asserted properties. Wait for my next question.',

    // T6 — ABox: setViewMode + addNode(NamedIndividual)
    // Goal: TBox/ABox separation.
    'Everything so far is the schema — the TBox. I want to see a real pizza instance. Switch to the individuals view and add one concrete pizza individual. Wait for my next question.',

    // T7 — connect individual to part individuals via the object property
    // Goal: addNode for parts + addTriple with the object property.
    'Give your pizza individual some parts — one individual topping and one individual dough. Connect them to the pizza using the object property you defined earlier. Wait for my next question.',

    // T8 — runReasoning
    // Goal: OWL-RL forward-chaining.
    'The schema and data are in place. Now apply OWL-RL reasoning to derive everything that can be inferred. Wait for my next question.',

    // T9 — getNodeDetails (now returns both asserted + inferred)
    // Goal: inspect what the reasoner derived about the individual.
    'What did the reasoner infer about your pizza individual? Fetch its details from the graph and report which types are now attached to it.',
  ];

  async function waitIdle() {
    const deadline = Date.now() + IDLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const streaming = await owuiPage.evaluate(() => window.__vgIsStreaming?.() ?? false);
      if (!streaming) return true;
      await owuiPage.waitForTimeout(1000);
    }
    return false;
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

    const idleReached = await waitIdle();
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
