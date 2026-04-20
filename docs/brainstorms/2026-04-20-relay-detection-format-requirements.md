---
date: 2026-04-20
topic: relay-detection-format
---

# Relay: Unified Detection Strategy + Robust Tool-Call Format

## Problem Frame

The VisGraph relay bookmarklet detects AI tool calls from rendered chat UI HTML and forwards them to the app. The current multi-path detection (CSS class check → pre/code TOOL: check → raw fence) is brittle: each chat UI renders code blocks differently (ChatGPT, Claude.ai, Gemini, Azure OpenAI/CodeMirror, hljs), and the JSON `PARAMS: {...}` format breaks silently when URLs get auto-hyperlinked, `"` gets HTML-encoded as `&quot;`, or syntax-highlighting spans get injected mid-token.

Since we control the instruction format given to AI models, we can redesign both the output format and the detection strategy to be maximally robust.

## Requirements

**Format**
- R1. Drop `PARAMS: {...}` JSON. Tool calls use `key: value` lines — one param per line after the `TOOL:` line, inside a ` ```visgraph ` fence.
- R2. Auto-coerce values: `true`/`false` → boolean, numeric strings → number, everything else → string.
- R3. `TOOL:` is always the first line of the block. Parameters follow in any order.
- R4. Update the starter prompt in `README.md` to instruct AI models to use the new format.

**Detection**
- R5. Replace all multi-path detection logic with a single strategy: find any element with `visgraph` as a CSS class token OR as sole text content of a leaf element (language label) → resolve inward to the associated `code` or `pre` element → strip HTML formatting spans → parse `TOOL:` + `key: value` lines.
- R6. Use a `Set` of already-processed elements to prevent double-dispatch when both `pre` and `code` match the same block.
- R7. Retain a raw-text fallback for UIs that do not render code blocks (scan `innerText` for ` ```visgraph ``` ` fence pattern).
- R8. `stripHtml` already removes `<a>` hyperlink tags — hyperlinked URLs in param values survive as plain text. No additional URL handling needed.

**Affected files**
- R9. Both `public/relay-bookmarklet.js` (readable source) and the minified inline string in `src/components/Canvas/LeftSidebar.tsx` must be kept in sync.

## Success Criteria
- Tool calls from ChatGPT, Claude.ai, Gemini, Azure OpenAI (CodeMirror), and hljs-rendered UIs are all detected by the same code path.
- Hyperlinked URLs in IRI parameters parse correctly.
- No JSON parse errors — the format cannot produce them.
- One tool call per response, no double-dispatch.

## Scope Boundaries
- No changes to MCP tool handlers or `mcp.json`.
- No changes to the relay popup (`relay.html`) or `BroadcastChannel` bridge.
- `decodeHtml()` helper can be removed — no longer needed without JSON.

## Key Decisions
- **key:value over JSON**: All tool params in `mcp.json` are flat (string/boolean/integer). No arrays or nested objects exist. key:value format is sufficient and immune to HTML encoding and syntax-highlight injection.
- **Single strategy over fallback chain**: All known chat UIs expose "visgraph" either as a CSS class on pre/code or as a visible text label near the code block. One selector covers all cases.
- **`pre:not(:has(code))` skips outer `pre`**: When a chat UI renders `pre > code`, only `code` is scanned to avoid double-dispatch.

## Example format (new)

```
TOOL: addNode
iri: http://example.org/alice
label: Alice
typeIri: http://xmlns.com/foaf/0.1/Person
```

```
TOOL: addLink
subjectIri: http://example.org/alice
predicateIri: http://xmlns.com/foaf/0.1/knows
objectIri: http://example.org/bob
```

## Next Steps
-> `/ce-plan` for structured implementation planning
