#!/usr/bin/env node
// scripts/convert-vars-to-full-oklch.cjs
// Replace numeric OKLCH component CSS variables in src/index.css with full oklch(...) function strings.
// Also update tailwind.config.ts to reference the variable directly (var(--name)) instead of wrapping with oklch(...).
//
// Usage: node scripts/convert-vars-to-full-oklch.cjs
//
// This script creates backups: src/index.css.bak3 and tailwind.config.ts.bak

const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const cssPath = path.join(repoRoot, 'src', 'index.css');
const twPath = path.join(repoRoot, 'tailwind.config.ts');

const cssOrig = fs.readFileSync(cssPath, 'utf8');
let css = cssOrig;

// Replace variable definitions that look like: --name: L C H;
// where L is decimal (0..1), C number, H number.
// Replace with: --name: oklch(L% C H);
css = css.replace(/^(\s*)(--[a-zA-Z0-9_-]+)\s*:\s*([0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)\s*;\s*$/gm,
  (m, indent, name, lStr, cStr, hStr) => {
    // Do not touch lines already containing 'oklch('
    if (m.includes('oklch(')) return m;

    const l = parseFloat(lStr);
    const c = parseFloat(cStr);
    const h = parseFloat(hStr);

    // Format: L as percent with 1 decimal (e.g., 97.7%), C with 3 decimals, H with 3 decimals
    const lPercent = (l * 100).toFixed(1) + '%';
    const cFmt = c.toFixed(3).replace(/\.?0+$/, '');
    const hFmt = h.toFixed(3).replace(/\.?0+$/, '');

    return `${indent}${name}: oklch(${lPercent} ${cFmt} ${hFmt});`;
  });

// Replace occurrences of oklch(var(--name) / <alpha-value>) and oklch(var(--name)) with var(--name)
// This will cause usages to reference the full function string stored in the variable directly.
css = css.replace(/oklch\(\s*var\(\s*--([a-zA-Z0-9_-]+)\s*\)\s*\/\s*[^)\s]+\s*\)/g, (m, name) => {
  return `var(--${name})`;
});
css = css.replace(/oklch\(\s*var\(\s*--([a-zA-Z0-9_-]+)\s*\)\s*\)/g, (m, name) => {
  return `var(--${name})`;
});

// Write backup and file if changed
if (css !== cssOrig) {
  fs.writeFileSync(cssPath + '.bak3', cssOrig, 'utf8');
  fs.writeFileSync(cssPath, css, 'utf8');
  console.log('Updated src/index.css and wrote backup src/index.css.bak3');
} else {
  console.log('No changes to src/index.css required.');
}

// Update tailwind.config.ts mappings: replace 'oklch(var(--x) / <alpha-value>)' and 'oklch(var(--x))' with 'var(--x)'
if (fs.existsSync(twPath)) {
  const twOrig = fs.readFileSync(twPath, 'utf8');
  let tw = twOrig;
  tw = tw.replace(/oklch\(\s*var\(\s*--([a-zA-Z0-9_-]+)\s*\)\s*\/\s*<alpha-value>\s*\)/g, (m, name) => {
    return `var(--${name})`;
  });
  tw = tw.replace(/oklch\(\s*var\(\s*--([a-zA-Z0-9_-]+)\s*\)\s*\)/g, (m, name) => {
    return `var(--${name})`;
  });

  if (tw !== twOrig) {
    fs.writeFileSync(twPath + '.bak', twOrig, 'utf8');
    fs.writeFileSync(twPath, tw, 'utf8');
    console.log('Updated tailwind.config.ts and wrote backup tailwind.config.ts.bak');
  } else {
    console.log('No changes to tailwind.config.ts required.');
  }
} else {
  console.log('tailwind.config.ts not found; skipping.');
}

console.log('Conversion to full oklch strings complete. Please review and run the app to verify visual results.');
