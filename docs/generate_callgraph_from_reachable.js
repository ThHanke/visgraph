/*
  Generates a conservative import-level call graph for files listed in
  docs/reachable_from_KnowledgeCanvas_tsx.json and writes docs/callgraph_knowledgecanvas.json
*/
const fs = require('fs');
const path = require('path');
const ROOT = process.cwd();
const SRC = path.join(ROOT, 'src');
const reachablePath = path.join(ROOT, 'docs', 'reachable_from_KnowledgeCanvas_tsx.json');
if (!fs.existsSync(reachablePath)) {
  console.error('Missing reachable file:', reachablePath);
  process.exit(2);
}
const reach = JSON.parse(fs.readFileSync(reachablePath, 'utf8'));
const reachable = (reach.reachable || []).map((p) => path.resolve(p));
const fileSet = new Set(reachable.map((p) => path.resolve(p)));

// helpers
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.d.ts', ''];

function extractSpecifiers(content) {
  const specs = new Set();
  let m;
  const importRe = /import[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  while ((m = importRe.exec(content))) specs.add(m[1]);
  const dynRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = dynRe.exec(content))) specs.add(m[1]);
  const reqRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reqRe.exec(content))) specs.add(m[1]);
  const expRe = /export\s+[\s\S]*?from\s*['"]([^'"]+)['"]/g;
  while ((m = expRe.exec(content))) specs.add(m[1]);
  return Array.from(specs);
}

function resolvePathVariants(base) {
  for (const ext of EXTS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.resolve(candidate);
  }
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

function resolveSpecifier(spec, baseFile) {
  try {
    if (!spec) return null;
    if (spec.startsWith('@/')) {
      const rel = spec.slice(2);
      const candidateBase = path.join(SRC, rel);
      return resolvePathVariants(candidateBase);
    }
    if (spec.startsWith('/')) {
      const candidateBase = path.join(ROOT, spec);
      return resolvePathVariants(candidateBase);
    }
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const candidateBase = path.resolve(path.dirname(baseFile), spec);
      return resolvePathVariants(candidateBase);
    }
    // heuristic: try resolving bare spec relative to src
    const heuristic = path.join(SRC, spec);
    const hr = resolvePathVariants(heuristic);
    if (hr) return hr;
    return null;
  } catch (e) {
    return null;
  }
}

// Build edges
const edges = [];
const nodes = reachable.map((f) => path.relative(ROOT, f)).sort();

for (const f of reachable) {
  let content = '';
  try { content = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  const specs = extractSpecifiers(content);
  for (const s of specs) {
    const resolved = resolveSpecifier(s, f);
    if (!resolved) continue;
    // only include edges to reachable files
    if (!fileSet.has(resolved)) continue;
    edges.push({
      from: path.relative(ROOT, f),
      to: path.relative(ROOT, resolved),
      specifier: s
    });
  }
}

// Deduplicate edges
const uniq = [];
const seen = new Set();
for (const e of edges) {
  const k = `${e.from} -> ${e.to} (${e.specifier})`;
  if (!seen.has(k)) {
    seen.add(k);
    uniq.push(e);
  }
}

// Write output
const out = {
  entry: reach.entry || 'src/components/Canvas/KnowledgeCanvas.tsx',
  nodes,
  edges: uniq
};
fs.writeFileSync(path.join(ROOT, 'docs', 'callgraph_knowledgecanvas.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('Wrote docs/callgraph_knowledgecanvas.json');
