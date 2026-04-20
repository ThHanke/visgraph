#!/usr/bin/env node
/**
 * scripts/mcp-demo-foaf.mjs
 *
 * Playwright script that runs a scripted AI–user conversation over MCP tools,
 * captures SVG snapshots after each step, and writes:
 *   docs/mcp-demo/foaf-social-network.md
 *
 * Usage:
 *   node scripts/mcp-demo-foaf.mjs [--no-start-server] [--idle <ms>]
 *
 * The polyfill MUST be injected with page.addInitScript before page load
 * so that navigator.modelContext exists when the MCP server module initialises.
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

// ── helpers ────────────────────────────────────────────────────────────────

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
        resolve(res.statusCode < 500);
        res.resume();
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch (_) { resolve(false); }
  });
}

async function waitFor(url, ms = 120000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await httpGet(url)) return true;
    await sleep(500);
  }
  return false;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForCanvas(logs, ms = 30000, from = 0) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const e of logs.slice(from)) {
      if (e.includes('[Pipeline] Clustering complete')) return true;
    }
    await sleep(250);
  }
  return false;
}

/** Call an MCP tool via window.__mcpTools and return the parsed result. */
async function callTool(page, name, params = {}) {
  const result = await page.evaluate(
    async ([n, p]) => {
      const tool = window.__mcpTools && window.__mcpTools[n];
      if (!tool) return { success: false, error: `Tool not registered: ${n}` };
      try { return await tool(p); } catch (e) { return { success: false, error: String(e) }; }
    },
    [name, params]
  );
  return result;
}

// ── FOAF inline Turtle (avoids network fetch in headless) ──────────────────

const FOAF_TURTLE = `
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl:  <http://www.w3.org/2002/07/owl#> .

foaf:Person a owl:Class ; rdfs:label "Person" .
foaf:Organization a owl:Class ; rdfs:label "Organization" .
foaf:Agent a owl:Class ; rdfs:label "Agent" .
foaf:Person rdfs:subClassOf foaf:Agent .
foaf:Organization rdfs:subClassOf foaf:Agent .
foaf:knows a owl:ObjectProperty ; rdfs:domain foaf:Person ; rdfs:range foaf:Person ; rdfs:label "knows" .
foaf:member a owl:ObjectProperty ; rdfs:domain foaf:Agent ; rdfs:range foaf:Organization ; rdfs:label "member of" .
foaf:name a owl:DatatypeProperty ; rdfs:domain foaf:Agent ; rdfs:label "name" .
`.trim();

// ── ABox data ──────────────────────────────────────────────────────────────

const EX = 'http://example.org/';
const FOAF = 'http://xmlns.com/foaf/0.1/';
const NODES = [
  { iri: `${EX}alice`,   typeIri: `${FOAF}Person`,       label: 'Alice (PI)' },
  { iri: `${EX}bob`,     typeIri: `${FOAF}Person`,       label: 'Bob' },
  { iri: `${EX}carol`,   typeIri: `${FOAF}Person`,       label: 'Carol' },
  { iri: `${EX}dave`,    typeIri: `${FOAF}Person`,       label: 'Dave' },
  { iri: `${EX}acme`,    typeIri: `${FOAF}Organization`, label: 'ACME Corp' },
  { iri: `${EX}labs`,    typeIri: `${FOAF}Organization`, label: 'Research Labs' },
];
const LINKS = [
  { s: `${EX}alice`, p: `${FOAF}knows`, o: `${EX}bob` },
  { s: `${EX}alice`, p: `${FOAF}knows`, o: `${EX}carol` },
  { s: `${EX}bob`,   p: `${FOAF}knows`, o: `${EX}carol` },
  { s: `${EX}dave`,  p: `${FOAF}knows`, o: `${EX}alice` },
  { s: `${EX}alice`, p: `${FOAF}member`, o: `${EX}acme` },
  { s: `${EX}bob`,   p: `${FOAF}member`, o: `${EX}acme` },
  { s: `${EX}carol`, p: `${FOAF}member`, o: `${EX}labs` },
  { s: `${EX}dave`,  p: `${FOAF}member`, o: `${EX}labs` },
];

// ── markdown helpers ───────────────────────────────────────────────────────

function stepHeading(n, title) {
  return `\n---\n\n## Step ${n}: ${title}\n\n`;
}

function userMsg(text) {
  return `**You:** ${text}\n\n`;
}

function assistantMsg(text) {
  return `**Assistant:** ${text}\n\n`;
}


// ── main ───────────────────────────────────────────────────────────────────

async function run() {
  const argv = process.argv.slice(2);
  const noServer = argv.includes('--no-start-server') || argv.includes('-n');
  const idleIdx = argv.indexOf('--idle');
  const idleMs = idleIdx >= 0 && argv[idleIdx + 1] ? parseInt(argv[idleIdx + 1], 10) : 2500;
  const urlIdx = argv.indexOf('--url');
  const baseUrl = urlIdx >= 0 && argv[urlIdx + 1] ? argv[urlIdx + 1] : `http://localhost:${detectPort()}/`;

  const outDir = path.join(ROOT, 'docs', 'mcp-demo');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'foaf-social-network.md');
  const svgDir = path.join(outDir, 'foaf-social-network');
  if (!fs.existsSync(svgDir)) fs.mkdirSync(svgDir, { recursive: true });
  let snapCount = 0;

  // ── optionally start dev server ──────────────────────────────────────────
  let serverProc = null;
  if (!noServer && baseUrl.startsWith('http://localhost')) {
    console.log('Starting dev server...');
    serverProc = spawn('npm', ['run', 'dev'], {
      cwd: ROOT, stdio: 'ignore', detached: true, env: { ...process.env },
    });
    const ready = await waitFor(baseUrl, 120000);
    if (!ready) { console.error('Dev server not ready — aborting'); process.exit(1); }
    console.log('Dev server ready at', baseUrl);
  }

  // ── browser setup ────────────────────────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  const consoleLogs = [];
  page.on('console', msg => { try { consoleLogs.push(msg.text()); } catch (_) {} });
  page.on('pageerror', err => console.error('[pageerror]', String(err)));

  // ── inject polyfill BEFORE page modules run ──────────────────────────────
  await page.addInitScript(() => {
    const tools = {};
    Object.defineProperty(navigator, 'modelContext', {
      value: { registerTool: async (name, _d, _s, handler) => { tools[name] = handler; } },
      configurable: true,
    });
    window.__mcpTools = tools;
  });

  // ── navigate (no rdfUrl — we load data via MCP tools) ───────────────────
  console.log('Navigating to', baseUrl);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(idleMs);

  // Register MCP tools via the polyfill
  await page.evaluate(async () => {
    const mod = await import('/src/mcp/visgraphMcpServer.ts');
    await mod.registerMcpTools();
  });
  console.log('MCP tools registered');

  // ── markdown output ──────────────────────────────────────────────────────
  let md = `# FOAF Social Network — MCP Demo

> Auto-generated by \`scripts/mcp-demo-foaf.mjs\`.
> Shows an AI assistant building a knowledge graph from scratch through natural conversation.

---
`;

  async function snapshot(caption, slug) {
    await sleep(600);
    await callTool(page, 'fitCanvas', {});
    await sleep(400);
    const r = await callTool(page, 'exportImage', { format: 'svg' });
    if (r?.success && r.data?.content) {
      const filename = `${String(++snapCount).padStart(2, '0')}-${slug}.svg`;
      fs.writeFileSync(path.join(svgDir, filename), r.data.content, 'utf8');
      return `\n![${caption}](./foaf-social-network/${filename})\n\n`;
    }
    return `\n> ⚠ snapshot failed: ${r?.error}\n`;
  }

  // ── Step 1: Load FOAF ontology ───────────────────────────────────────────
  md += stepHeading(1, 'Load FOAF vocabulary');
  md += userMsg("I'd like to model a social network using FOAF. Can you get that set up?");
  md += assistantMsg("Sure! Loading the FOAF vocabulary now — that gives us `foaf:Person`, `foaf:Organization`, `foaf:knows`, and `foaf:member`.");

  const r1 = await callTool(page, 'loadRdf', { turtle: FOAF_TURTLE });
  console.log('Step 1 loadRdf:', r1);

  await waitForCanvas(consoleLogs, 15000, 0);
  await sleep(idleMs);

  // ── Step 2: Add 6 nodes ──────────────────────────────────────────────────
  md += stepHeading(2, 'Create the people and organisations');
  md += userMsg("We have four researchers — Alice (the PI), Bob, Carol, and Dave — plus two organisations: ACME Corp and Research Labs. Can you add them all?");
  md += assistantMsg("On it! Placing all six on the canvas and laying them out.");

  for (const n of NODES) {
    const r = await callTool(page, 'addNode', n);
    console.log('addNode', n.label, r?.success);
    await sleep(300);
  }

  await callTool(page, 'runLayout', { algorithm: 'dagre-lr' });
  await sleep(idleMs);
  await callTool(page, 'expandAll', {});
  await sleep(600);

  md += await snapshot('Six nodes on canvas', 'nodes');

  // ── Step 3: Add links ────────────────────────────────────────────────────
  md += stepHeading(3, 'Connect them with relationships');
  md += userMsg("Alice knows Bob and Carol. Bob knows Carol. Dave knows Alice. Alice and Bob are members of ACME Corp; Carol and Dave are members of Research Labs.");
  md += assistantMsg("Adding those eight relationships now.");

  for (const l of LINKS) {
    await callTool(page, 'addLink', { subjectIri: l.s, predicateIri: l.p, objectIri: l.o });
    await sleep(200);
  }

  await sleep(idleMs);
  md += await snapshot('Network with knows and member relationships', 'links');

  // ── Step 4: Run reasoning ────────────────────────────────────────────────
  md += stepHeading(4, 'Run the reasoner');
  md += userMsg("Can you run the reasoner now and tell me what it figured out?");
  md += assistantMsg("Running OWL-RL now. Since `foaf:Person rdfs:subClassOf foaf:Agent`, every Person should also get the Agent type automatically.");

  const r4 = await callTool(page, 'runReasoning', {});
  console.log('runReasoning:', r4);
  await sleep(idleMs);

  md += assistantMsg(`Done — **${r4?.data?.inferredTriples ?? '?'} new triples** inferred. All four researchers now also carry the \`foaf:Agent\` type.`);
  md += await snapshot('Graph after reasoning — Agent types inferred', 'after-reasoning');

  // ── Step 5: Search entities ──────────────────────────────────────────────
  md += stepHeading(5, 'Inspect ACME Corp');
  md += userMsg("Who's a member of ACME Corp? Can you zoom in on it?");
  md += assistantMsg("ACME shows Alice and Bob as members. Zooming in.");

  await callTool(page, 'searchEntities', { query: 'ACME' });
  await callTool(page, 'focusNode', { iri: `${EX}acme` });
  await sleep(800);

  md += await snapshot('ACME Corp and its members', 'acme-focus');

  // ── Step 6: Add Eve ──────────────────────────────────────────────────────
  md += stepHeading(6, 'Add a new researcher');
  md += userMsg("One more person: add Eve. She's a researcher who knows Bob and works at Research Labs.");
  md += assistantMsg("Adding Eve and wiring her up.");

  const eveIri = `${EX}eve`;
  await callTool(page, 'addNode', { iri: eveIri, typeIri: `${FOAF}Person`, label: 'Eve' });
  await sleep(300);
  await callTool(page, 'addLink', { subjectIri: eveIri, predicateIri: `${FOAF}knows`, objectIri: `${EX}bob` });
  await callTool(page, 'addLink', { subjectIri: eveIri, predicateIri: `${FOAF}member`, objectIri: `${EX}labs` });
  await callTool(page, 'focusNode', { iri: eveIri });
  await sleep(idleMs);

  md += await snapshot('Eve added — knows Bob, member of Research Labs', 'eve-added');

  // ── Step 7: Export Turtle ────────────────────────────────────────────────
  md += stepHeading(7, 'Export the graph');
  md += userMsg("Nice! Export the whole thing as Turtle so I can use it elsewhere.");

  const r7 = await callTool(page, 'exportGraph', { format: 'turtle' });

  if (r7?.success && r7.data?.content) {
    const ttl = r7.data.content.slice(0, 6000) + (r7.data.content.length > 6000 ? '\n# ... truncated' : '');
    md += assistantMsg("Here's the complete RDF graph:");
    md += '\n```turtle\n' + ttl + '\n```\n\n';
  }

  // ── Final graph state ────────────────────────────────────────────────────
  const state = await callTool(page, 'getGraphState', {});
  md += `\n---\n\n*${state?.data?.nodeCount ?? '?'} nodes · ${state?.data?.linkCount ?? '?'} links*\n`;

  // ── write output ─────────────────────────────────────────────────────────
  fs.writeFileSync(outFile, md, 'utf8');
  console.log('\nWrote', outFile, `(${md.length} chars)`);

  await browser.close();
  if (serverProc) {
    try { process.kill(-serverProc.pid); } catch (_) {}
  }
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
