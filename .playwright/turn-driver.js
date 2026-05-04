/**
 * turn-driver.js — Drive full Socratic pizza ontology session via OWUI relay.
 *
 * Usage: mcp__playwright__browser_run_code_unsafe filename=.playwright/turn-driver.js
 *
 * Prerequisites:
 *   - pizza-demo-setup.js ran: relay injected, INSTR sent, Turn 0 in flight or idle
 *   - window.__vgIsStreaming and window.__vgInjectResult exposed on OWUI tab
 *
 * Arc: T1–T16 covering the full Manchester Pizza Ontology —
 *   root classes → disjointness → subClassOf → named pizzas → topping hierarchy
 *   → object properties → inverse properties → OWL restrictions → ABox individuals
 *   → OWL-RL reasoning → type adoption inspection
 */

async (page) => {
  const IDLE_TIMEOUT_MS     = 300_000; // 5 min per turn (reasoning can be slow)
  const INJECT_RETRIES      = 8;
  const INJECT_RETRY_DELAY  = 500;

  const pages = page.context().pages();
  const owuiPage = pages.find(p => p.url().includes('gpuserver1-sit'));
  if (!owuiPage) return { ok: false, error: 'no OWUI tab' };

  const TURNS = [
    // T1 — disjointness
    'Those three classes look separate, but how does OWL know they truly cannot overlap? Can you add the disjointWith declarations between them?',

    // T2 — base subclasses
    'How do I model different kinds of pizza base — thin crust versus deep pan? Add them as subclasses of PizzaBase and declare them disjoint from each other.',

    // T3 — named pizzas
    'Can hierarchies go deeper? Add a NamedPizza intermediate class, then place Margherita, AmericanHot, and FruttiDiMare beneath it as subclasses.',

    // T4 — topping categories
    'What about toppings — should they all sit directly under PizzaTopping, or is a category structure better? Add CheeseTopping, MeatTopping, VegetableTopping, and FishTopping as topping sub-categories.',

    // T5 — topping disjointness
    "Why do the topping categories also need owl:disjointWith? Add those disjointness assertions between all four categories.",

    // T6 — leaf toppings
    'Now add the real ingredients: Mozzarella and Parmesan under CheeseTopping, PeperoniSausage under MeatTopping, Tomato + Olive + Garlic under VegetableTopping, Anchovies under FishTopping.',

    // T7 — object properties
    'The classes are ready but how do we link pizzas to their toppings and bases? Add object properties hasTopping and hasBase with domain and range constraints.',

    // T8 — inverse properties
    'Can we navigate in the opposite direction — from a topping back to its pizza? Add isToppingOf and isBaseOf as inverse properties with their own domain and range.',

    // T9 — OWL restrictions (use loadRdf)
    'The reasoner can infer pizza1 is a Pizza from the domain constraint — but how would it know it\'s a Margherita specifically? Use loadRdf to add the owl:equivalentClass someValuesFrom restriction for Margherita (TomatoTopping), AmericanHot (PeperoniSausageTopping), and FruttiDiMare (AnchoviesTopping). Use ex: prefix = http://www.pizza-ontology.com/pizza.owl#',

    // T10 — ABox
    "Those were the class definitions — the TBox. Now add actual pizza individuals. Use setViewMode with mode 'abox', then add pizza1, pizza2, pizza3 as individuals WITHOUT asserting their types.",

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

  const results = [];

  for (let i = 0; i < TURNS.length; i++) {
    const turnNum = i + 1;

    const idleReached = await waitIdle();
    await owuiPage.waitForTimeout(600);

    const injected = await injectTurn(TURNS[i]);
    await owuiPage.waitForTimeout(800);

    const btn = await owuiPage.$('#send-message-button:not([disabled])');
    if (btn) await btn.click();

    results.push({ turn: turnNum, injected, idleReached });
    console.log(`[TURN-DRIVER] T${turnNum} sent — idle=${idleReached} injected=${injected}`);

    await owuiPage.waitForTimeout(1000);
  }

  return { ok: true, turns: results };
}
