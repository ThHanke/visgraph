---
title: Vitest jsdom environment fails when test files run in isolation
date: 2026-04-21
category: docs/solutions/developer-experience/
module: testing
problem_type: developer_experience
component: testing_framework
severity: medium
symptoms:
  - "TypeError: Cannot read properties of undefined (reading 'get')" from jsdom/webidl-conversions
  - "Test Files: no tests / Errors: 1 error" when running a single jsdom test file with npx vitest run <file>
  - DOM-dependent tests (React components, document.body manipulation) silently collect 0 tests
applies_when:
  - Writing new test files that need browser DOM APIs (document, window, querySelector, etc.)
  - Running `npx vitest run <specific-file>` on any DOM test
tags: [vitest, jsdom, testing, dom, environment, isolation]
---

# Vitest jsdom environment fails when test files run in isolation

## Context

The project configures `environment: 'jsdom'` and `setupFiles: ['src/test-setup.ts']` in `vitest.config.ts`. When running the full suite (`npx vitest run`) the setup file initialises jsdom correctly and all 89+ tests pass. However, running a single file in isolation (e.g. `npx vitest run src/__tests__/relay/bookmarklet.domInput.test.ts`) triggers `TypeError: Cannot read properties of undefined (reading 'get')` deep in `jsdom/node_modules/webidl-conversions`, and zero tests are collected.

The same failure affects ALL jsdom-dependent test files — including existing component tests like `KnowledgeCanvas.autoload.test.tsx`.

## Guidance

**Do not write DOM tests that need `document.*` APIs for the relay bookmarklet or similar pure-JS modules.** Instead:

1. **Pure-logic tests** (parser, regex, string manipulation): add `// @vitest-environment node` at the top of the file. These run correctly in isolation and as part of the full suite.
2. **DOM integration tests**: use Playwright against the actual HTML page (`public/relay-mock-chat.html`). This is the correct tool for testing `findInput()`, `submitInput()`, MutationObserver wiring, and cross-platform DOM structures.
3. **Text-extraction coverage for multiple chat platforms**: write parser unit tests using realistic `innerText` snapshots from each platform (FhGenie, Open WebUI, ChatGPT). These do not need a DOM — just pass the text content to the parser function.

## Why This Matters

A DOM test file that silently collects 0 tests gives false confidence. The jsdom isolation failure is a project-level environment issue (likely a Node.js / jsdom version incompatibility exposed when `setupFiles` is not loaded). Until this is resolved, attempting to write DOM tests for the relay module will produce unreliable results.

## When to Apply

- Any new test file for browser-side JS (bookmarklet, relay bridge, UI helpers)
- Whenever `npx vitest run <file>` returns "no tests / 1 error" with the webidl-conversions stack trace

## Examples

**Working (node env, pure logic):**
```ts
// @vitest-environment node
import { describe, it, expect } from 'vitest';

function extractToolCalls(text: string) { /* ... */ }

it('parses TOOL block', () => {
  expect(extractToolCalls('TOOL: addNode\niri: http://example.org/X'))
    .toHaveLength(1);
});
```

**Broken (jsdom, DOM APIs, isolation fails):**
```ts
// No env override — inherits jsdom from vitest.config.ts
it('finds textarea', () => {
  document.body.innerHTML = '<textarea></textarea>'; // TypeError in isolation
  expect(document.querySelector('textarea')).not.toBeNull();
});
```

**Correct alternative for DOM tests:** use Playwright test against `public/relay-mock-chat.html`.

## Related

- Fix tracked: `src/__tests__/relay/bookmarklet.extractToolCalls.test.ts` — 16 passing tests using `@vitest-environment node`
- Mock page for manual/Playwright testing: `public/relay-mock-chat.html`
- Next step: add `playwright/relay-mock-chat.spec.ts` covering `findInput()` for FhGenie, Open WebUI, and ChatGPT DOM structures
