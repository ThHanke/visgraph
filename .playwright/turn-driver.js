/**
 * turn-driver.js — Drive Socratic pizza ontology demo turns via OWUI relay
 *
 * Usage: mcp__playwright__browser_run_code_unsafe filename=.playwright/turn-driver.js
 *
 * Prerequisites:
 *   - pizza-demo-setup.js already ran (relay injected, Turn 0 in flight or idle)
 *   - window.__vgIsStreaming and window.__vgInjectResult exposed on OWUI tab
 *
 * Turn arc (Socratic questions — never direct commands):
 *   T1: Add PizzaBase and PizzaTopping as sub-concepts of Pizza
 *   T2: Add DeepPan and ThinAndCrispy as types of PizzaBase
 *   T3: Add Mozzarella, TomatoSauce, Pepperoni as types of PizzaTopping
 *   T4: Connect Pizza to its parts with a hasPart object property
 *   T5: Organize the graph visually with a layout
 *   T6: Inspect the Pizza concept to verify what was built
 */

async (page) => {
  const IDLE_TIMEOUT_MS = 180_000;
  const INJECT_RETRIES  = 8;
  const INJECT_RETRY_DELAY_MS = 500;

  const pages = page.context().pages();
  const owuiPage = pages.find(p => p.url().includes('gpuserver1-sit'));
  if (!owuiPage) return { ok: false, error: 'no OWUI tab' };

  const TURNS = [
    // T1 — hierarchy: PizzaBase + PizzaTopping as OWL sub-concepts of Pizza
    'Great start! A pizza is made of two main building blocks — its base and its toppings. ' +
    'Could you model those as more specific types of Pizza in the ontology?',

    // T2 — deeper hierarchy: PizzaBase variants
    'Nice! PizzaBase can be either deep pan or thin and crispy. ' +
    'Can you add those two variants as more specific types of PizzaBase?',

    // T3 — breadth: concrete toppings
    "Now let's add some real toppings. " +
    'Can you add Mozzarella, TomatoSauce, and Pepperoni as specific types of PizzaTopping?',

    // T4 — object property: hasPart
    "The graph has the building blocks, but a Pizza isn't linked to its parts yet. " +
    'Can you express that a Pizza has both a PizzaBase and a PizzaTopping using an addLink call?',

    // T5 — layout
    'The graph is getting complex. ' +
    'Can you arrange the nodes so the hierarchy is easy to read?',

    // T6 — introspection
    "Let's verify what we've built. " +
    'Can you look up the details of the Pizza concept and tell me what you see?',
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
      await owuiPage.waitForTimeout(INJECT_RETRY_DELAY_MS);
    }
    return false;
  }

  const results = [];

  for (let i = 0; i < TURNS.length; i++) {
    const turnNum = i + 1;

    // Wait for model to finish previous response
    const idleReached = await waitIdle();
    await owuiPage.waitForTimeout(600);

    const injected = await injectTurn(TURNS[i]);
    await owuiPage.waitForTimeout(800);

    // Click send if trySubmit hasn't already submitted
    const btn = await owuiPage.$('#send-message-button:not([disabled])');
    if (btn) await btn.click();

    results.push({ turn: turnNum, injected, idleReached });
    console.log(`[TURN-DRIVER] T${turnNum} sent — idle=${idleReached} injected=${injected}`);

    // Brief gap before checking idle for next turn
    await owuiPage.waitForTimeout(1000);
  }

  return { ok: true, turns: results };
}
