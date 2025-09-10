/**
 * scripts/fix-empty-catches.js
 *
 * Finds empty catch blocks of the form:
 *   catch (e) { }
 *
 * and replaces them with a safe guarded call to fallback(...):
 *   catch (e) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(e) }); } } catch (_) {} }
 *
 * Creates a .bak file next to each modified file.
 *
 * Usage: node scripts/fix-empty-catches.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function getTrackedSourceFiles() {
  const out = execSync(
    `git ls-files 'src/**/*' | grep -E '\\.ts$|\\.tsx$|\\.js$|\\.jsx$' || true`,
    { encoding: 'utf8' }
  );
  return out
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

function fixFile(file) {
  const src = fs.readFileSync(file, 'utf8');

  // Match: catch (<anything except )>) { }  — non-greedy group for the parens content
  // The 's' flag allows '.' to match newlines so we can robustly match whitespace
  const re = /catch\s*\(\s*([^\)]*?)\s*\)\s*\{\s*\}/gs;

  let replaced = 0;
  const newSrc = src.replace(re, (match, p1) => {
    replaced++;
    // p1 is the catch binding, e.g. e or err
    const binding = p1.trim() || 'e';
    // Construct replacement preserving formatting as much as practical
    return `catch (${binding}) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(${binding}) }); } } catch (_) {} }`;
  });

  if (replaced > 0 && newSrc !== src) {
    // backup original
    fs.writeFileSync(file + '.bak', src, 'utf8');
    fs.writeFileSync(file, newSrc, 'utf8');
  }

  return replaced;
}

function main() {
  const files = getTrackedSourceFiles();
  let total = 0;
  const modified = [];

  for (const f of files) {
    try {
      const count = fixFile(f);
      if (count > 0) {
        modified.push({ file: f, count });
        total += count;
      }
    } catch (err) {
      console.error('Error processing', f, err);
    }
  }

  console.log(`Processed ${files.length} files.`);
  console.log(`Modified ${modified.length} files, applied ${total} replacements.`);
  if (modified.length > 0) {
    for (const m of modified) {
      console.log(` - ${m.file}: ${m.count}`);
    }
  }
}

main();
