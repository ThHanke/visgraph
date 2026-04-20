#!/usr/bin/env node
/**
 * scripts/mcp-demo-reasoning.mjs
 *
 * Builds the reasoning-demo graph ENTIRELY from scratch via MCP tools:
 *   addNode  — creates every class, property, and individual
 *   addLink  — creates every rdfs:subClassOf, rdfs:subPropertyOf,
 *              owl:inverseOf, rdfs:domain/range, and ABox triple
 *
 * Then runs OWL-RL reasoning and reports every inferred triple.
 *
 * Output: docs/mcp-demo/reasoning-demo.md
 *
 * Usage:
 *   node scripts/mcp-demo-reasoning.mjs [--no-start-server] [--idle <ms>]
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import http from 'http';
import { spawn } from 'child_process';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── util ────────────────────────────────────────────────────────────────────

function detectPort() {
  try {
    const cfg = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8');
    const m = cfg.match(/port\s*:\s*(\d{2,5})/);
    if (m) return parseInt(m[1], 10);
  } catch (_) {}
  return 8080;
}

function httpGet(url, ms = 3000) {
  return new Promise(resolve => {
    try {
      const req = http.request(new URL(url), { method: 'GET', timeout: ms }, res => {
        resolve(res.statusCode < 500); res.resume();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch (_) { resolve(false); }
  });
}

async function waitFor(url, ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await httpGet(url)) return true; await sleep(500); }
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForCanvas(logs, ms = 30000, from = 0) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const e of logs.slice(from)) if (e.includes('[Pipeline] Clustering complete')) return true;
    await sleep(250);
  }
  return false;
}

async function callTool(page, name, params = {}) {
  return page.evaluate(async ([n, p]) => {
    const tool = window.__mcpTools?.[n];
    if (!tool) return { success: false, error: `Tool not registered: ${n}` };
    try { return await tool(p); } catch (e) { return { success: false, error: String(e) }; }
  }, [name, params]);
}

// ── IRI shorthand ────────────────────────────────────────────────────────────

const EX    = 'http://example.com/reasoning-demo#';
const OWL   = 'http://www.w3.org/2002/07/owl#';
const RDFS  = 'http://www.w3.org/2000/01/rdf-schema#';
const RDF   = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

const owl  = s => `${OWL}${s}`;
const rdfs = s => `${RDFS}${s}`;
const rdf  = s => `${RDF}${s}`;
const ex   = s => `${EX}${s}`;

function sp(iri) {
  return iri
    .replace(EX,   'ex:')
    .replace(OWL,  'owl:')
    .replace(RDFS, 'rdfs:')
    .replace(RDF,  'rdf:')
    .replace('http://www.w3.org/2001/XMLSchema#', 'xsd:');
}

// ── dataset definition ───────────────────────────────────────────────────────

// TBox — OWL classes (each becomes a canvas node)
const TBOX_CLASSES = [
  { iri: ex('Person'),    typeIri: owl('Class'), label: 'Person' },
  { iri: ex('Employee'),  typeIri: owl('Class'), label: 'Employee' },
  { iri: ex('Manager'),   typeIri: owl('Class'), label: 'Manager' },
  { iri: ex('Executive'), typeIri: owl('Class'), label: 'Executive' },
];

// TBox — OWL object properties (each becomes a canvas node)
const TBOX_OBJ_PROPS = [
  { iri: ex('knows'),         typeIri: owl('ObjectProperty'), label: 'knows' },
  { iri: ex('hasFriend'),     typeIri: owl('ObjectProperty'), label: 'hasFriend' },
  { iri: ex('manages'),       typeIri: owl('ObjectProperty'), label: 'manages' },
  { iri: ex('isManagedBy'),   typeIri: owl('ObjectProperty'), label: 'isManagedBy' },
  { iri: ex('isColleagueOf'), typeIri: owl('ObjectProperty'), label: 'isColleagueOf' },
  { iri: ex('hasSupervisor'), typeIri: owl('ObjectProperty'), label: 'hasSupervisor' },
];

// TBox — OWL annotation properties
const TBOX_ANN_PROPS = [
  { iri: ex('jobTitle'), typeIri: owl('AnnotationProperty'), label: 'jobTitle' },
];

// TBox links: structural axioms that drive OWL-RL inference
const TBOX_LINKS = [
  // Class hierarchy
  { s: ex('Employee'),  p: rdfs('subClassOf'),    o: ex('Person'),    group: 'class hierarchy',   note: 'Employee ⊆ Person' },
  { s: ex('Manager'),   p: rdfs('subClassOf'),    o: ex('Employee'),  group: 'class hierarchy',   note: 'Manager ⊆ Employee' },
  { s: ex('Executive'), p: rdfs('subClassOf'),    o: ex('Manager'),   group: 'class hierarchy',   note: 'Executive ⊆ Manager' },
  // Property axioms
  { s: ex('hasFriend'),     p: rdfs('subPropertyOf'), o: ex('knows'),         group: 'subPropertyOf', note: 'hasFriend ⊆ knows → asserting hasFriend infers knows' },
  { s: ex('isManagedBy'),   p: owl('inverseOf'),      o: ex('manages'),       group: 'inverseOf',     note: 'manages ↔ isManagedBy' },
  { s: ex('isColleagueOf'), p: rdf('type'),            o: owl('SymmetricProperty'), group: 'symmetric', note: 'A isColleagueOf B → B isColleagueOf A' },
  { s: ex('hasSupervisor'), p: rdf('type'),            o: owl('TransitiveProperty'), group: 'transitive', note: 'A→B→C infers A→C' },
  { s: ex('jobTitle'),      p: rdfs('subPropertyOf'), o: rdfs('comment'),     group: 'annotation',    note: 'jobTitle ⊆ rdfs:comment' },
  // Domain / range
  { s: ex('knows'),         p: rdfs('domain'), o: ex('Person'),   group: 'domain/range', note: '' },
  { s: ex('knows'),         p: rdfs('range'),  o: ex('Person'),   group: 'domain/range', note: '' },
  { s: ex('hasFriend'),     p: rdfs('domain'), o: ex('Person'),   group: 'domain/range', note: '' },
  { s: ex('hasFriend'),     p: rdfs('range'),  o: ex('Person'),   group: 'domain/range', note: '' },
  { s: ex('manages'),       p: rdfs('domain'), o: ex('Manager'),  group: 'domain/range', note: 'domain → dave rdf:type Manager (inferred from asserting manages)' },
  { s: ex('manages'),       p: rdfs('range'),  o: ex('Employee'), group: 'domain/range', note: '' },
  { s: ex('isManagedBy'),   p: rdfs('domain'), o: ex('Employee'), group: 'domain/range', note: '' },
  { s: ex('isManagedBy'),   p: rdfs('range'),  o: ex('Manager'),  group: 'domain/range', note: '' },
  { s: ex('isColleagueOf'), p: rdfs('domain'), o: ex('Employee'), group: 'domain/range', note: '' },
  { s: ex('isColleagueOf'), p: rdfs('range'),  o: ex('Employee'), group: 'domain/range', note: '' },
  { s: ex('hasSupervisor'), p: rdfs('domain'), o: ex('Employee'), group: 'domain/range', note: '' },
  { s: ex('hasSupervisor'), p: rdfs('range'),  o: ex('Manager'),  group: 'domain/range', note: '' },
  { s: ex('jobTitle'),      p: rdfs('domain'), o: ex('Employee'), group: 'domain/range', note: '' },
];

// ABox individuals
const ABOX_NODES = [
  { iri: ex('alice'), typeIri: ex('Executive'), label: 'Alice',
    note: 'Explicit: Executive. Inferred: Manager, Employee, Person (subClassOf chain)' },
  { iri: ex('bob'),   typeIri: ex('Employee'),  label: 'Bob',
    note: 'Explicit: Employee. Inferred: Person' },
  { iri: ex('carol'), typeIri: ex('Employee'),  label: 'Carol',
    note: 'Explicit: Employee. Inferred: Person' },
  { iri: ex('dave'),  label: 'Dave',
    note: 'NO explicit rdf:type — reasoner infers Manager from domain axiom on manages' },
];

// ABox property assertions (object properties + annotation literals via Turtle)
const ABOX_LINKS = [
  { s: ex('alice'), p: ex('hasFriend'),     o: ex('bob'),   rule: 'subPropertyOf',  infers: 'alice knows bob' },
  { s: ex('alice'), p: ex('manages'),       o: ex('carol'), rule: 'inverseOf',      infers: 'carol isManagedBy alice' },
  { s: ex('dave'),  p: ex('manages'),       o: ex('bob'),   rule: 'domain',         infers: 'dave rdf:type Manager' },
  { s: ex('bob'),   p: ex('isColleagueOf'), o: ex('carol'), rule: 'symmetric',      infers: 'carol isColleagueOf bob' },
  { s: ex('carol'), p: ex('hasSupervisor'), o: ex('bob'),   rule: 'transitive (1)', infers: '(combined → carol hasSupervisor alice)' },
  { s: ex('bob'),   p: ex('hasSupervisor'), o: ex('alice'), rule: 'transitive (2)', infers: 'carol hasSupervisor alice' },
];

// Annotation (datatype literal) assertions — added via loadRdf
const ABOX_ANNOTATIONS_TTL = `
@prefix ex:   <http://example.com/reasoning-demo#> .
ex:alice ex:jobTitle "Chief Executive" .
ex:dave  ex:jobTitle "Division Manager" .
`.trim();

// ── Turtle triple parser for before/after diff ────────────────────────────


// ── markdown helpers ──────────────────────────────────────────────────────

function userMsg(text) { return `**You:** ${text}\n\n`; }
function assistantMsg(text) { return `**Assistant:** ${text}\n\n`; }

// ── main ─────────────────────────────────────────────────────────────────────

async function run() {
  const argv = process.argv.slice(2);
  const noServer = argv.includes('--no-start-server') || argv.includes('-n');
  const idleMs = (() => { const i = argv.indexOf('--idle'); return i >= 0 ? parseInt(argv[i + 1], 10) : 2500; })();
  const urlIdx = argv.indexOf('--url');
  const baseUrl = urlIdx >= 0 && argv[urlIdx + 1] ? argv[urlIdx + 1] : `http://localhost:${detectPort()}/`;

  const outDir = path.join(ROOT, 'docs', 'mcp-demo');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'reasoning-demo.md');
  const svgDir = path.join(outDir, 'reasoning-demo');
  if (!fs.existsSync(svgDir)) fs.mkdirSync(svgDir, { recursive: true });
  let snapCount = 0;

  async function snap(page, caption, slug) {
    await callTool(page, 'fitCanvas', {});
    await sleep(600);
    const r = await callTool(page, 'exportImage', { format: 'svg' });
    if (r?.success && r.data?.content) {
      const filename = `${String(++snapCount).padStart(2, '0')}-${slug}.svg`;
      fs.writeFileSync(path.join(svgDir, filename), r.data.content, 'utf8');
      return `\n![${caption}](./reasoning-demo/${filename})\n\n`;
    }
    return `\n> ⚠ SVG export failed\n`;
  }

  let serverProc = null;
  if (!noServer && baseUrl.startsWith('http://localhost')) {
    console.log('Starting dev server...');
    serverProc = spawn('npm', ['run', 'dev'], { cwd: ROOT, stdio: 'ignore', detached: true, env: { ...process.env } });
    if (!await waitFor(baseUrl, 120000)) { console.error('Server not ready'); process.exit(1); }
    console.log('Dev server ready');
  }

  const browser = await chromium.launch({ headless: true });
  const bctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await bctx.newPage();
  const logs = [];
  page.on('console', m => { try { logs.push(m.text()); } catch (_) {} });
  page.on('pageerror', e => console.error('[page]', String(e)));

  await page.addInitScript(() => {
    const tools = {};
    Object.defineProperty(navigator, 'modelContext', {
      value: { registerTool: async (n, _d, _s, h) => { tools[n] = h; } },
      configurable: true,
    });
    window.__mcpTools = tools;
  });

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(idleMs);
  await page.evaluate(async () => {
    const mod = await import('/src/mcp/visgraphMcpServer.ts');
    await mod.registerMcpTools();
  });
  console.log('MCP tools registered');

  // ── begin markdown ─────────────────────────────────────────────────────────
  let md = `# OWL-RL Reasoning Demo

> Auto-generated by \`scripts/mcp-demo-reasoning.mjs\`.
> An AI assistant builds an OWL ontology from scratch — every class, property, and individual
> is created via MCP tool calls. No pre-loaded Turtle.

---

`;

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 1 — TBox: OWL classes
  // ══════════════════════════════════════════════════════════════════════════
  md += `## Step 1 — Define the class hierarchy\n\n`;
  md += userMsg("I want to model a small organisation. Let's start with a four-level class hierarchy: Person → Employee → Manager → Executive.");
  md += assistantMsg("Creating each class as a canvas node now. I'll wire the subClassOf chain once the properties are in place too.");

  for (const c of TBOX_CLASSES) {
    await callTool(page, 'addNode', { iri: c.iri, typeIri: c.typeIri, label: c.label });
    console.log('class', c.label);
    await sleep(250);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 2 — TBox: OWL properties
  // ══════════════════════════════════════════════════════════════════════════
  md += `## Step 2 — Declare the properties\n\n`;
  md += userMsg("Now add the object properties — knows, hasFriend, manages, isManagedBy, isColleagueOf, hasSupervisor — and a jobTitle annotation property. Each should carry some inference axiom.");
  md += assistantMsg("Creating the property nodes. The axioms — subPropertyOf, inverseOf, symmetric, transitive, domain/range — come as links in the next step.");

  for (const p of [...TBOX_OBJ_PROPS, ...TBOX_ANN_PROPS]) {
    await callTool(page, 'addNode', { iri: p.iri, typeIri: p.typeIri, label: p.label });
    await sleep(250);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 3 — TBox links (structural axioms)
  // ══════════════════════════════════════════════════════════════════════════
  md += `## Step 3 — Wire up the ontology axioms\n\n`;
  md += userMsg("Great. Now connect everything — subclass chain, property axioms, domain and range.");
  md += assistantMsg("Wiring all the structural triples: `rdfs:subClassOf`, `rdfs:subPropertyOf`, `owl:inverseOf`, symmetric/transitive property types, and `rdfs:domain`/`rdfs:range`.");

  for (const l of TBOX_LINKS) {
    await callTool(page, 'addLink', { subjectIri: l.s, predicateIri: l.p, objectIri: l.o });
    await sleep(150);
  }

  await callTool(page, 'runLayout', { algorithm: 'dagre-tb' });
  await callTool(page, 'expandAll', {});
  await sleep(idleMs);
  md += await snap(page, 'TBox — classes and properties on canvas', 'tbox');
  console.log('TBox complete');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 4 — ABox individuals
  // ══════════════════════════════════════════════════════════════════════════
  md += `## Step 4 — Add the people\n\n`;
  md += userMsg("Now for the individuals: Alice is an Executive, Bob and Carol are Employees. Dave has no type yet — I want to see if the reasoner works it out.");
  md += assistantMsg("Adding all four. Dave intentionally has no `rdf:type` — he'll get `Manager` inferred from the domain axiom once he asserts `ex:manages`.");

  for (const n of ABOX_NODES) {
    await callTool(page, 'addNode', { iri: n.iri, label: n.label, ...(n.typeIri ? { typeIri: n.typeIri } : {}) });
    console.log('individual', n.label);
    await sleep(300);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 5 — ABox annotation assertions
  // ══════════════════════════════════════════════════════════════════════════
  md += `## Step 5 — Add job titles\n\n`;
  md += userMsg("Give Alice the title \"Chief Executive\" and Dave \"Division Manager\" using `ex:jobTitle`.");
  md += assistantMsg("Done. Literals go in as inline Turtle. Since `ex:jobTitle` is a subproperty of `rdfs:comment`, the reasoner will infer `rdfs:comment` literals for both too.");

  await callTool(page, 'loadRdf', { turtle: ABOX_ANNOTATIONS_TTL });
  await sleep(400);

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 6 — ABox object property assertions
  // ══════════════════════════════════════════════════════════════════════════
  md += `## Step 6 — Connect the people\n\n`;
  md += userMsg("Now the relationships: Alice manages Carol, Dave manages Bob, Alice is friends with Bob, Bob and Carol are colleagues, and the supervisor chain goes Carol → Bob → Alice.");
  md += assistantMsg("Adding those six edges. Each one triggers a specific OWL-RL rule — let's see how the reasoner handles them.");

  const stateBefore = await callTool(page, 'getGraphState', {});
  const nodesBefore = stateBefore?.data?.nodes ?? [];

  for (const l of ABOX_LINKS) {
    await callTool(page, 'addLink', { subjectIri: l.s, predicateIri: l.p, objectIri: l.o });
    await sleep(200);
  }

  await sleep(idleMs);
  await callTool(page, 'runLayout', { algorithm: 'dagre-lr' });
  await callTool(page, 'expandAll', {});
  await sleep(idleMs);
  md += await snap(page, 'Full graph before reasoning', 'before-reasoning');
  console.log('Pre-reasoning snapshot done');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 7 — Run OWL-RL reasoning
  // ══════════════════════════════════════════════════════════════════════════
  md += `## Step 7 — Run the reasoner\n\n`;
  md += userMsg("Okay, run the reasoner and show me what it inferred.");

  const r7 = await callTool(page, 'runReasoning', {});
  await sleep(idleMs);
  console.log('runReasoning result:', r7?.data);

  const stateAfter = await callTool(page, 'getGraphState', {});
  const nodesAfter = stateAfter?.data?.nodes ?? [];
  const aboxIris   = new Set(ABOX_NODES.map(n => n.iri));
  const nodeBeforeMap = new Map(nodesBefore.map(n => [n.iri, new Set(n.types ?? [])]));
  let inferredNewTypes = 0;

  // Build inference summary
  const typeRows = [];
  for (const n of nodesAfter.filter(n => aboxIris.has(n.iri))) {
    const before = nodeBeforeMap.get(n.iri) ?? new Set();
    const added  = (n.types ?? []).filter(t => !before.has(t) && !t.startsWith(OWL));
    const kept   = [...before].filter(t => !t.startsWith(OWL));
    inferredNewTypes += added.length;
    typeRows.push({ name: n.label || sp(n.iri), asserted: kept.map(t => sp(t)).join(', ') || '—', inferred: added.map(t => sp(t)).join(', ') || '—' });
  }

  md += assistantMsg(`Done — **${r7?.data?.inferredTriples ?? '?'} new triples** inferred, **${(stateAfter?.data?.linkCount ?? 0) - (stateBefore?.data?.linkCount ?? 0)} new edges** on canvas.`);

  md += `**Inferred types** (from subClassOf chain + domain axiom):\n\n`;
  md += `| Person | Asserted type | Inferred types |\n|--------|--------------|----------------|\n`;
  for (const row of typeRows) {
    md += `| ${row.name} | ${row.asserted} | ${row.inferred} |\n`;
  }
  md += '\n';

  // Spot-check expected property inferences
  const EXPECTED_INFERRED = [
    { s: ex('alice'), p: ex('knows'),         o: ex('bob'),   rule: 'hasFriend ⊆ knows (subPropertyOf)' },
    { s: ex('carol'), p: ex('isManagedBy'),   o: ex('alice'), rule: 'inverse of manages' },
    { s: ex('carol'), p: ex('isColleagueOf'), o: ex('bob'),   rule: 'SymmetricProperty' },
    { s: ex('carol'), p: ex('hasSupervisor'), o: ex('alice'), rule: 'TransitiveProperty (carol→bob→alice)' },
  ];

  md += `**Inferred relationships**:\n\n`;
  md += `| Triple | Rule |\n|--------|------|\n`;
  for (const e of EXPECTED_INFERRED) {
    const check = await callTool(page, 'getLinks', { subjectIri: e.s, predicateIri: e.p, objectIri: e.o, limit: 2 });
    const found = (check?.data?.links?.length ?? 0) > 0;
    md += `| ${sp(e.s)} ${sp(e.p)} ${sp(e.o)} ${found ? '✓' : '✗'} | ${e.rule} |\n`;
    await sleep(100);
  }
  md += '\n';

  await callTool(page, 'expandAll', {});
  await sleep(600);
  md += await snap(page, 'Graph after reasoning — inferred edges and types visible', 'after-reasoning');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 8 — Focus on Dave (domain-inferred type)
  // ══════════════════════════════════════════════════════════════════════════
  md += `## Step 8 — Check on Dave\n\n`;
  md += userMsg("Dave had no explicit type — what did the reasoner give him?");
  md += assistantMsg("Dave asserted `manages bob`. The domain axiom `manages rdfs:domain Manager` fired, giving him `Manager`. The subClassOf chain then added `Employee` and `Person` on top.");

  await callTool(page, 'focusNode', { iri: ex('dave') });
  await sleep(800);
  md += await snap(page, "Dave's node — inferred types visible in annotation card", 'dave-focus');

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 9 — Export final Turtle
  // ══════════════════════════════════════════════════════════════════════════
  md += `## Step 9 — Export the graph\n\n`;
  md += userMsg("Perfect. Export the complete graph as Turtle.");
  md += assistantMsg("Here's the asserted graph. The inferred triples live in `urn:vg:inferred` and aren't included here.");

  const r9 = await callTool(page, 'exportGraph', { format: 'turtle' });
  if (r9?.success && r9.data?.content) {
    const ttl = r9.data.content;
    md += `\n\`\`\`turtle\n${ttl.length > 10000 ? ttl.slice(0, 10000) + '\n# ... truncated' : ttl}\n\`\`\`\n\n`;
  }

  fs.writeFileSync(outFile, md, 'utf8');
  console.log(`\nWrote ${outFile} (${md.length} chars)`);

  await browser.close();
  if (serverProc) { try { process.kill(-serverProc.pid); } catch (_) {} }
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
