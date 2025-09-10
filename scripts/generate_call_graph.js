import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * Simple AST-based call-graph generator for the repository's `src/` directory.
 *
 * - Scans .ts, .tsx, .js, .jsx files under src/
 * - Collects top-level function/class/method definitions (best-effort)
 * - Collects all call expressions and records the callee text and call location
 * - Emits docs/call_graph.generated.json containing a conservative mapping
 *
 * Notes:
 * - This is a lightweight, conservative approach (no type-based resolution).
 * - Property-based calls (e.g., rdfManager.loadRDF) are left as-is (callee text).
 * - For more precise resolution (link call -> definition) consider using ts-morph or
 *   the TypeScript language service to resolve symbols.
 */

const ROOT = path.resolve(process.cwd());
const SRC_DIR = path.join(ROOT, 'src');
const OUT_PATH = path.join(ROOT, 'docs', 'call_graph.generated.json');

function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      files.push(...walkDir(full));
    } else if (e.isFile()) {
      if (/\.(ts|tsx|js|jsx)$/.test(e.name) && !/node_modules/.test(full)) {
        files.push(full);
      }
    }
  }
  return files;
}

function parseFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  const scriptKind = ext === '.tsx' || ext === '.jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKind);
  return { sf, content };
}

function getLineCol(sf, pos) {
  const { line, character } = sf.getLineAndCharacterOfPosition(pos);
  return { line: line + 1, column: character + 1 };
}

// Collect definitions and calls
const definitions = Object.create(null); // name -> { files: Set }
const calls = Object.create(null); // calleeText -> Set of locations

function recordDefinition(name, file) {
  if (!name) return;
  if (!definitions[name]) definitions[name] = new Set();
  definitions[name].add(file);
}

function recordCall(calleeText, file, lineCol) {
  if (!calleeText) return;
  if (!calls[calleeText]) calls[calleeText] = new Set();
  calls[calleeText].add(`${path.relative(ROOT, file)}:${lineCol.line}:${lineCol.column}`);
}

function visitNode(node, sf, file) {
  // Function declarations: function foo(...) { }
  if (ts.isFunctionDeclaration(node) && node.name && node.name.text) {
    recordDefinition(node.name.text, file);
  }

  // Variable declarations assigned to function/arrow/class expression: const foo = (...) => { }
  if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) {
        const name = decl.name.text;
        const init = decl.initializer;
        if (ts.isFunctionExpression(init) || ts.isArrowFunction(init) || ts.isClassExpression(init) || ts.isCallExpression(init)) {
          recordDefinition(name, file);
        }
      }
    }
  }

  // Export assignments: export const foo = ...
  if (ts.isExportAssignment(node)) {
    // export default ...
    // nothing to record here as named defs are captured elsewhere
  }

  // Named exports (export function foo ... / export const foo ...)
  if (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) {
    if (ts.isFunctionDeclaration(node) && node.name && node.name.text) {
      recordDefinition(node.name.text, file);
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) recordDefinition(decl.name.text, file);
      }
    } else if (ts.isClassDeclaration(node) && node.name && node.name.text) {
      recordDefinition(node.name.text, file);
    }
  }

  // Class method names
  if (ts.isClassDeclaration(node) && node.members) {
    for (const m of node.members) {
      if ((ts.isMethodDeclaration(m) || ts.isMethodSignature(m)) && m.name && ts.isIdentifier(m.name)) {
        recordDefinition(m.name.text, file);
      }
    }
  }

  // Object literal method properties: const obj = { foo() {} }
  if (ts.isPropertyAssignment(node) && (ts.isFunctionExpression(node.initializer) || ts.isArrowFunction(node.initializer))) {
    if (ts.isIdentifier(node.name)) {
      recordDefinition(node.name.text, file);
    }
  }

  // Call expressions
  if (ts.isCallExpression(node)) {
    const expr = node.expression;
    let calleeText = '';
    try {
      calleeText = expr.getText(sf);
    } catch {
      calleeText = '';
    }
    const lc = getLineCol(sf, node.getStart());
    recordCall(calleeText, file, lc);
  }

  ts.forEachChild(node, (c) => visitNode(c, sf, file));
}

function buildGraph() {
  const files = walkDir(SRC_DIR);
  for (const file of files) {
    try {
      const { sf } = parseFile(file);
      visitNode(sf, sf, file);
    } catch (e) {
      console.warn('Failed to parse', file, e && e.message);
    }
  }

  // Prepare a merged list of names (union of definitions and simple callee names)
  const functionMap = new Map(); // name -> { definedIn: [...], callSites: [...] }

  // Add definitions
  for (const name of Object.keys(definitions)) {
    const defs = Array.from(definitions[name]);
    functionMap.set(name, {
      name,
      definedIn: defs.map(f => path.relative(ROOT, f)),
      callSites: []
    });
  }

  // Add calls, try to attach to existing function by exact name match (identifier-only)
  for (const calleeText of Object.keys(calls)) {
    const sites = Array.from(calls[calleeText]);
    // If calleeText looks like a simple identifier, try to map to that function
    const simpleMatch = /^[A-Za-z0-9_$]+$/.test(calleeText);
    if (simpleMatch && functionMap.has(calleeText)) {
      const entry = functionMap.get(calleeText);
      entry.callSites.push(...sites);
      functionMap.set(calleeText, entry);
    } else {
      // For property access like rdfManager.loadRDF record as separate entry keyed by the calleeText
      const key = calleeText;
      if (!functionMap.has(key)) {
        functionMap.set(key, {
          name: key,
          definedIn: [],
          callSites: [...sites]
        });
      } else {
        const e = functionMap.get(key);
        e.callSites.push(...sites);
        functionMap.set(key, e);
      }
    }
  }

  // Normalize callSites (unique) and sort
  const functions = [];
  for (const [k, v] of functionMap.entries()) {
    const uniqueSites = Array.from(new Set(v.callSites || [])).sort();
    functions.push({
      name: v.name,
      definedIn: v.definedIn.length ? Array.from(new Set(v.definedIn)).sort() : ['unknown'],
      role: '',
      callSites: uniqueSites
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    note: 'Generated by scripts/generate_call_graph.js — conservative AST-based mapping (no type resolution). Use this as a base for further resolution or to seed more advanced tooling.',
    functions
  };
}

function writeOutput(obj) {
  try {
    const dir = path.dirname(OUT_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(obj, null, 2), 'utf8');
    console.log('Call graph written to', OUT_PATH);
  } catch (e) {
    console.error('Failed to write output', e);
    process.exit(2);
  }
}

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error('Source directory not found:', SRC_DIR);
    process.exit(1);
  }
  const graph = buildGraph();
  writeOutput(graph);
}

main();
