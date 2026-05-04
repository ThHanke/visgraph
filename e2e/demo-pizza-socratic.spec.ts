/**
 * Pizza Socratic demo — a small AI model is guided to build a pizza ontology
 * through Socratic questions, never direct instructions.
 *
 * The operator (left chat) asks leading questions; the AI discovers and applies
 * addNode / addLink / runLayout / getNodeDetails in response.  Each turn
 * introduces one ontology concept: OWL classes → subClassOf hierarchy →
 * specialisation → object properties → layout → introspection.
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

const cls = (name: string, label?: string) =>
  ({ iri: P + name, typeIri: OWL + 'Class', label: label ?? name });
const sub = (s: string, o: string) =>
  ({ subjectIri: P + s, predicateIri: RDFS + 'subClassOf', objectIri: P + o });
const link = (s: string, p: string, o: string) =>
  ({ subjectIri: P + s, predicateIri: P + p, objectIri: P + o });
const layout = (alg: string) =>
  ['runLayout', { algorithm: alg }] as const;

type ToolCall = readonly [string, Record<string, unknown>];
interface Turn { user: string; ai: string; tools: ToolCall[]; viewMs?: number; }

const TURNS: Turn[] = [
  // ── T0 — The root concept ─────────────────────────────────────────────────
  {
    user: 'Can you teach me how ontologies work using pizzas as a real-world example? Start by adding the most fundamental concept to the graph.',
    ai: 'Sure! In an ontology, everything starts with a class — a named category for a set of things. The most fundamental concept here is simply "Pizza" itself: the idea of what a pizza is, before we talk about any specific pizza. I\'ll add it as an OWL class.',
    tools: [
      ['addNode', cls('Pizza')],
    ],
    viewMs: 2500,
  },

  // ── T1 — Two building blocks ──────────────────────────────────────────────
  {
    user: 'Great start! A pizza is made of two main building blocks — its base and its toppings. Could you model those as more specific types of Pizza in the ontology?',
    ai: 'Good thinking! We use rdfs:subClassOf to say one class is a specialisation of another. PizzaBase and PizzaTopping are both sub-concepts of Pizza — every base or topping is still "part of" the pizza world. I\'ll add both classes and link them up.',
    tools: [
      ['addNode', cls('PizzaBase',    'Pizza Base')],
      ['addNode', cls('PizzaTopping', 'Pizza Topping')],
      ['addLink', sub('PizzaBase',    'Pizza')],
      ['addLink', sub('PizzaTopping', 'Pizza')],
      layout('elk-layered'),
    ],
    viewMs: 2800,
  },

  // ── T2 — Base variants ────────────────────────────────────────────────────
  {
    user: 'Nice! PizzaBase can be either deep pan or thin and crispy. Can you add those two variants as more specific types of PizzaBase?',
    ai: 'Exactly — those are sub-classes of PizzaBase. By placing them one level lower in the hierarchy, we say: a deep pan base IS a pizza base, but it adds specific meaning (thickness). Same pattern for thin and crispy. Both sit beneath PizzaBase in the tree.',
    tools: [
      ['addNode', cls('DeepPanBase',       'Deep Pan Base')],
      ['addNode', cls('ThinAndCrispyBase', 'Thin & Crispy Base')],
      ['addLink', sub('DeepPanBase',       'PizzaBase')],
      ['addLink', sub('ThinAndCrispyBase', 'PizzaBase')],
      layout('elk-layered'),
    ],
    viewMs: 2800,
  },

  // ── T3 — Concrete toppings ────────────────────────────────────────────────
  {
    user: "Now let's add some real toppings. Can you add Mozzarella, TomatoSauce, and Pepperoni as specific types of PizzaTopping?",
    ai: 'These are leaf classes — the most specific level of the hierarchy. Each one is a PizzaTopping, but they represent distinct ingredients. I\'ll add all three and connect them with subClassOf links.',
    tools: [
      ['addNode', cls('MozzarellaTopping', 'Mozzarella')],
      ['addNode', cls('TomatoSauce',       'Tomato Sauce')],
      ['addNode', cls('PepperoniTopping',  'Pepperoni')],
      ['addLink', sub('MozzarellaTopping', 'PizzaTopping')],
      ['addLink', sub('TomatoSauce',       'PizzaTopping')],
      ['addLink', sub('PepperoniTopping',  'PizzaTopping')],
      layout('elk-layered'),
    ],
    viewMs: 3000,
  },

  // ── T4 — Object property: hasPart ─────────────────────────────────────────
  {
    user: "The graph has the building blocks, but a Pizza isn't linked to its parts yet. Can you express that a Pizza has both a PizzaBase and a PizzaTopping using an addLink call?",
    ai: 'Right — classes are isolated until we connect them with a property. "hasPart" is an object property that expresses structural composition: a Pizza hasPart a PizzaBase, and hasPart a PizzaTopping. This is how OWL describes how things relate to each other.',
    tools: [
      ['addLink', link('Pizza', 'hasPart', 'PizzaBase')],
      ['addLink', link('Pizza', 'hasPart', 'PizzaTopping')],
    ],
    viewMs: 2500,
  },

  // ── T5 — Layout ───────────────────────────────────────────────────────────
  {
    user: 'The graph is getting complex. Can you arrange the nodes so the hierarchy is easy to read?',
    ai: 'I\'ll run a top-down hierarchical layout — it places parent classes above their children, so the taxonomy reads naturally from top to bottom. The hasPart connections will fan out from Pizza at the top.',
    tools: [
      layout('dagre-tb'),
    ],
    viewMs: 3000,
  },

  // ── T6 — Introspection ────────────────────────────────────────────────────
  {
    user: "Let's verify what we've built. Can you look up the details of the Pizza concept and tell me what you see?",
    ai: "Of course! I'll call getNodeDetails to inspect all asserted RDF triples for the Pizza class. This tells us exactly what the ontology says about Pizza — its type, any subClassOf relations it participates in, and the hasPart links we just added.",
    tools: [
      ['getNodeDetails', { iri: P + 'Pizza' }],
    ],
    viewMs: 4000,
  },
];

// ── Test ───────────────────────────────────────────────────────────────────
test('pizza-socratic: guide a small AI model to build a pizza ontology via Socratic questions', async ({ page }) => {
  const runner = new DemoRunner(page, BASE_URL);

  await runner.openStage();
  await runner.setStreamSpeed(30);

  for (const turn of TURNS) {
    await runner.addChatMessage('user', turn.user);
    await runner.pauseMs(1_600);

    await runner.addChatMessage('ai', turn.ai);
    await runner.waitForChatStream();
    await runner.pauseMs(1_000);

    for (const [name, args] of turn.tools) {
      await runner.callToolOnStage(name, args as Record<string, unknown>);
      await runner.pauseMs(400);
    }

    await runner.pauseMs(turn.viewMs ?? 2_000);
  }

  await runner.captionPause(
    'Pizza ontology built step by step — guided by questions, not instructions',
    4_500,
  );
});
