---
title: Relay bookmarklet inline params split incorrectly on IRI colons
date: 2026-04-21
category: docs/solutions/logic-errors/
module: relay
problem_type: logic_error
component: tooling
symptoms:
  - "TOOL: addNode iri: http://example.org/X label: Y" parsed iri as "http://example.org/X label: Y typeIri: ..." (entire rest of line eaten)
  - Multi-param inline lines produced "http" as a spurious key with value "//example.org/Thing"
  - Single-line TOOL calls with 3+ params only captured the first param correctly
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags: [relay, bookmarklet, inline-params, iri, parsing, regex]
---

# Relay bookmarklet inline params split incorrectly on IRI colons

## Problem

The bookmarklet's `parseParamLine()` function failed to parse multiple params on a single line when any param value was an IRI (e.g. `http://example.org/Alice`). The result was that only the first param was captured, or spurious keys like `http` were created from the protocol portion of the IRI.

## Symptoms

- `TOOL: addNode iri: http://example.org/Alice label: Alice typeIri: owl:Class` produced `{iri: "http://example.org/Alice label: Alice typeIri: http://www.w3.org/2002/07/owl#Class"}` — the entire rest of the line was assigned to `iri`
- Token-split fallback `/(?=\b\w+:)/` split inside `http://` IRIs, creating `{http: "//example.org/Thing"}` as a spurious param
- Single-line TOOL blocks (compact AI responses) silently lost all but the first param

## What Didn't Work

- Adding `kv && !/\s+\w+:/.test(kv[2])` guard to skip the single-kv fast path: correctly identified multi-param lines, but the token-split fallback still mangled IRI values because `/(?=\b\w+:)/` matches `http:` inside URIs.

## Solution

Two changes to `parseParamLine()` in `public/relay-bookmarklet.js`:

**1. Guard the single-kv fast path** — skip it when the value contains additional ` word:` tokens:

```js
// Before:
if (kv) { ... return; }

// After:
if (kv && !/\s+\w+:/.test(kv[2])) { ... return; }
```

**2. Replace token-split with lazy pairRe** — stop each value before the next `\s+word:` boundary, not before any colon:

```js
// Before (broken — splits inside http://):
var tokens = line.split(/(?=\b\w+:)/);
tokens.forEach(function(tok) { ... });

// After (correct — lazy match stops before next param key):
var pairRe = /(\w+):\s*(.*?)(?=\s+\w+:|$)/g;
var mp;
while ((mp = pairRe.exec(line)) !== null) {
  var v = mp[2].trim();
  if (!v) continue;
  if (v.indexOf(':') !== -1 && v.indexOf(' ') === -1) v = expandPrefix(v);
  params[mp[1]] = v === 'true' ? true : v === 'false' ? false
    : (!isNaN(+v) && v !== '') ? +v : v;
}
```

The key insight: `(?=\s+\w+:|$)` requires whitespace before the next key, so `http:` inside a URI (no preceding space at that position) is never treated as a param boundary.

## Why This Works

The old lookahead `/(?=\b\w+:)/` matched any word-boundary followed by `word:`, including `http:` and `https:` embedded in IRI values. The lazy quantifier `(.*?)(?=\s+\w+:|$)` stops only at a whitespace-preceded `word:` pattern — which is always a param key — leaving IRI colons untouched.

## Prevention

- Unit test every param-parsing path with IRI values: `src/__tests__/relay/bookmarklet.extractToolCalls.test.ts` covers single, multi, inline, fenced, prefixed, and platform-specific formats.
- When extending `parseParamLine`, validate against test cases that include `http://` and `https://` values before merging.
- Keep the replicated parser in the test file in sync with `relay-bookmarklet.js` — the test comment says "keep in sync".

## Related Issues

- Fix committed: `2e8ee07 fix(relay): fix inline multi-param parsing when IRI values contain colons`
- Tests added: `src/__tests__/relay/bookmarklet.extractToolCalls.test.ts` (16 tests, all passing)
