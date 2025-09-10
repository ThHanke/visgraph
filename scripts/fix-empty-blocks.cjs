/**
 * scripts/fix-empty-blocks.cjs
 *
 * Find empty block statements in non-test source files and replace them with
 * a short comment "{ empty }" to satisfy ESLint `no-empty`.
 *
 * Conservative matching: only targets block statements preceded by:
 *  - a keyword (if, else, for, while, do, try, finally)
 *  - a closing parenthesis `)` (covers function bodies, catch, etc.)
 *
 * This avoids changing object literals like `const x = {};`.
 *
 * Usage: node scripts/fix-empty-blocks.cjs
 */

const { execSync } = require('child_process');
const fs = require('fs');

function getTrackedSourceFiles() {
  const out = execSync(
    `git ls-files 'src/**/*' | grep -E '\\.ts$|\\.tsx$|\\.js$|\\.jsx$' | grep -v '/__tests__/' || true`,
    { encoding: 'utf8' }
  );
  return out
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);
}

function fixFile(file) {
  const src = fs.readFileSync(file, 'utf8');

  // Patterns to conservatively match empty block statements (non-greedy).
  // We capture the leading token (keyword or ')') so we can preserve spacing.
  const patterns = [
    // keyword { }
    {
      re: /(\b(?:if|else|for|while|do|try|finally|switch)\b\s*(?:\([^\)]*\)\s*)?)\{\s*\}/g,
      replace: (m, p1) => `${p1}{ /* empty */ }`
    },
    // closing paren ) { }
    {
      re: /(\)\s*)\{\s*\}/g,
      replace: (m, p1) => `${p1}{ /* empty */ }`
    }
  ];

  let newSrc = src;
  let totalReplacements = 0;
  for (const p of patterns) {
    newSrc = newSrc.replace(p.re, (match, ...groups) => {
      totalReplacements++;
      return p.replace(match, groups[0]);
    });
  }

  if (totalReplacements > 0 && newSrc !== src) {
    fs.writeFileSync(file + '.bak', src, 'utf8');
    fs.writeFileSync(file, newSrc, 'utf8');
  }

  return totalReplacements;
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
