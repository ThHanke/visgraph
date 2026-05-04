/**
 * Pizza Socratic demo — a small AI model is guided to build the full
 * Manchester Pizza Ontology through Socratic questions.
 *
 * Covers the complete arc: OWL classes → disjointness → subClassOf hierarchy
 * → named pizzas → topping categories → object properties → inverse properties
 * → OWL-RL restrictions → ABox individuals → reasoning → type adoption.
 *
 * Run:  npm run demo:video
 * Output: docs/demo-videos/pizza-socratic.webm / .mp4
 */

import { test } from '@playwright/test';
import { DemoRunner } from './demo-runner.js';

const BASE_URL = process.env.DEMO_BASE_URL || 'http://localhost:8080';
const P    = 'http://www.pizza-ontology.com/pizza.owl#';
const OWL  = 'http://www.w3.org/2002/07/owl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';

const cls  = (n: string, l?: string) => ({ iri: P+n, typeIri: OWL+'Class',          label: l ?? n });
const prop = (n: string)             => ({ iri: P+n, typeIri: OWL+'ObjectProperty', label: n });
const ind  = (n: string, t?: string, l?: string) =>
  t ? { iri: P+n, typeIri: P+t, label: l ?? n } : { iri: P+n, label: l ?? n };
const sub  = (s: string, o: string) => ({ subjectIri: P+s, predicateIri: RDFS+'subClassOf',  objectIri: P+o });
const disj = (s: string, o: string) => ({ subjectIri: P+s, predicateIri: OWL+'disjointWith', objectIri: P+o });
const dom  = (s: string, o: string) => ({ subjectIri: P+s, predicateIri: RDFS+'domain',      objectIri: P+o });
const ran  = (s: string, o: string) => ({ subjectIri: P+s, predicateIri: RDFS+'range',       objectIri: P+o });
const inv  = (s: string, o: string) => ({ subjectIri: P+s, predicateIri: OWL+'inverseOf',    objectIri: P+o });
const link = (s: string, p: string, o: string) => ({ subjectIri: P+s, predicateIri: P+p, objectIri: P+o });
const layout = (alg: string, sp = 160) => ['runLayout', { algorithm: alg, spacing: sp }] as const;
const EXPAND  = ['expandAll', {}] as const;

type ToolCall = readonly [string, Record<string, unknown>];
interface Turn { user: string; ai: string; tools: ToolCall[]; viewMs?: number; }

const TURNS: Turn[] = [
  // ── 1. Root classes ──────────────────────────────────────────────────────
  {
    user: "Can you teach me how ontologies work using pizzas as an example? Start by adding the three most fundamental categories to the graph.",
    ai: "In OWL an ontology starts with classes — named categories for groups of things. For pizzas the three root categories are Pizza itself, PizzaBase (the crust), and PizzaTopping (the ingredients). These three classes will be the foundation everything else builds on. I'll switch to TBox view — the schema level — and add all three.",
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
    user: "Pizza, PizzaBase, and PizzaTopping look separate — but how does OWL know they can't overlap?",
    ai: "By default OWL makes no assumption that different classes are separate: a thing could technically be both a Pizza and a PizzaTopping. owl:disjointWith tells the reasoner that's impossible — if two classes are disjoint, no individual can belong to both. I'll declare all three root classes pairwise disjoint now.",
    tools: [
      ['addLink', disj('Pizza',     'PizzaBase')],
      ['addLink', disj('Pizza',     'PizzaTopping')],
      ['addLink', disj('PizzaBase', 'PizzaTopping')],
      layout('elk-layered', 200),
    ],
    viewMs: 2500,
  },

  // ── 3. Base subclasses ────────────────────────────────────────────────────
  {
    user: "How do I say there are different kinds of pizza base — like thin crust or deep pan?",
    ai: "You use rdfs:subClassOf: every ThinAndCrispyBase is still a PizzaBase but adds more specific meaning. This creates a hierarchy — the reasoner inherits facts from parent to child. I'll add both base types as subclasses and declare them disjoint from each other, since no base can be both.",
    tools: [
      ['addNode', cls('ThinAndCrispyBase')],
      ['addNode', cls('DeepPanBase')],
      ['addLink', sub('ThinAndCrispyBase', 'PizzaBase')],
      ['addLink', sub('DeepPanBase',       'PizzaBase')],
      ['addLink', disj('ThinAndCrispyBase', 'DeepPanBase')],
      layout('elk-layered', 180),
    ],
    viewMs: 2500,
  },

  // ── 4. Named pizza subclass ───────────────────────────────────────────────
  {
    user: "Can hierarchies go deeper? Like, could there be a group for pizzas that have recognised names — Margherita, AmericanHot, FruttiDiMare?",
    ai: "Absolutely — hierarchies can be as deep as needed, and the reasoner propagates subClassOf all the way up. A NamedPizza intermediate class groups all pizzas with official recipes. Margherita, AmericanHot, and FruttiDiMare sit beneath it.",
    tools: [
      ['addNode', cls('NamedPizza')],
      ['addNode', cls('Margherita')],
      ['addNode', cls('AmericanHot')],
      ['addNode', cls('FruttiDiMare')],
      ['addLink', sub('NamedPizza',   'Pizza')],
      ['addLink', sub('Margherita',   'NamedPizza')],
      ['addLink', sub('AmericanHot',  'NamedPizza')],
      ['addLink', sub('FruttiDiMare', 'NamedPizza')],
      layout('elk-layered', 180),
    ],
    viewMs: 2800,
  },

  // ── 5. Topping categories ─────────────────────────────────────────────────
  {
    user: "What about toppings — should they all sit directly under PizzaTopping, or is there a better structure?",
    ai: "Category classes make the ontology much more useful — you can say 'this pizza has a cheese topping' without listing every cheese. They also let the reasoner draw richer conclusions. I'll add CheeseTopping, MeatTopping, VegetableTopping, and FishTopping as subclasses of PizzaTopping.",
    tools: [
      ['addNode', cls('CheeseTopping')],
      ['addNode', cls('MeatTopping')],
      ['addNode', cls('VegetableTopping')],
      ['addNode', cls('FishTopping')],
      ['addLink', sub('CheeseTopping',    'PizzaTopping')],
      ['addLink', sub('MeatTopping',      'PizzaTopping')],
      ['addLink', sub('VegetableTopping', 'PizzaTopping')],
      ['addLink', sub('FishTopping',      'PizzaTopping')],
      layout('elk-layered', 160),
    ],
    viewMs: 2800,
  },

  // ── 6. Topping disjointness ───────────────────────────────────────────────
  {
    user: "Why do those topping categories also need owl:disjointWith? Isn't it obvious that cheese isn't meat?",
    ai: "OWL follows the Open World Assumption — it never assumes something is false just because it hasn't been stated. Without disjointness declarations a reasoner could conclude mozzarella is simultaneously a CheeseTopping and a MeatTopping. I'll add all six pairwise disjointWith assertions between the four categories.",
    tools: [
      ['addLink', disj('CheeseTopping',    'MeatTopping')],
      ['addLink', disj('CheeseTopping',    'VegetableTopping')],
      ['addLink', disj('CheeseTopping',    'FishTopping')],
      ['addLink', disj('MeatTopping',      'VegetableTopping')],
      ['addLink', disj('MeatTopping',      'FishTopping')],
      ['addLink', disj('VegetableTopping', 'FishTopping')],
    ],
    viewMs: 2200,
  },

  // ── 7. Leaf toppings ──────────────────────────────────────────────────────
  {
    user: "Now add the actual ingredients — the specific topping types that real pizza recipes use.",
    ai: "These are leaf classes — the most specific level of the hierarchy, representing concrete ingredients. They inherit everything from their parent categories automatically. I'll add Mozzarella and Parmesan under Cheese, PeperoniSausage under Meat, Tomato, Olive, and Garlic under Vegetable, and Anchovies under Fish.",
    tools: [
      ['addNode', cls('MozzarellaTopping')],
      ['addNode', cls('ParmesanTopping')],
      ['addNode', cls('PeperoniSausageTopping')],
      ['addNode', cls('TomatoTopping')],
      ['addNode', cls('OliveTopping')],
      ['addNode', cls('GarlicTopping')],
      ['addNode', cls('AnchoviesTopping')],
      ['addLink', sub('MozzarellaTopping',      'CheeseTopping')],
      ['addLink', sub('ParmesanTopping',        'CheeseTopping')],
      ['addLink', sub('PeperoniSausageTopping', 'MeatTopping')],
      ['addLink', sub('TomatoTopping',          'VegetableTopping')],
      ['addLink', sub('OliveTopping',           'VegetableTopping')],
      ['addLink', sub('GarlicTopping',          'VegetableTopping')],
      ['addLink', sub('AnchoviesTopping',       'FishTopping')],
      layout('elk-layered', 140),
    ],
    viewMs: 3000,
  },

  // ── 8. Object properties ──────────────────────────────────────────────────
  {
    user: "The schema looks good, but how do we connect pizzas to their toppings and bases? Classes alone don't capture relationships.",
    ai: "For relationships you need object properties — named links with a domain and range. The domain restricts which class the subject belongs to; the range restricts the object. I'll add hasTopping (domain: Pizza, range: PizzaTopping) and hasBase (domain: Pizza, range: PizzaBase). These domain and range declarations let the reasoner infer types automatically.",
    tools: [
      ['addNode', prop('hasTopping')],
      ['addNode', prop('hasBase')],
      ['addLink', dom('hasTopping', 'Pizza')],
      ['addLink', ran('hasTopping', 'PizzaTopping')],
      ['addLink', dom('hasBase',    'Pizza')],
      ['addLink', ran('hasBase',    'PizzaBase')],
      layout('elk-layered', 160),
    ],
    viewMs: 2800,
  },

  // ── 9. Inverse properties ─────────────────────────────────────────────────
  {
    user: "Can we also navigate in the opposite direction — from a topping back to its pizza?",
    ai: "Yes — owl:inverseOf declares that isToppingOf is the mirror of hasTopping. Asserting pizza1 hasTopping mozz1 automatically gives mozz1 isToppingOf pizza1 for free. The reasoner fires the prp-inv rules and generates all inverse edges in one pass. I'll add isToppingOf and isBaseOf as inverses.",
    tools: [
      ['addNode', prop('isToppingOf')],
      ['addNode', prop('isBaseOf')],
      ['addLink', inv('isToppingOf', 'hasTopping')],
      ['addLink', inv('isBaseOf',    'hasBase')],
      ['addLink', dom('isToppingOf', 'PizzaTopping')],
      ['addLink', ran('isToppingOf', 'Pizza')],
      ['addLink', dom('isBaseOf',    'PizzaBase')],
      ['addLink', ran('isBaseOf',    'Pizza')],
    ],
    viewMs: 2500,
  },

  // ── 10. OWL restrictions ──────────────────────────────────────────────────
  {
    user: "The reasoner can infer pizza1 is a Pizza from the hasTopping domain — but how would it ever know it's specifically a Margherita?",
    ai: "That requires owl:equivalentClass with a someValuesFrom restriction. Margherita is declared equivalent to all things that have at least one TomatoTopping. When pizza1 hasTopping tom1 and tom1 is a TomatoTopping, the cls-svf1 rule fires and classifies pizza1 as a Margherita. Restrictions use blank nodes and must be loaded as Turtle rather than individual addLink calls.",
    tools: [
      ['loadRdf', { turtle:
        '@prefix owl: <http://www.w3.org/2002/07/owl#> .\n' +
        '@prefix pizza: <http://www.pizza-ontology.com/pizza.owl#> .\n' +
        'pizza:Margherita owl:equivalentClass [ a owl:Restriction ; owl:onProperty pizza:hasTopping ; owl:someValuesFrom pizza:TomatoTopping ] .\n' +
        'pizza:AmericanHot owl:equivalentClass [ a owl:Restriction ; owl:onProperty pizza:hasTopping ; owl:someValuesFrom pizza:PeperoniSausageTopping ] .\n' +
        'pizza:FruttiDiMare owl:equivalentClass [ a owl:Restriction ; owl:onProperty pizza:hasTopping ; owl:someValuesFrom pizza:AnchoviesTopping ] .',
      }],
    ],
    viewMs: 2000,
  },

  // ── 11. ABox individuals ──────────────────────────────────────────────────
  {
    user: "That's all the class definitions — the TBox, right? When do we add actual pizzas?",
    ai: "Exactly — the TBox is the terminological box: classes and properties, the schema. The ABox is the assertion box: specific named individuals and their properties, the data. I'll switch to ABox view and add three untyped pizza individuals: pizza1, pizza2, pizza3. Their Pizza type will be inferred by the reasoner from the hasTopping domain.",
    tools: [
      ['setViewMode', { mode: 'abox' }],
      ['addNode', ind('pizza1', undefined, 'pizza1')],
      ['addNode', ind('pizza2', undefined, 'pizza2')],
      ['addNode', ind('pizza3', undefined, 'pizza3')],
      layout('dagre-lr', 200),
    ],
    viewMs: 2500,
  },

  // ── 12. pizza1 — Margherita ───────────────────────────────────────────────
  {
    user: "Let's build the first one — a Margherita-style pizza. What does pizza1 need?",
    ai: "A Margherita has mozzarella and tomato as toppings, on a thin-and-crispy base — the classic recipe. We intentionally leave pizza1's type unasserted; the reasoner will figure it out from the toppings. I'll add the individual ingredients and link them to pizza1.",
    tools: [
      ['addNode', ind('mozz1', 'MozzarellaTopping', 'mozz')],
      ['addNode', ind('tom1',  'TomatoTopping',      'tomato')],
      ['addNode', ind('thin1', 'ThinAndCrispyBase',  'thin & crispy')],
      ['addLink', link('pizza1', 'hasTopping', 'mozz1')],
      ['addLink', link('pizza1', 'hasTopping', 'tom1')],
      ['addLink', link('pizza1', 'hasBase',    'thin1')],
      ['focusNode', { iri: P + 'pizza1' }],
    ],
    viewMs: 2800,
  },

  // ── 13. pizza2 — AmericanHot ──────────────────────────────────────────────
  {
    user: "Now pizza2 — an AmericanHot. What makes it different from a Margherita?",
    ai: "An AmericanHot has peperoni sausage alongside mozzarella and olive, on a deep-pan base. Like pizza1, we assert the toppings and base but leave the pizza type for the reasoner. Note peperoni is a MeatTopping and mozzarella a CheeseTopping — disjoint categories, but that's fine for different individuals.",
    tools: [
      ['addNode', ind('pep1',   'PeperoniSausageTopping', 'peperoni')],
      ['addNode', ind('mozz2',  'MozzarellaTopping',       'mozz')],
      ['addNode', ind('olive1', 'OliveTopping',            'olive')],
      ['addNode', ind('deep1',  'DeepPanBase',             'deep pan')],
      ['addLink', link('pizza2', 'hasTopping', 'pep1')],
      ['addLink', link('pizza2', 'hasTopping', 'mozz2')],
      ['addLink', link('pizza2', 'hasTopping', 'olive1')],
      ['addLink', link('pizza2', 'hasBase',    'deep1')],
      ['focusNode', { iri: P + 'pizza2' }],
    ],
    viewMs: 2800,
  },

  // ── 14. pizza3 — FruttiDiMare ────────────────────────────────────────────
  {
    user: "And pizza3 — the FruttiDiMare? What goes on a seafood pizza?",
    ai: "FruttiDiMare is seafood-based: anchovies and garlic as toppings on a thin-and-crispy base. Garlic is the classic Italian accompaniment to seafood. Again we leave pizza3's type unasserted — the whole point is for the reasoner to derive it from the anchovies.",
    tools: [
      ['addNode', ind('anch1',   'AnchoviesTopping',  'anchovies')],
      ['addNode', ind('garlic1', 'GarlicTopping',     'garlic')],
      ['addNode', ind('thin2',   'ThinAndCrispyBase', 'thin & crispy')],
      ['addLink', link('pizza3', 'hasTopping', 'anch1')],
      ['addLink', link('pizza3', 'hasTopping', 'garlic1')],
      ['addLink', link('pizza3', 'hasBase',    'thin2')],
      EXPAND,
      layout('dagre-lr', 190),
      ['focusNode', { iri: P + 'pizza3' }],
    ],
    viewMs: 3000,
  },

  // ── 15. Run reasoning ────────────────────────────────────────────────────
  {
    user: "We have the schema and the data but no inferred facts yet. What happens when we run the OWL-RL reasoner?",
    ai: "OWL-RL applies forward-chaining rules to derive every fact logically entailed by your TBox and ABox together. It propagates subClassOf chains, uses domain and range constraints to infer types, fires inverse property rules, and uses someValuesFrom restrictions to classify individuals into named types. Running the reasoner now.",
    tools: [
      ['runReasoning', {}],
      EXPAND,
      layout('dagre-lr', 190),
    ],
    viewMs: 4000,
  },

  // ── 16. Inspect pizza1 ───────────────────────────────────────────────────
  {
    user: "What did the reasoner figure out about pizza1?",
    ai: "Three rules fired: the hasTopping domain axiom inferred pizza1 is a Pizza; cls-svf1 fired because pizza1 hasTopping tom1 and tom1 is a TomatoTopping — satisfying the Margherita equivalentClass restriction — so pizza1 is now a Margherita; and prp-inv generated the inverse isToppingOf back-links from each topping. Let me focus on pizza1 so you can see those inferred types.",
    tools: [
      ['focusNode',  { iri: P + 'pizza1' }],
      ['expandNode', { iri: P + 'pizza1', expand: true }],
    ],
    viewMs: 4500,
  },

  // ── 17. Inspect mozz1 ────────────────────────────────────────────────────
  {
    user: "What about mozz1 — what did the reasoner work out about that individual?",
    ai: "mozz1 was linked via hasTopping, so the range constraint fires and infers it is a PizzaTopping. Then the subClassOf chain propagates upward: MozzarellaTopping is a CheeseTopping which is a PizzaTopping — giving mozz1 all three types from a single asserted type. The reasoner did all of this automatically, with no explicit type assertion.",
    tools: [
      ['focusNode',  { iri: P + 'mozz1' }],
      ['expandNode', { iri: P + 'mozz1', expand: true }],
    ],
    viewMs: 4500,
  },
];

// ── Test ───────────────────────────────────────────────────────────────────
test('pizza-socratic: guide a small AI model to build a pizza ontology via Socratic questions', async ({ page }) => {
  const runner = new DemoRunner(page, BASE_URL);

  await runner.openStage();
  await runner.setStreamSpeed(28);

  for (const turn of TURNS) {
    await runner.addChatMessage('user', turn.user);
    await runner.pauseMs(1_600);

    await runner.addChatMessage('ai', turn.ai);
    await runner.waitForChatStream();
    await runner.pauseMs(900);

    for (const [name, args] of turn.tools) {
      await runner.callToolOnStage(name, args as Record<string, unknown>);
      await runner.pauseMs(350);
    }

    await runner.pauseMs(turn.viewMs ?? 2_000);
  }

  await runner.captionPause(
    'Full Manchester Pizza Ontology — built step by step through Socratic questions, classified by OWL-RL reasoning',
    5_000,
  );
});
