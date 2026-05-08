/**
 * Pizza Tutorial — side-by-side chat + canvas demo.
 *
 * A student learns OWL from an AI tutor while the ontology builds live on the
 * right-hand canvas.  Chat messages are injected programmatically into the mock
 * chat frame; tool calls are executed directly on the app frame (no relay popup).
 *
 * Run:  npm run demo:video
 * Output: docs/demo-videos/pizza-tutorial-chat.webm / .mp4
 */

import { test } from '@playwright/test';
import { DemoRunner } from './demo-runner.js';

const BASE_URL = process.env.DEMO_BASE_URL || 'http://localhost:8080';
const P = 'http://www.pizza-ontology.com/pizza.owl#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';


// ── Shorthand helpers ──────────────────────────────────────────────────────
const cls  = (name: string) => ({ iri: P + name, typeIri: OWL + 'Class',          label: name });
const prop = (name: string) => ({ iri: P + name, typeIri: OWL + 'ObjectProperty', label: name });
const ind  = (name: string, typeIri?: string, label?: string) =>
  typeIri ? { iri: P + name, typeIri: P + typeIri, label: label ?? name }
           : { iri: P + name, label: label ?? name };
const sub   = (s: string, o: string) => ({ subjectIri: P+s, predicateIri: RDFS+'subClassOf',  objectIri: P+o });
const disj  = (s: string, o: string) => ({ subjectIri: P+s, predicateIri: OWL+'disjointWith', objectIri: P+o });
const dom   = (s: string, o: string) => ({ subjectIri: P+s, predicateIri: RDFS+'domain',      objectIri: P+o });
const ran   = (s: string, o: string) => ({ subjectIri: P+s, predicateIri: RDFS+'range',       objectIri: P+o });
const inv   = (s: string, o: string) => ({ subjectIri: P+s, predicateIri: OWL+'inverseOf',    objectIri: P+o });
const link  = (s: string, p: string, o: string) => ({ subjectIri: P+s, predicateIri: P+p, objectIri: P+o });
const layout = (alg: string, spacing = 160) => ['runLayout', { algorithm: alg, spacing }] as const;
const EXPAND = ['expandAll', {}] as const;

type ToolCall = readonly [string, Record<string, unknown>];

interface Turn {
  user: string;
  ai:   string;
  tools: ToolCall[];
  /** extra pause after canvas settles (ms) */
  viewMs?: number;
}

const TURNS: Turn[] = [
  // ── 1. Classes ────────────────────────────────────────────────────────────
  {
    user: "What's a class in OWL? Like, how do we start building a pizza ontology?",
    ai: "A class in OWL is a named category that groups things sharing common characteristics — think of it as a blueprint, not a specific pizza but the idea of 'Pizza' itself. Every individual pizza you make later will be an instance of that class. Classes form the backbone of your ontology's vocabulary. Let me add our three root classes: Pizza, PizzaBase, and PizzaTopping.",
    tools: [
      ['setViewMode', { mode: 'tbox' }],
      ['addNode', cls('Pizza')],
      ['addNode', cls('PizzaBase')],
      ['addNode', cls('PizzaTopping')],
      layout('elk-layered', 200),
    ],
    viewMs: 2500,
  },

  // ── 2. Disjointness ───────────────────────────────────────────────────────
  {
    user: "So Pizza, PizzaBase, and PizzaTopping are all separate classes — but how does OWL know they're truly different things, not overlapping?",
    ai: "Great question — by default OWL makes no assumption that different classes are separate, so a thing could technically be both a Pizza and a PizzaTopping unless you explicitly forbid it. That's what owl:disjointWith does: it tells the reasoner that no individual can belong to both classes at once. I'll now declare all three root classes pairwise disjoint so they are guaranteed to be mutually exclusive.",
    tools: [
      ['addTriple', disj('Pizza',      'PizzaBase')],
      ['addTriple', disj('Pizza',      'PizzaTopping')],
      ['addTriple', disj('PizzaBase',  'PizzaTopping')],
      layout('elk-layered', 200),
    ],
    viewMs: 2500,
  },

  // ── 3. subClassOf — base types ────────────────────────────────────────────
  {
    user: "Got it. Now, how do I say there are different kinds of pizza base — like thin crust versus deep pan?",
    ai: "You use rdfs:subClassOf to say one class is a specialisation of another — every ThinAndCrispyBase is still a PizzaBase, but it adds more specific meaning. This creates a hierarchy so the reasoner can inherit facts from parent to child classes. I'll add ThinAndCrispyBase and DeepPanBase as subclasses of PizzaBase, and also declare them disjoint from each other since no base can be both.",
    tools: [
      ['addNode', cls('ThinAndCrispyBase')],
      ['addNode', cls('DeepPanBase')],
      ['addTriple', sub('ThinAndCrispyBase', 'PizzaBase')],
      ['addTriple', sub('DeepPanBase',       'PizzaBase')],
      ['addTriple', disj('ThinAndCrispyBase', 'DeepPanBase')],
      layout('elk-layered', 170),
    ],
    viewMs: 2500,
  },

  // ── 4. NamedPizza branch ──────────────────────────────────────────────────
  {
    user: "Can you keep nesting subclasses? Like, could there be a special category of pizzas before we get to specific named ones?",
    ai: "Absolutely — OWL class hierarchies can be as deep as you need, and the reasoner will propagate subClassOf relationships all the way up the chain. It's a common pattern to introduce an intermediate class like NamedPizza to group the pizzas that have recognised recipes. I'll add NamedPizza as a subclass of Pizza, then place Margherita, AmericanHot, and FruttiDiMare beneath it.",
    tools: [
      ['addNode', cls('NamedPizza')],
      ['addNode', cls('Margherita')],
      ['addNode', cls('AmericanHot')],
      ['addNode', cls('FruttiDiMare')],
      ['addTriple', sub('NamedPizza',   'Pizza')],
      ['addTriple', sub('Margherita',   'NamedPizza')],
      ['addTriple', sub('AmericanHot',  'NamedPizza')],
      ['addTriple', sub('FruttiDiMare', 'NamedPizza')],
      layout('elk-layered', 150),
    ],
    viewMs: 2500,
  },

  // ── 5. Topping categories ─────────────────────────────────────────────────
  {
    user: "What about toppings — should I just dump everything under PizzaTopping, or organise them into groups?",
    ai: "Organising them into category classes makes the ontology far more useful: you can then say 'this pizza has a cheese topping' without naming every cheese individually. These mid-level categories also let the reasoner draw richer conclusions later. I'll add CheeseTopping, MeatTopping, VegetableTopping, and FishTopping as subclasses of PizzaTopping.",
    tools: [
      ['addNode', cls('CheeseTopping')],
      ['addNode', cls('MeatTopping')],
      ['addNode', cls('VegetableTopping')],
      ['addNode', cls('FishTopping')],
      ['addTriple', sub('CheeseTopping',    'PizzaTopping')],
      ['addTriple', sub('MeatTopping',      'PizzaTopping')],
      ['addTriple', sub('VegetableTopping', 'PizzaTopping')],
      ['addTriple', sub('FishTopping',      'PizzaTopping')],
      layout('elk-layered', 140),
    ],
    viewMs: 2500,
  },

  // ── 6. Topping category disjointness ──────────────────────────────────────
  {
    user: "Why do those topping categories also need disjointWith? Isn't it obvious that cheese isn't meat?",
    ai: "It may seem obvious to us, but OWL follows the Open World Assumption — it never assumes something is false just because it hasn't been stated. Without disjointness declarations, a reasoner is happy to conclude that mozzarella could simultaneously be a CheeseTopping and a MeatTopping. I'll now add all six pairwise disjointWith assertions between the four topping categories.",
    tools: [
      ['addTriple', disj('CheeseTopping',    'MeatTopping')],
      ['addTriple', disj('CheeseTopping',    'VegetableTopping')],
      ['addTriple', disj('CheeseTopping',    'FishTopping')],
      ['addTriple', disj('MeatTopping',      'VegetableTopping')],
      ['addTriple', disj('MeatTopping',      'FishTopping')],
      ['addTriple', disj('VegetableTopping', 'FishTopping')],
      layout('elk-layered', 140),
    ],
    viewMs: 2500,
  },

  // ── 7. Leaf toppings ──────────────────────────────────────────────────────
  {
    user: "Alright, time to add the actual specific toppings — the real ingredients. How do those fit in?",
    ai: "These are leaf classes — the most specific level of the hierarchy with no subclasses beneath them, representing concrete ingredient types like mozzarella or anchovies. They inherit all the disjointness and domain knowledge from their parent categories automatically. I'll add Mozzarella and Parmesan under Cheese, PeperoniSausage under Meat, Tomato, Olive, and Garlic under Vegetable, and Anchovies under Fish.",
    tools: [
      ['addNode', cls('MozzarellaTopping')],
      ['addNode', cls('ParmesanTopping')],
      ['addNode', cls('PeperoniSausageTopping')],
      ['addNode', cls('TomatoTopping')],
      ['addNode', cls('OliveTopping')],
      ['addNode', cls('GarlicTopping')],
      ['addNode', cls('AnchoviesTopping')],
      ['addTriple', sub('MozzarellaTopping',     'CheeseTopping')],
      ['addTriple', sub('ParmesanTopping',       'CheeseTopping')],
      ['addTriple', sub('PeperoniSausageTopping','MeatTopping')],
      ['addTriple', sub('TomatoTopping',         'VegetableTopping')],
      ['addTriple', sub('OliveTopping',          'VegetableTopping')],
      ['addTriple', sub('GarlicTopping',         'VegetableTopping')],
      ['addTriple', sub('AnchoviesTopping',      'FishTopping')],
      EXPAND,
      layout('elk-layered', 130),
    ],
    viewMs: 3000,
  },

  // ── 8. Properties — domain + range ───────────────────────────────────────
  {
    user: "How do we connect pizzas to their toppings and bases? Classes alone don't seem enough.",
    ai: "You're right — for relationships between individuals you need object properties, which are named links with a defined domain and range. The domain restricts which class the subject must belong to, and the range restricts the object. I'll add hasTopping with domain Pizza and range PizzaTopping, and hasBase with domain Pizza and range PizzaBase.",
    tools: [
      ['addNode', prop('hasTopping')],
      ['addNode', prop('hasBase')],
      ['addTriple', dom('hasTopping', 'Pizza')],
      ['addTriple', ran('hasTopping', 'PizzaTopping')],
      ['addTriple', dom('hasBase',    'Pizza')],
      ['addTriple', ran('hasBase',    'PizzaBase')],
      layout('elk-layered', 130),
    ],
    viewMs: 2500,
  },

  // ── 9. inverseOf ──────────────────────────────────────────────────────────
  {
    user: "Can we also go the other direction — from a topping back to its pizza?",
    ai: "Yes — owl:inverseOf lets you declare that isToppingOf is the mirror of hasTopping, so asserting pizza1 hasTopping mozz1 automatically gives you mozz1 isToppingOf pizza1 for free without any extra work. The reasoner fires the prp-inv rules and generates all inverse edges in one pass. I'll add isToppingOf and isBaseOf as inverses of their counterparts now.",
    tools: [
      ['addNode', prop('isToppingOf')],
      ['addNode', prop('isBaseOf')],
      ['addTriple', inv('isToppingOf', 'hasTopping')],
      ['addTriple', inv('isBaseOf',    'hasBase')],
      ['addTriple', dom('isToppingOf', 'PizzaTopping')],
      ['addTriple', ran('isToppingOf', 'Pizza')],
      ['addTriple', dom('isBaseOf',    'PizzaBase')],
      ['addTriple', ran('isBaseOf',    'Pizza')],
      EXPAND,
      layout('elk-layered', 130),
    ],
    viewMs: 3000,
  },

  // ── 10. equivalentClass restrictions ─────────────────────────────────────
  {
    user: "So the reasoner can infer pizza1 is a Pizza from the domain — but how would it ever know it's a Margherita specifically?",
    ai: "That requires owl:equivalentClass with a someValuesFrom restriction: Margherita is declared equivalent to the class of all things that have at least one TomatoTopping. When pizza1 hasTopping tom1 and tom1 is a TomatoTopping, the cls-svf1 rule fires and concludes pizza1 satisfies the restriction — so pizza1 is a Margherita. Restrictions need blank nodes so they cannot be written with addLink; we load them as inline Turtle instead.",
    tools: [
      ['loadRdf', { turtle:
        '@prefix owl: <http://www.w3.org/2002/07/owl#> .\n' +
        '@prefix pizza: <http://www.pizza-ontology.com/pizza.owl#> .\n' +
        'pizza:Margherita owl:equivalentClass [ a owl:Restriction ; owl:onProperty pizza:hasTopping ; owl:someValuesFrom pizza:TomatoTopping ] .\n' +
        'pizza:AmericanHot owl:equivalentClass [ a owl:Restriction ; owl:onProperty pizza:hasTopping ; owl:someValuesFrom pizza:PeperoniSausageTopping ] .\n' +
        'pizza:FruttiDiMare owl:equivalentClass [ a owl:Restriction ; owl:onProperty pizza:hasTopping ; owl:someValuesFrom pizza:AnchoviesTopping ] .',
      }],
      layout('elk-layered', 130),
    ],
    viewMs: 3000,
  },

  // ── 11. Switch to ABox ───────────────────────────────────────────────────
  {
    user: "We've been building the schema — the TBox, right? When do we add actual pizzas?",
    ai: "Exactly right: the TBox is the terminological box containing classes and properties — the schema. The ABox, or assertion box, is where you describe specific named individuals and their properties — the data. I'll now switch to the ABox and add three untyped pizza individuals: pizza1, pizza2, and pizza3. Their Pizza type will be inferred by the reasoner.",
    tools: [
      ['setViewMode', { mode: 'abox' }],
      ['addNode', ind('pizza1', undefined, 'pizza1')],
      ['addNode', ind('pizza2', undefined, 'pizza2')],
      ['addNode', ind('pizza3', undefined, 'pizza3')],
      layout('dagre-lr', 220),
    ],
    viewMs: 2500,
  },

  // ── 12. pizza1 — Margherita ───────────────────────────────────────────────
  {
    user: "Let's build the first one — a Margherita-style pizza. What do I need to say about pizza1?",
    ai: "For a Margherita you need mozzarella and tomato toppings connected with hasTopping, and a thin-and-crispy base connected with hasBase — just two toppings, that's the classic recipe. We leave the type of pizza1 unasserted — that's intentional, because we want the reasoner to figure it out. I'll create the topping and base individuals, then link them to pizza1.",
    tools: [
      ['addNode', ind('mozz1', 'MozzarellaTopping', 'mozz')],
      ['addNode', ind('tom1',  'TomatoTopping',      'tomato')],
      ['addNode', ind('thin1', 'ThinAndCrispyBase',  'thin & crispy')],
      ['addTriple', link('pizza1', 'hasTopping', 'mozz1')],
      ['addTriple', link('pizza1', 'hasTopping', 'tom1')],
      ['addTriple', link('pizza1', 'hasBase',    'thin1')],
      layout('dagre-lr', 190),
      ['focusNode', { iri: P + 'pizza1' }],
    ],
    viewMs: 2500,
  },

  // ── 13. pizza2 — AmericanHot ──────────────────────────────────────────────
  {
    user: "Now pizza2 — an AmericanHot. What makes it different?",
    ai: "An AmericanHot has peperoni sausage alongside mozzarella and olive, and traditionally sits on a deep pan base. Like pizza1, we assert the toppings and base but leave the pizza type for the reasoner to infer. Note that peperoni is a MeatTopping and mozzarella is a CheeseTopping — they're disjoint categories, but that's fine, each individual belongs to exactly one category. I'll add and connect them now.",
    tools: [
      ['addNode', ind('pep1',   'PeperoniSausageTopping', 'peperoni')],
      ['addNode', ind('mozz2',  'MozzarellaTopping',       'mozz')],
      ['addNode', ind('olive1', 'OliveTopping',            'olive')],
      ['addNode', ind('deep1',  'DeepPanBase',             'deep pan')],
      ['addTriple', link('pizza2', 'hasTopping', 'pep1')],
      ['addTriple', link('pizza2', 'hasTopping', 'mozz2')],
      ['addTriple', link('pizza2', 'hasTopping', 'olive1')],
      ['addTriple', link('pizza2', 'hasBase',    'deep1')],
      layout('dagre-lr', 190),
      ['focusNode', { iri: P + 'pizza2' }],
    ],
    viewMs: 2500,
  },

  // ── 14. pizza3 — FruttiDiMare ─────────────────────────────────────────────
  {
    user: "And pizza3 — the FruttiDiMare?",
    ai: "FruttiDiMare is seafood-based, so it gets anchovies and garlic as its toppings on a thin-and-crispy base — garlic is the classic accompaniment to seafood in Italian cooking. Again we intentionally leave pizza3's type unstated — the whole point is to let the reasoner derive it. I'll add the individuals and connect them to pizza3.",
    tools: [
      ['addNode', ind('anch1',   'AnchoviesTopping', 'anchovies')],
      ['addNode', ind('garlic1', 'GarlicTopping',    'garlic')],
      ['addNode', ind('thin2',   'ThinAndCrispyBase', 'thin & crispy')],
      ['addTriple', link('pizza3', 'hasTopping', 'anch1')],
      ['addTriple', link('pizza3', 'hasTopping', 'garlic1')],
      ['addTriple', link('pizza3', 'hasBase',    'thin2')],
      EXPAND,
      layout('dagre-lr', 190),
      ['focusNode', { iri: P + 'pizza3' }],
    ],
    viewMs: 3000,
  },

  // ── 15. Run reasoning ─────────────────────────────────────────────────────
  {
    user: "So what exactly does OWL-RL reasoning actually do with all of this?",
    ai: "OWL-RL applies a fixed set of forward-chaining rules to derive new facts that are logically entailed by your TBox and ABox together. It propagates subClassOf chains, uses domain and range constraints to infer types, fires inverse property rules, and uses disjointness axioms to detect contradictions. I'll now run the reasoner over our ontology to materialise all inferred triples.",
    tools: [
      ['runReasoning', {}],
      EXPAND,
      layout('dagre-lr', 190),
    ],
    viewMs: 4000,
  },

  // ── 16. Inspect pizza1 ────────────────────────────────────────────────────
  {
    user: "What did the reasoner figure out about pizza1?",
    ai: "Three things happened: the domain axiom fired and inferred pizza1 is a Pizza; cls-svf1 fired because pizza1 hasTopping tom1 and tom1 is a TomatoTopping, satisfying the Margherita restriction — so pizza1 is inferred as a Margherita; and prp-inv generated the inverse isToppingOf back-links from each topping. Let me focus on pizza1 so you can see those inferred types.",
    tools: [
      ['focusNode',  { iri: P + 'pizza1' }],
      ['expandNode', { iri: P + 'pizza1', expand: true }],
    ],
    viewMs: 4000,
  },

  // ── 17. Inspect mozz1 ─────────────────────────────────────────────────────
  {
    user: "What about mozz1 — what did the reasoner work out about that individual?",
    ai: "The reasoner sees mozz1 was linked via hasTopping, so the range constraint fires and infers mozz1 is a PizzaTopping. Then it walks the subClassOf chain upward: MozzarellaTopping is a CheeseTopping which is a PizzaTopping, giving mozz1 all three types at once from a single asserted type. I'll focus the view on mozz1 so you can see that full inherited type chain laid out explicitly.",
    tools: [
      ['focusNode',  { iri: P + 'mozz1' }],
      ['expandNode', { iri: P + 'mozz1', expand: true }],
    ],
    viewMs: 4000,
  },
];

// ── Test ───────────────────────────────────────────────────────────────────
test('pizza-tutorial-chat: OWL pizza tutorial as AI tutor lesson, side-by-side', async ({ page }) => {
  const runner = new DemoRunner(page, BASE_URL);

  await runner.openStage();
  // Slow streaming so AI text is readable on screen (~35 ms per word)
  await runner.setStreamSpeed(35);

  for (const turn of TURNS) {
    // Student question
    await runner.addChatMessage('user', turn.user);
    await runner.pauseMs(1_800);

    // AI explanation streams in
    await runner.addChatMessage('ai', turn.ai);
    await runner.waitForChatStream();
    await runner.pauseMs(1_200);

    // Canvas builds
    for (const [name, args] of turn.tools) {
      await runner.callToolOnStage(name, args as Record<string, unknown>);
      await runner.pauseMs(350);
    }

    // Viewer reads and watches
    await runner.pauseMs(turn.viewMs ?? 2_000);
  }

  // End card
  await runner.captionPause(
    'Manchester Pizza Tutorial — built step by step with OWL-RL-like reasoning',
    4_000,
  );
});
