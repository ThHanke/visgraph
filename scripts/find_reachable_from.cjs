#!/usr/bin/env node
// scripts/find_reachable_from.cjs
// Conservative static import graph resolver (regex-based) to compute reachable files
// Usage: node scripts/find_reachable_from.cjs <entry-file>
// Writes docs/reachable_from_<basename>.json and docs/unreachable_from_<basename>.json

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const OUT_DIR = path.join(ROOT, 'docs');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const entry = process.argv[2];
if (!entry) {
  console.error('Usage: node scripts/find_reachable_from.cjs <entry-file (relative to project root)>');
  process.exit(2);
}
const ENTRY = path.resolve(ROOT, entry);

// file extensions to try
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.d.ts', ''];

// walk src and collect candidate files
function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files = files.concat(walkDir(full));
    else if (e.isFile()) {
      if (/\.(ts|tsx|js|jsx)$/.test(e.name) && !/node_modules/.test(full)) files.push(full);
    }
  }
  return files;
}

const allFiles = walkDir(SRC).map((f) => path.resolve(f));
const fileSet = new Set(allFiles);

// read file and extract import/require specifiers
function extractSpecifiers(fileContent) {
  const specs = new Set();
  // import ... from '...'
  const importRe = /import[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = importRe.exec(fileContent))) specs.add(m[1]);
  // import('...') dynamic
  const dynRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(fileContent))) specs.add(m[1]);
  // require('...')
  const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reqRe.exec(fileContent))) specs.add(m[1]);
  // export * from '...'
  const expRe = /export\s+[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  while ((m = expRe.exec(fileContent))) specs.add(m[1]);
  return Array.from(specs);
}

// resolve specifier to a file path (conservative)
function resolveSpecifier(spec, baseFile) {
  try {
    if (!spec) return null;
    // Treat '@/...' as src/...
    if (spec.startsWith('@/')) {
      const rel = spec.slice(2);
      const candidateBase = path.join(SRC, rel);
      return resolvePathVariants(candidateBase);
    }
    // Absolute-ish starting with '/': treat as project-root relative
    if (spec.startsWith('/')) {
      const candidateBase = path.join(ROOT, spec);
      return resolvePathVariants(candidateBase);
    }
    // Relative imports
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const candidateBase = path.resolve(path.dirname(baseFile), spec);
      return resolvePathVariants(candidateBase);
    }
    // Bare imports (library or aliased). Try to detect a project-local alias "src/..." when package.json or vite uses alias; we conservatively skip most bare imports
    // Heuristic: some code uses 'components/...' or 'utils/...' without '@/'. Try resolving relative to src.
    const heuristic = path.join(SRC, spec);
    const hr = resolvePathVariants(heuristic);
    if (hr) return hr;
    // Otherwise treat as external and skip
    return null;
  } catch (e) {
    return null;
  }
}

function resolvePathVariants(base) {
  // If base already points to a file that exists, use it
  for (const ext of EXTS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.resolve(candidate);
  }
  // If base is a directory, try index.* files
  try {
    if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      for (const ext of EXTS) {
        const idx = path.join(base, 'index' + ext);
        if (fs.existsSync(idx) && fs.statSync(idx).isFile()) return path.resolve(idx);
      }
    }
  } catch (_) {}
  return null;
}

// build adjacency map
const adjacency = new Map(); // file -> Set(resolvedFile)
for (const file of allFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const specs = extractSpecifiers(content);
  const resolved = new Set();
  for (const s of specs) {
    const r = resolveSpecifier(s, file);
    if (r && fileSet.has(r)) resolved.add(r);
  }
  adjacency.set(path.resolve(file), resolved);
}

// BFS from ENTRY
const reachable = new Set();
const queue = [];
if (!fs.existsSync(ENTRY)) {
  console.error('Entry file not found:', ENTRY);
  process.exit(3);
}
queue.push(path.resolve(ENTRY));
while (queue.length > 0) {
  const cur = queue.shift();
  if (reachable.has(cur)) continue;
  reachable.add(cur);
  const neigh = adjacency.get(cur) || new Set();
  for (const n of neigh) {
    if (!reachable.has(n)) queue.push(n);
  }
}

// compute unreachable (within src)
const reachableArr = Array.from(reachable).sort();
const allArr = allFiles.slice().sort();
const unreachable = allArr.filter((f) => !reachable.has(f));

// write outputs (paths relative to ROOT)
const basename = path.basename(entry).replace(/\W+/g, '_');
const outReach = path.join(OUT_DIR, `reachable_from_${basename}.json`);
const outUnreach = path.join(OUT_DIR, `unreachable_from_${basename}.json`);
fs.writeFileSync(outReach, JSON.stringify({ entry: path.relative(ROOT, ENTRY), reachable: reachableArr.map(p => path.relative(ROOT, p)).sort() }, null, 2), 'utf8');
fs.writeFileSync(outUnreach, JSON.stringify({ entry: path.relative(ROOT, ENTRY), unreachable: unreachable.map(p => path.relative(ROOT, p)).sort() }, null, 2), 'utf8');

console.log('Wrote', outReach);
console.log('Wrote', outUnreach);
