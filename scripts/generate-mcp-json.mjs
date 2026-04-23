#!/usr/bin/env node
// Regenerate public/.well-known/mcp.json from src/mcp/manifest.ts
// Run: node scripts/generate-mcp-json.mjs
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Extract manifest via tsx/esbuild — simpler: parse the TS source with regex-free approach
// Use esbuild to transpile manifest.ts and eval it
import { transform } from 'esbuild';

const src = readFileSync(resolve(root, 'src/mcp/manifest.ts'), 'utf8');
// Strip type-only imports/exports
const { code } = await transform(src, { loader: 'ts', format: 'esm', target: 'node18' });

// Write to temp, import it
import { writeFileSync as wfs, unlinkSync } from 'fs';
import { createRequire } from 'module';

const tmp = resolve(root, 'scripts/_manifest_tmp.mjs');
wfs(tmp, code);

let manifest, serverName, serverDescription;
try {
  const mod = await import(tmp + '?t=' + Date.now());
  manifest = mod.mcpManifest;
  serverName = mod.mcpServerName;
  serverDescription = mod.mcpServerDescription;
} finally {
  try { unlinkSync(tmp); } catch {}
}

const out = {
  name: serverName,
  description: serverDescription,
  tools: manifest,
};

const dest = resolve(root, 'public/.well-known/mcp.json');
writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
console.log(`Written ${manifest.length} tools to public/.well-known/mcp.json`);
