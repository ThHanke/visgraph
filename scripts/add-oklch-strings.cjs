#!/usr/bin/env node
// scripts/add-oklch-strings.cjs
// Read src/index.css and, for any CSS variable defined as "L C H;" (numeric components),
// add a companion variable "--name-oklch: oklch(L% C H);" immediately after the definition,
// unless that companion already exists.
//
// Example:
//   --background: 0.9843 0.0017 247.8;
// =>
//   --background: 0.9843 0.0017 247.8;
//   --background-oklch: oklch(98.43% 0.0017 247.8);
//
// This keeps numeric components for alpha-friendly usage and also provides a copyable
// human-friendly oklch(...) string for designers/developers.

const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'src', 'index.css');
const original = fs.readFileSync(filePath, 'utf8');

let out = original;

// Match CSS variable lines with three numeric components: --name: L C H;
const varRegex = /^(\s*)(--[a-zA-Z0-9_-]+)\s*:\s*([0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)\s+([0-9]*\.?[0-9]+)\s*;\s*$/gm;

out = out.replace(varRegex, (full, indent, name, lStr, cStr, hStr) => {
  // Skip companion variable names (don't create --foo-oklch for those)
  if (name.endsWith('-oklch')) return full;

  const companionName = `${name}-oklch`;
  // If companion already exists somewhere after this position, skip adding
  // (simple check: if the file contains companionName at all)
  if (out.includes(companionName)) {
    return full;
  }

  const l = parseFloat(lStr);
  // Format L as percentage with 2 decimal places
  const lPercent = (l * 100).toFixed(2) + '%';
  // Keep C and H as in original but format C with up to 4 decimals and H with 1 decimal
  const cVal = Number(cStr).toFixed(4).replace(/\.?0+$/, '');
  const hVal = Number(hStr).toFixed(1).replace(/\.0$/, '');

  const oklchValue = `oklch(${lPercent} ${cVal} ${hVal})`;

  // Insert companion line after the variable
  return `${full}\n${indent}${companionName}: ${oklchValue};`;
});

if (out === original) {
  console.log('No changes required; companion oklch variables already present or no numeric vars found.');
} else {
  // backup and write
  fs.writeFileSync(filePath + '.bak2', original, 'utf8');
  fs.writeFileSync(filePath, out, 'utf8');
  console.log('Updated src/index.css with companion --*-oklch variables. Backup written to src/index.css.bak2');
}
