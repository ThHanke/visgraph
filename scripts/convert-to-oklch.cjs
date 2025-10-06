#!/usr/bin/env node
// scripts/convert-to-oklch.cjs
// Convert HSL/HSLA/hex/rgb color usages in src/index.css and tailwind.config.ts
// into OKLCH numeric component variables and oklch(...) usages.
//
// Usage: node scripts/convert-to-oklch.cjs
//
// Notes:
// - Requires `culori` (already added as a dev dependency by the tooling step).
// - This script creates .bak backups of any files it overwrites.

const fs = require('fs');
const path = require('path');
const culori = require('culori');

// Helpers
function safeParseColor(str) {
  try {
    // culori.parse accepts hsl(...), hsla(...), rgb(...), hex, etc.
    const c = culori.parse(str);
    if (!c) return null;
    const ok = culori.oklch(c);
    if (!ok || typeof ok.l !== 'number' || Number.isNaN(ok.l)) return null;
    return ok;
  } catch (e) {
    return null;
  }
}

function formatOklch(ok) {
  // L: 0..1, C: number, H: degrees
  const l = Number(ok.l || 0);
  const c = Number(ok.c || 0);
  const h = Number(ok.h || 0);
  // Use concise decimals
  return `${l.toFixed(4)} ${c.toFixed(4)} ${h.toFixed(1)}`;
}

function convertHslaMatch(match) {
  // match is like "hsla(215, 25%, 27%, 0.1)" or "hsl(215 25% 27%)"
  // We want to convert to "oklch(L C H / alpha)" or "oklch(L C H)" if no alpha.
  const parsedOK = safeParseColor(match);
  if (!parsedOK) {
    return match;
  }

  // extract alpha if present
  const alphaMatch = match.match(/hsla?\([^)]*[,\/]\s*([0-9.]+)\s*\)/i);
  const alpha = alphaMatch ? alphaMatch[1] : null;

  if (alpha !== null) {
    return `oklch(${formatOklch(parsedOK)} / ${alpha})`;
  } else {
    return `oklch(${formatOklch(parsedOK)})`;
  }
}

function convertCssVariables(content) {
  // Convert variables with "H S% L%" RHS to "L C H" numeric OKLCH components.
  // Match lines like: --background: 210 20% 98%;
  // Also handle cases where value has trailing comment/spaces.
  return content.replace(/(--[a-zA-Z0-9_-]+)\s*:\s*([0-9]+(?:\.[0-9]+)?)\s+([0-9]+(?:\.[0-9]+)?)%\s+([0-9]+(?:\.[0-9]+)?)%\s*;/g,
    (m, name, h, s, l) => {
      const hslString = `hsl(${h} ${s}% ${l}%)`;
      const ok = safeParseColor(hslString);
      if (!ok) {
        console.warn('Failed to parse HSL for', name, hslString);
        return m;
      }
      const formatted = formatOklch(ok);
      return `${name}: ${formatted};`;
    });
}

function convertInlineHsla(content) {
  // Convert any hsla(...) or hsl(...) occurrences to oklch(...)
  return content.replace(/hsla?\([^)]*\)/gi, (m) => convertHslaMatch(m));
}

function replaceHslVarUsage(content) {
  // Replace hsl(var(--foo) / <alpha>) and hsl(var(--foo)) usages with oklch(var(--foo) / <alpha>) etc.
  // This is a simple text replacement for the common pattern.
  return content.replace(/hsl\(\s*var\(\s*--([a-zA-Z0-9_-]+)\s*\)\s*(?:\/\s*<alpha-value>\s*)?\)/g, (m) => {
    // keep the inner var(...) exactly but swap hsl -> oklch
    return m.replace(/^hsl/, 'oklch');
  }).replace(/hsl\(\s*var\(\s*--([a-zA-Z0-9_-]+)\s*\)\s*\/\s*<alpha-value>\s*\)/g, (m) => {
    return m.replace(/^hsl/, 'oklch');
  }).replace(/hsl\(\s*var\(\s*--([a-zA-Z0-9_-]+)\s*\)\s*\/\s*var\(--tw-[^)]*\)\s*\)/g, (m) => {
    return m.replace(/^hsl/, 'oklch');
  });
}

function processFile(filePath, transformFn) {
  const original = fs.readFileSync(filePath, 'utf8');
  const backupPath = filePath + '.bak';
  fs.writeFileSync(backupPath, original, 'utf8');
  const transformed = transformFn(original);
  if (transformed !== original) {
    fs.writeFileSync(filePath, transformed, 'utf8');
    console.log('Updated:', filePath);
    return true;
  } else {
    console.log('No changes for:', filePath);
    return false;
  }
}

// Main conversion flow
(function main() {
  const repoRoot = path.join(__dirname, '..');
  const cssPath = path.join(repoRoot, 'src', 'index.css');
  const tailwindPath = path.join(repoRoot, 'tailwind.config.ts');

  // 1) Convert CSS variable H S% L% definitions to OKLCH numeric triplets
  processFile(cssPath, (content) => {
    // 1a: convert variable H S% L% tokens
    let out = convertCssVariables(content);

    // 1b: convert inline hsla(...) / hsl(...) occurrences to oklch(...)
    out = convertInlineHsla(out);

    // 1c: replace uses of hsl(var(--...)) to oklch(var(--...))
    out = out.replace(/hsl\(\s*var\(\s*--([^)]+)\)\s*(\/\s*<alpha-value>\s*)?\)/g, (m) => {
      return m.replace(/^hsl/, 'oklch');
    });

    // Also replace `hsl(var(--x) / var(--tw-...))` patterns
    out = out.replace(/hsl\(\s*var\(\s*--([^)]+)\)\s*\/\s*([^)]+)\)/g, (m) => {
      return m.replace(/^hsl/, 'oklch');
    });

    return out;
  });

  // 2) Update tailwind.config.ts to use oklch(var(...)) instead of hsl(...)
  processFile(tailwindPath, (content) => {
    // Simple replacement of hsl(var(--...)/<alpha-value>) -> oklch(var(--...)/<alpha-value>)
    let out = content.replace(/hsl\(\s*var\(\s*--([^)]+)\)\s*\/\s*<alpha-value>\s*\)/g, (m) => {
      return m.replace(/^hsl/, 'oklch');
    });

    // Also handle hsl(var(--...))
    out = out.replace(/hsl\(\s*var\(\s*--([^)]+)\)\s*\)/g, (m) => {
      return m.replace(/^hsl/, 'oklch');
    });

    return out;
  });

  // 3) Done
  console.log('\\nConversion complete. Backups written with .bak suffix for modified files.');
  console.log('Please review changes, run the app, and verify visual/contrast results.');
})();
