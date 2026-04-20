#!/usr/bin/env node
/**
 * remove_noop_catches.js
 *
 * Scans files under ./src and removes try/catch blocks where the catch block
 * is a no-op (only comments/whitespace or trivial noop statements).
 *
 * Behavior:
 * - For "try { ... } catch (...) { (noop) }" (no finally) the script
 *   replaces the whole try/catch with a plain block containing the try body:
 *     { ... }
 *
 * - For "try { ... } catch (...) { (noop) } finally { ... }" the script
 *   removes the catch clause but keeps try/finally:
 *     try { ... } finally { ... }
 *
 * - The script edits .js, .jsx, .ts, .tsx files under ./src recursively.
 *
 * Safety notes:
 *  - By default the script runs in dry-run mode and will only print what it
 *    would change. To actually apply modifications pass --apply on the
 *    command line.
 *  - You can still run with --dry to force dry-run explicitly (same behavior).
 *  - Review diffs after running and commit or revert with your VCS as needed.
 *
 * Usage:
 *   node scripts/remove_noop_catches.js            # dry-run (default)
 *   node scripts/remove_noop_catches.js --dry     # dry-run
 *   node scripts/remove_noop_catches.js --apply   # apply changes to files
 *
 * Note: This uses a character scanner to find matching braces and attempts to
 * be careful around strings and comments. It is moderately robust but not a
 * full JS/TS parser — review diffs/changes after running.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(process.cwd(), "src");
const FORCE_APPLY = process.argv.includes("--apply");
const DRY = process.argv.includes("--dry") || process.argv.includes("-d") || !FORCE_APPLY;
const FILE_EXTS = [".ts", ".tsx", ".js", ".jsx"];

function isCodeChar(c) {
  return c && c.length === 1;
}

function readFiles(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...readFiles(p));
    } else if (e.isFile() && FILE_EXTS.includes(path.extname(e.name))) {
      out.push(p);
    }
  }
  return out;
}

// Scans forward from startIndex (index of opening '{') to find its matching '}'.
// Skips over string literals and comments.
function findMatchingBrace(src, startIndex) {
  let i = startIndex;
  const len = src.length;
  if (src[i] !== "{") return -1;
  let depth = 0;
  let state = null; // null | 'single' | 'double' | 'template' | 'block_comment' | 'line_comment'
  while (i < len) {
    const ch = src[i];
    const next = src[i + 1];
    if (state === "single") {
      if (ch === "\\" && i + 1 < len) {
        i += 2;
        continue;
      }
      if (ch === "'") state = null;
      i++;
      continue;
    } else if (state === "double") {
      if (ch === "\\" && i + 1 < len) {
        i += 2;
        continue;
      }
      if (ch === '"') state = null;
      i++;
      continue;
    } else if (state === "template") {
      if (ch === "`") {
        state = null;
        i++;
        continue;
      }
      if (ch === "\\" && i + 1 < len) {
        i += 2;
        continue;
      }
      i++;
      continue;
    } else if (state === "block_comment") {
      if (ch === "*" && next === "/") {
        state = null;
        i += 2;
        continue;
      }
      i++;
      continue;
    } else if (state === "line_comment") {
      if (ch === "\n" || ch === "\r") {
        state = null;
      }
      i++;
      continue;
    } else {
      if (ch === "'") {
        state = "single";
        i++;
        continue;
      }
      if (ch === '"') {
        state = "double";
        i++;
        continue;
      }
      if (ch === "`") {
        state = "template";
        i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block_comment";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "/") {
        state = "line_comment";
        i += 2;
        continue;
      }
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) return i;
      }
      i++;
    }
  }
  return -1;
}

// Remove comments (block and line) to inspect content for noop detection
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/\/\/.*$/gm, ""); // line comments
}

// Determine if catch body is a no-op
function isNoopCatch(body) {
  // body is the text inside the braces, not including the surrounding braces
  // Remove comments first so we only inspect executable tokens.
  const stripped = stripComments(body).trim();

  // Empty after removing comments -> noop
  if (stripped === "") return true;

  // If the body is only semicolons (e.g. `;` or `;;`) treat as noop
  if (/^;+$/.test(stripped)) return true;

  // Common trivial no-op statements we want to recognize:
  // - void 0;
  // - return;
  // - return void 0;
  // - return undefined;
  // - return null;
  // - return void 0 /* maybe no semicolon */
  // Allow optional leading/trailing semicolons and whitespace.
  const noopPatterns = [
    /^;*\s*void\s+0\s*;*$/i,
    /^;*\s*return\s*;*$/i,
    /^;*\s*return\s+void\s+0\s*;*$/i,
    /^;*\s*return\s+undefined\s*;*$/i,
    /^;*\s*return\s+null\s*;*$/i,
    // allow expressions like `;` or `;;` or a single call to `void 0` without semicolon
    /^;*\s*void\s+0\s*$/i,
    /^;*\s*return\s*$/i,
  ];

  for (const re of noopPatterns) {
    if (re.test(stripped)) return true;
  }

  // Also consider trivial single-expression sequences that are effectively no-ops,
  // such as `;` or a single literal/expression followed by optional semicolons.
  // Be conservative: if the remaining token is a simple literal like `undefined` or `null`
  // or a lone numeric literal, treat as noop.
  if (/^(?:undefined|null|\d+|\bNaN\b|\bInfinity\b)\s*;*$/.test(stripped)) return true;

  return false;
}

// Find the index of the next occurrence of the token (e.g., 'try') starting at pos
function indexOfToken(src, token, pos) {
  let i = pos || 0;
  const len = src.length;
  while (i < len) {
    const idx = src.indexOf(token, i);
    if (idx === -1) return -1;
    // ensure token is not part of an identifier (check char before and after)
    const before = src[idx - 1];
    const after = src[idx + token.length];
    const isWordCharBefore = before && /[A-Za-z0-9_$]/.test(before);
    const isWordCharAfter = after && /[A-Za-z0-9_$]/.test(after);
    if (!isWordCharBefore && !isWordCharAfter) return idx;
    i = idx + token.length;
  }
  return -1;
}

function processFile(filePath) {
  let src = fs.readFileSync(filePath, "utf8");
  const original = src;
  const changes = [];
  let pos = 0;
  while (true) {
    const tryIdx = indexOfToken(src, "try", pos);
    if (tryIdx === -1) break;
    // Ensure 'try' is followed by optional whitespace/comments then '{'
    // Scan forward to find next non-space/comment char
    let j = tryIdx + 3;
    // skip whitespace/comments similarly to our brace finder state machine
    let state = null;
    const len = src.length;
    let foundOpen = -1;
    while (j < len) {
      const ch = src[j];
      const next = src[j + 1];
      if (state === "block_comment") {
        if (ch === "*" && next === "/") {
          state = null;
          j += 2;
          continue;
        }
        j++;
        continue;
      } else if (state === "line_comment") {
        if (ch === "\n" || ch === "\r") {
          state = null;
        }
        j++;
        continue;
      } else {
        if (ch === "/" && next === "*") {
          state = "block_comment";
          j += 2;
          continue;
        }
        if (ch === "/" && next === "/") {
          state = "line_comment";
          j += 2;
          continue;
        }
        if (/\s/.test(ch)) {
          j++;
          continue;
        }
        if (ch === "{") {
          foundOpen = j;
        }
        break;
      }
    }
    if (foundOpen === -1) {
      // not a standard try { ... } sequence - skip this 'try'
      pos = tryIdx + 3;
      continue;
    }
    const tryOpen = foundOpen;
    const tryClose = findMatchingBrace(src, tryOpen);
    if (tryClose === -1) {
      pos = tryIdx + 3;
      continue;
    }
    // After tryClose, skip whitespace/comments to find 'catch' or 'finally'
    let k = tryClose + 1;
    // skip spaces/comments
    let skipping = true;
    while (k < src.length && skipping) {
      const ch = src[k];
      const next = src[k + 1];
      if (ch === "/" && next === "*") {
        // skip block comment
        const end = src.indexOf("*/", k + 2);
        k = end === -1 ? src.length : end + 2;
        continue;
      }
      if (ch === "/" && next === "/") {
        // line comment
        const end = src.indexOf("\n", k + 2);
        k = end === -1 ? src.length : end + 1;
        continue;
      }
      if (/\s/.test(ch)) {
        k++;
        continue;
      }
      skipping = false;
    }
    const nextToken = src.slice(k, k + 7); // either 'catch ' or 'finally'
    if (nextToken.startsWith("catch")) {
      // find catch open brace
      // catch may be like: catch (e) { or catch {  (optional param)
      let catchStart = k;
      // find '{' after catch keyword
      let m = k + 5;
      // find next '{'
      while (m < src.length) {
        const ch = src[m];
        const next = src[m + 1];
        if (ch === "/" && next === "*") {
          const end = src.indexOf("*/", m + 2);
          m = end === -1 ? src.length : end + 2;
          continue;
        }
        if (ch === "/" && next === "/") {
          const end = src.indexOf("\n", m + 2);
          m = end === -1 ? src.length : end + 1;
          continue;
        }
        if (ch === "{") break;
        m++;
      }
      if (m >= src.length) {
        pos = tryIdx + 3;
        continue;
      }
      const catchOpen = m;
      const catchClose = findMatchingBrace(src, catchOpen);
      if (catchClose === -1) {
        pos = tryIdx + 3;
        continue;
      }
      // Check for finally after catch
      let n = catchClose + 1;
      // skip whitespace/comments
      while (n < src.length) {
        const ch = src[n];
        const next = src[n + 1];
        if (ch === "/" && next === "*") {
          const end = src.indexOf("*/", n + 2);
          n = end === -1 ? src.length : end + 2;
          continue;
        }
        if (ch === "/" && next === "/") {
          const end = src.indexOf("\n", n + 2);
          n = end === -1 ? src.length : end + 1;
          continue;
        }
        if (/\s/.test(ch)) {
          n++;
          continue;
        }
        break;
      }
      let finallyOpen = -1;
      let finallyClose = -1;
      if (src.slice(n, n + 7).startsWith("finally")) {
        // find '{' after finally
        let f = n + 7;
        while (f < src.length && src[f] !== "{") {
          f++;
        }
        if (f < src.length && src[f] === "{") {
          finallyOpen = f;
          finallyClose = findMatchingBrace(src, finallyOpen);
        }
      }

      const catchBody = src.slice(catchOpen + 1, catchClose);
      if (isNoopCatch(catchBody)) {
        // We should remove catch clause.
        // If finally exists, convert try {A} catch(...) {noop} finally {F} => try {A} finally {F}
        // If no finally, replace whole try/catch with a plain block { A }
        if (finallyOpen !== -1 && finallyClose !== -1) {
          // remove the catch clause between end of tryClose+1 up to finallyOpen (exclusive)
          const before = src.slice(0, tryClose + 1);
          const after = src.slice(finallyOpen);
          const newSrc = before + after;
          changes.push({
            type: "remove-catch-keep-finally",
            start: tryClose + 1,
            end: finallyOpen,
            before: src.slice(tryClose + 1, finallyOpen),
          });
          src = newSrc;
          pos = tryClose + 1; // continue after the tryClose (which is now before finally)
          continue;
        } else {
          // No finally => replace "try {A} catch(...) {noop}" with "{A}"
          // that is, take the try body and wrap with braces (already braces exist). We'll replace from tryIdx to catchClose inclusive with the try block content with braces.
          const tryBodyWithBraces = src.slice(tryOpen, tryClose + 1); // includes braces
          // We'll keep the braces but remove the 'try' keyword before them.
          // Replace src[tryIdx .. catchClose] with tryBodyWithBraces
          const before = src.slice(0, tryIdx);
          const after = src.slice(catchClose + 1);
          const newSrc = before + tryBodyWithBraces + after;
          changes.push({
            type: "remove-catch-remove-try",
            start: tryIdx,
            end: catchClose,
            before: src.slice(tryIdx, catchClose + 1),
            afterReplacement: tryBodyWithBraces,
          });
          src = newSrc;
          pos = tryIdx + tryBodyWithBraces.length;
          continue;
        }
      } else {
        // catch is not noop; skip this try
        pos = catchClose + 1;
        continue;
      }
    } else {
      // not a catch after try - skip
      pos = tryIdx + 3;
      continue;
    }
  } // while

  // Third pass: remove empty `else { }` and empty `finally { }` clauses.
  // This is conservative: it only removes the keyword + empty block, leaving the rest intact.
  try {
    let scanPos2 = 0;
    while (true) {
      const elseIdx = indexOfToken(src, "else", scanPos2);
      const finallyIdx = indexOfToken(src, "finally", scanPos2);
      let idx = -1;
      let kind = null;
      if (elseIdx !== -1 && (finallyIdx === -1 || elseIdx < finallyIdx)) {
        idx = elseIdx;
        kind = "else";
      } else if (finallyIdx !== -1) {
        idx = finallyIdx;
        kind = "finally";
      }
      if (idx === -1) break;
      // find next non-space/comment char after the token
      let p = idx + (kind === "else" ? 4 : 7);
      const len = src.length;
      // skip whitespace/comments
      let skipping = true;
      while (p < len && skipping) {
        const ch = src[p];
        const next = src[p + 1];
        if (ch === "/" && next === "*") {
          const end = src.indexOf("*/", p + 2);
          p = end === -1 ? len : end + 2;
          continue;
        }
        if (ch === "/" && next === "/") {
          const end = src.indexOf("\n", p + 2);
          p = end === -1 ? len : end + 1;
          continue;
        }
        if (/\s/.test(ch)) {
          p++;
          continue;
        }
        skipping = false;
      }
      if (p >= len || src[p] !== "{") {
        scanPos2 = idx + 1;
        continue;
      }
      const open = p;
      const close = findMatchingBrace(src, open);
      if (close === -1) {
        scanPos2 = idx + 1;
        continue;
      }
      const inner = src.slice(open + 1, close);
      if (stripComments(inner).trim() === "") {
        // Remove the keyword + block.
        // For 'else' this is safe: `if (cond) { ... } else { }` => `if (cond) { ... }`
        // For 'finally' this removes an empty finally clause: `try {...} finally { }` => `try {...}`
        src = src.slice(0, idx) + src.slice(close + 1);
        // continue scanning at same idx (content shifted)
        scanPos2 = idx;
        continue;
      } else {
        scanPos2 = close + 1;
      }
    }
  } catch (e) {
    // best-effort; don't abort on errors

    console.error("empty-else/finally pass failed for", filePath, e && e.message ? e.message : e);
  }

  // Fourth pass: use conservative regex-based replacements to remove remaining
  // patterns of the form:
  //   try { ... } catch (e) { } finally { ... }  =>  try { ... } finally { ... }
  //   try { ... } catch (e) { }                  =>  { ... }
  // We apply these repeatedly until no changes occur. This is a fallback that
  // complements the earlier scanner-based logic for tricky formatting.
  try {
    let changed = true;
    // Apply until stable to catch multiple occurrences.
    while (changed) {
      changed = false;
      // 1) try { A } catch(...) { } finally { F }  => try { A } finally { F }
      const reFinally = /try\s*\{([\s\S]*?)\}\s*catch\s*\([\s\S]*?\)\s*\{\s*\}\s*finally\s*\{([\s\S]*?)\}/g;
      const newSrc1 = src.replace(reFinally, (m, a, f) => {
        changed = true;
        return "try {" + a + "} finally {" + f + "}";
      });
      src = newSrc1;

      // 2) try { A } catch(...) { }  => { A }
      const reCatchOnly = /try\s*\{([\s\S]*?)\}\s*catch\s*\([\s\S]*?\)\s*\{\s*\}/g;
      const newSrc2 = src.replace(reCatchOnly, (m, a) => {
        changed = true;
        // preserve the block braces found in the try body
        return "{" + a + "}";
      });
      src = newSrc2;
    }
  } catch (e) {
    // best-effort; don't abort on errors

    console.error("regex-based catch removal failed for", filePath, e && e.message ? e.message : e);
  }

  if (src !== original) {
    if (DRY) {
      console.log(`[dry] would modify: ${filePath}`);
      for (const c of changes) {
        console.log("  -", c.type, `bytes ${c.start}-${c.end}`);
      }
    } else {
      fs.writeFileSync(filePath, src, "utf8");
      console.log(`modified: ${filePath} (${changes.length} changes)`);
    }
    return { path: filePath, changed: true, changesCount: changes.length, changes };
  }
  return { path: filePath, changed: false, changesCount: 0, changes: [] };
}

function main() {
  if (!fs.existsSync(ROOT)) {
    console.error("src directory not found at", ROOT);
    process.exit(1);
  }
  const files = readFiles(ROOT);
  const results = [];
  for (const f of files) {
    try {
      const res = processFile(f);
      if (res.changed) results.push(res);
    } catch (err) {
      console.error("error processing", f, err && err.message || err);
    }
  }
  console.log("Done. Files changed:", results.length);
  if (results.length > 0 && DRY) {
    console.log("Dry-run mode (default). To apply changes run with --apply.");
  }
}

if (require.main === module) {
  main();
}
