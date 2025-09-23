/**
 * Prepare a conservative deletion candidate list from docs/unreachable_from_KnowledgeCanvas_tsx.json
 * Writes docs/candidates_delete_from_canvas.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const inPath = path.join(ROOT, 'docs', 'unreachable_from_KnowledgeCanvas_tsx.json');
const outPath = path.join(ROOT, 'docs', 'candidates_delete_from_canvas.json');

if (!fs.existsSync(inPath)) {
  console.error('Missing input:', inPath);
  process.exit(2);
}

const data = JSON.parse(fs.readFileSync(inPath, 'utf8'));
const list = Array.isArray(data.unreachable) ? data.unreachable.slice() : (Array.isArray(data) ? data : []);

const EXCLUDE_PATTERNS = [
  /(^|\/)__tests__(\/|$)/i,
  /\.test(\.|$)/i,
  /\/__tests__\//i,
  /(^|\/)tests?(\/|$)/i,
  /(^|\/)public(\/|$)/i,
  /(^|\/)docs(\/|$)/i,
  /(^|\/)scripts(\/|$)/i,
  /(^|\/)playwright-reports(\/|$)/i,
  /(^|\/)reports(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /\.d\.ts$/i,
  /(^|\/)test-setup(\.|\/|$)/i,
  /(^|\/)index\.(html|tsx?|js)$/i,
  /(^|\/)pages(\/|$)/i, // conservative: keep pages
  /(^|\/)public(\/|$)/i,
];

function isExcluded(p) {
  for (const re of EXCLUDE_PATTERNS) {
    if (re.test(p)) return true;
  }
  // exclude non-source folders
  if (!p.startsWith('src/')) return true;
  return false;
}

const candidates = [];
for (const p of list) {
  try {
    if (typeof p !== 'string') continue;
    const rel = p.replace(/^\.\//, '');
    if (isExcluded(rel)) continue;
    // only consider source files with typical extensions
    if (!/\.(ts|tsx|js|jsx)$/.test(rel)) continue;
    const abs = path.join(ROOT, rel);
    // ensure file exists before proposing deletion
    if (!fs.existsSync(abs)) continue;
    // Conservative extra checks: skip files that export from index barrel (heuristic)
    const content = fs.readFileSync(abs, 'utf8');
    if (/export\s+\*\s+from\s+['"]/.test(content) || (/export\s+{/.test(content) && /from\s+['"]/.test(content))) {
      // don't auto-delete barrel-like files
      continue;
    }
    candidates.push(rel);
  } catch (e) {
    // ignore per-file errors
  }
}

// Sort and dedupe
const uniq = Array.from(new Set(candidates)).sort();

const out = {
  generatedAt: new Date().toISOString(),
  source: 'docs/unreachable_from_KnowledgeCanvas_tsx.json',
  totalUnreachable: Array.isArray(list) ? list.length : 0,
  candidatesCount: uniq.length,
  notes: [
    'Conservative candidates: excludes tests, pages, public, docs, scripts, .d.ts, and barrel-like files.',
    'Manual review required before any file movement or deletion.',
    'This list is intentionally conservative to avoid false positives.'
  ],
  candidates: uniq
};

fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
console.log('Wrote', outPath, 'candidates:', uniq.length);
