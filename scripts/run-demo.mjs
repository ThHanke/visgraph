#!/usr/bin/env node
/**
 * scripts/run-demo.mjs
 *
 * Generic MCP demo runner. Reads a seed markdown file, executes all embedded
 * JSON-RPC tool calls against a live Vite dev server, captures SVG snapshots,
 * and writes the filled markdown to the output path.
 *
 * Seed format:
 *   - Prose and assistant/user turns are copied verbatim.
 *   - Backtick-wrapped JSON-RPC 2.0 lines are tool calls:
 *       `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"...","arguments":{...}}}`
 *   - A ```tool-result``` fenced block immediately following tool-call lines has its
 *     contents replaced with real execution results.
 *   - A ```snapshot``` fenced block takes an SVG screenshot:
 *       ```snapshot
 *       caption: <caption text>
 *       slug: <filename-slug>
 *       ```
 *     The block is replaced with a markdown image reference.
 *
 * Usage:
 *   node scripts/run-demo.mjs <seed-file> [options]
 *
 * Options:
 *   --out <file>         Output file path (default: docs/mcp-demo/<seed-basename>.md)
 *   --url <url>          Base URL (default: auto-detected from vite.config.ts)
 *   --no-start-server    Skip starting the dev server
 *   --idle <ms>          Post-navigation idle wait in ms (default: 2500)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startBrowser, callTool, sleep, ROOT } from './demo-bootstrap.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── arg parsing ──────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function argVal(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

const seedFile = argv.find(a => !a.startsWith('--') && argv.indexOf(a) === argv.findIndex(x => x === a));
if (!seedFile) {
  console.error('Usage: node scripts/run-demo.mjs <seed-file> [--out <output>] [--url <url>] [--no-start-server] [--idle <ms>]');
  process.exit(1);
}

const seedPath = path.resolve(seedFile);
if (!fs.existsSync(seedPath)) {
  console.error(`Seed file not found: ${seedPath}`);
  process.exit(1);
}

const seedBasename = path.basename(seedPath, '.md').replace(/^seeds\//, '');
const defaultOut = path.join(ROOT, 'docs', 'mcp-demo', `${seedBasename}.md`);
const outPath = path.resolve(argVal('--out') ?? defaultOut);
const noServer = argv.includes('--no-start-server') || argv.includes('-n');
const idleMs = parseInt(argVal('--idle') ?? '2500', 10);
const baseUrl = argVal('--url') ?? undefined;

// ── seed parser ──────────────────────────────────────────────────────────────

const JSONRPC_LINE = /^\s*`(\{"jsonrpc":"2\.0".*"method":"tools\/call".*\})`\s*$/;
const FENCE_OPEN   = /^```(\S+)\s*$/;
const FENCE_CLOSE  = /^```\s*$/;

function parseSeed(content) {
  const lines = content.split('\n');
  const segments = []; // { type: 'prose'|'toolcalls'|'tool-result'|'snapshot', lines: [] }

  let i = 0;
  while (i < lines.length) {
    const fenceMatch = lines[i].match(FENCE_OPEN);

    if (fenceMatch) {
      const tag = fenceMatch[1];
      const blockLines = [];
      i++;
      while (i < lines.length && !lines[i].match(FENCE_CLOSE)) {
        blockLines.push(lines[i]);
        i++;
      }
      i++; // consume closing fence

      if (tag === 'tool-result') {
        segments.push({ type: 'tool-result', lines: blockLines });
      } else if (tag === 'snapshot') {
        // Parse YAML-ish key: value lines
        const props = {};
        for (const l of blockLines) {
          const m = l.match(/^(\w+):\s*(.+)$/);
          if (m) props[m[1].trim()] = m[2].trim();
        }
        segments.push({ type: 'snapshot', caption: props.caption ?? '', slug: props.slug ?? 'snap' });
      } else {
        // Some other fenced block — emit verbatim
        segments.push({ type: 'prose', lines: ['```' + tag, ...blockLines, '```'] });
      }
    } else if (lines[i].match(JSONRPC_LINE)) {
      // Collect consecutive JSON-RPC backtick lines
      const calls = [];
      while (i < lines.length && lines[i].match(JSONRPC_LINE)) {
        const m = lines[i].match(JSONRPC_LINE);
        calls.push({ raw: m[1], line: lines[i] });
        i++;
      }
      segments.push({ type: 'toolcalls', calls, rawLines: calls.map(c => c.line) });
    } else {
      // Prose
      const last = segments[segments.length - 1];
      if (last?.type === 'prose') {
        last.lines.push(lines[i]);
      } else {
        segments.push({ type: 'prose', lines: [lines[i]] });
      }
      i++;
    }
  }

  return segments;
}

// ── JSON-RPC call extractor ──────────────────────────────────────────────────

function parseCall(rawJson) {
  try {
    const obj = JSON.parse(rawJson);
    const name = obj?.params?.name;
    const args = obj?.params?.arguments ?? {};
    if (!name) return null;
    return { name, args, id: obj.id ?? null };
  } catch (_) {
    return null;
  }
}

// ── result formatter ─────────────────────────────────────────────────────────

function fmtResult(name, args, result) {
  const tick = result?.success ? '✓' : '✗';
  let summary = `${tick} ${name}`;

  if (!result?.success) {
    summary += `: ${result?.error ?? 'unknown error'}`;
    return summary;
  }

  const d = result.data ?? {};

  if (name === 'addNode') {
    summary += `: ${args.iri}`;
  } else if (name === 'addLink') {
    const sp = iri => iri?.split(/[/#]/).pop() ?? iri;
    summary += `: s=${sp(args.subjectIri)} p=${sp(args.predicateIri)} o=${sp(args.objectIri)}`;
  } else if (name === 'runLayout') {
    summary += `: ${args.algorithm}`;
  } else if (name === 'runReasoning') {
    summary += `: ${d.inferredTriples ?? '?'} triples inferred`;
  } else if (name === 'loadOntology') {
    summary += `: ${args.url ?? args.turtle ? '(inline)' : '?'}`;
    if (d.classCount != null) summary += ` — ${d.classCount} classes`;
  } else if (name === 'loadRdf') {
    summary += `: loaded`;
  } else if (name === 'exportGraph') {
    const len = d.content?.length ?? 0;
    summary += `: ${len} chars`;
  } else if (name === 'exportImage') {
    summary += `: ok`;
  } else if (name === 'getNodes') {
    let nodes;
    try { nodes = JSON.parse(d.content ?? '[]'); } catch (_) { nodes = []; }
    summary += `: ${nodes.length} result(s)`;
    if (nodes.length > 0 && nodes.length <= 4) {
      summary += ` [${nodes.map(n => n.label || n.iri.split(/[/#]/).pop()).join(', ')}]`;
    }
  } else if (d.error) {
    summary += `: error — ${d.error}`;
  }

  return summary;
}

function buildResultBlock(batch, stateAfter, { imgDir, demoName } = {}) {
  const total = batch.length;
  const ok = batch.filter(b => b.result?.success).length;
  const lines = [`[VisGraph — ${total} tool${total === 1 ? '' : 's'} ${ok === total ? '✓' : `${ok}/${total} ✓`}]`];
  for (const { name, args, result } of batch) {
    lines.push(fmtResult(name, args, result));
  }
  if (stateAfter?.success) {
    const d = stateAfter.data ?? {};
    lines.push('');
    lines.push(`Canvas: ${d.nodeCount ?? '?'} nodes, ${d.linkCount ?? '?'} links`);
  }
  const block = lines.join('\n');

  // Append full Turtle export if present
  const exportCall = batch.find(b => b.name === 'exportGraph' && b.result?.success && b.result?.data?.content);
  if (exportCall && imgDir && demoName) {
    const turtle = exportCall.result.data.content;
    const ttlFile = 'graph.ttl';
    fs.writeFileSync(path.join(imgDir, ttlFile), turtle, 'utf8');
    const rawUrl = `https://raw.githubusercontent.com/ThHanke/visgraph/main/docs/mcp-demo/${demoName}/${ttlFile}`;
    const appUrl = `https://thhanke.github.io/visgraph/?url=${encodeURIComponent(rawUrl)}`;
    return block
      + `\n\n\`\`\`turtle\n${turtle}\n\`\`\``
      + `\n\n[Open this graph in VisGraph ↗](${appUrl})`;
  }

  return block;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function run() {
  const seedContent = fs.readFileSync(seedPath, 'utf8');
  const segments = parseSeed(seedContent);

  const demoName = path.basename(outPath, '.md');
  const outDir = path.dirname(outPath);
  const imgDir = path.join(outDir, demoName);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(imgDir, { recursive: true });

  const { page, cleanup, idleMs: idle } = await startBrowser({ baseUrl, noServer, idleMs });
  let snapCount = 0;

  const outputParts = [];
  let pendingBatch = null; // calls executed but awaiting the tool-result segment

  for (const seg of segments) {
    if (seg.type === 'prose') {
      outputParts.push(seg.lines.join('\n'));

    } else if (seg.type === 'toolcalls') {
      // Execute all calls in this batch
      const batch = [];
      for (const { raw } of seg.calls) {
        const parsed = parseCall(raw);
        if (!parsed) {
          batch.push({ name: '(parse error)', args: {}, result: { success: false, error: `Could not parse: ${raw}` } });
          continue;
        }
        console.log(`→ ${parsed.name}`, JSON.stringify(parsed.args).slice(0, 120));
        const result = await callTool(page, parsed.name, parsed.args);
        batch.push({ name: parsed.name, args: parsed.args, result });
        await sleep(300);
      }
      const stateAfter = await callTool(page, 'getGraphState', {});
      pendingBatch = { batch, stateAfter };

      // Emit the original tool-call lines verbatim (keep them in the output)
      outputParts.push(seg.rawLines.join('\n'));

    } else if (seg.type === 'tool-result') {
      if (pendingBatch) {
        const { batch, stateAfter } = pendingBatch;
        pendingBatch = null;
        const content = buildResultBlock(batch, stateAfter, { imgDir, demoName });
        outputParts.push('```tool-result\n' + content + '\n```');
      } else {
        // No pending batch — copy verbatim
        outputParts.push('```tool-result\n' + seg.lines.join('\n') + '\n```');
      }

    } else if (seg.type === 'snapshot') {
      // fitCanvas, then export SVG
      await callTool(page, 'fitCanvas', {});
      await sleep(600);
      const r = await callTool(page, 'exportImage', { format: 'svg' });
      const filename = `${String(++snapCount).padStart(2, '0')}-${seg.slug}.svg`;
      if (r?.success && r.data?.content) {
        fs.writeFileSync(path.join(imgDir, filename), r.data.content, 'utf8');
        console.log(`  snapshot → ${filename}`);
        outputParts.push(`![${seg.caption}](./${demoName}/${filename})`);
      } else {
        console.warn(`  snapshot failed: ${r?.error}`);
        outputParts.push(`> ⚠ Snapshot failed: ${r?.error ?? 'unknown'}`);
      }
    }
  }

  const rendered = outputParts.join('\n');
  fs.writeFileSync(outPath, rendered, 'utf8');
  console.log(`\nWrote ${outPath} (${rendered.length} chars)`);

  await cleanup();
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
