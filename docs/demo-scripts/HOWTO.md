# Demo video HOWTO

## Re-record an existing video

```sh
npm run dev          # terminal 1 — keep running
npm run demo:video   # terminal 2
```

Outputs `docs/demo-videos/<name>.webm` + `.mp4`. Commit both.
`demo:video` runs Playwright then automatically calls `scripts/collect-demo-videos.mjs`, which copies videos from the hashed Playwright output dir to `docs/demo-videos/<name>.*`.

> **Requires `ffmpeg`** for `.mp4` conversion. If missing, only `.webm` is written and a warning is printed.
> Install: `sudo apt install ffmpeg` (Debian/Ubuntu) or `brew install ffmpeg` (macOS).

## Create a new demo video

1. Write screenplay in `docs/demo-scripts/<name>.md` — plain English prose (see `advert-intro.md` as example)
2. Ask Claude: *"Record a demo video from this screenplay: `docs/demo-scripts/<name>.md`"*
3. Claude writes `e2e/demo-<name>.spec.ts` using `DemoRunner` from `e2e/demo-runner.ts`
4. Run `npm run demo:video` — produces and commits video files

## Create a seed-driven demo video

Seed files (`docs/mcp-demo/seeds/*.md`) already contain the full AI workflow as JSON-RPC tool calls.
To turn one into a video, create a spec that calls `DemoRunner.parseSeed()` + `runSeedTurn()`:

```ts
const turns = DemoRunner.parseSeed('docs/mcp-demo/seeds/my-seed.md'); // relative to repo root
await runner.openApp();
for (const turn of turns) {
  await runner.runSeedTurn(turn, 250);
  await runner.pauseMs(600);
}
```

`parseSeed()` extracts tool calls and snapshot captions from the seed markdown.
`runSeedTurn()` calls each tool directly on `window.__mcpTools` and shows the caption overlay.

## Runner primitives (`e2e/demo-runner.ts`)

| Method | Description |
|--------|-------------|
| `openStage()` | Opens mock chat (left) + app (right) at 1920×1080 |
| `openApp()` | Opens app alone (full viewport) — for seed-driven demos |
| `DemoRunner.parseSeed(path)` | Parse seed markdown → `SeedTurn[]` (static) |
| `runSeedTurn(turn, delayMs?)` | Execute one seed turn: caption + tool calls on app frame |
| `injectBookmarklet()` | Injects relay bookmarklet, waits for popup |
| `clickScenario(name)` | `single \| batch \| full \| prefixed \| unknown-tool` |
| `switchMode(mode)` | `fhgenie \| openwebui \| chatgpt` |
| `waitForResult(timeout?)` | Waits for `[Ontosphere` result in chat stream |
| `clearChat()` | Clears mock chat |
| `pauseMs(ms)` | Pacing pause |
| `caption(text)` | Bottom-center overlay — stays until replaced or cleared |
| `clearCaption()` | Remove overlay |
| `captionPause(text, ms)` | Show caption → pause → clear |

## Building an OWUI Socratic demo: interactive-first workflow

The OWUI Socratic demo (pizza-ontology) drives a live AI model through Socratic questions
and records its tool calls on the Ontosphere canvas. The scripted Playwright spec must
match what that specific model (qwen3:4b) actually does — not what we wish it did.

**Workflow: validate questions interactively, then encode them in the spec.**

### Step 1 — Prerequisites

```bash
# Terminal 1: keep Ontosphere dev server running
npm run dev

# Terminal 2: clear stale browser state before each session
bash .playwright/demo-restart.sh
```

MCP browser must have two tabs **before** running setup:
- **Tab 0** — Ontosphere at `http://docker-dev.iwm.fraunhofer.de:8080`
- **Tab 1** — OWUI at `https://gpuserver1-sit.iwm.fraunhofer.de` (authenticated)

If OWUI shows auth page, restore session from saved state:
```bash
OWUI_URL=https://gpuserver1-sit.iwm.fraunhofer.de npm run demo:owui:auth
```
Or inject the token inline (see pizza-demo-setup.js auth section).

### Step 2 — Bootstrap the interactive session

```text
mcp__playwright__browser_run_code_unsafe filename=.playwright/pizza-demo-setup.js
```

Expected return: `{ ok: true, chatUrl, instrInjected: true, turn0: true }`.

This sends: plain-text seed → relay injection → `help({})` call → T0 question.
Turn 0 is now in flight. Wait for the model to finish (relay toast appears, streaming stops).

### Step 3 — Observe T0 behavior

Check two things:
1. **Canvas**: take a screenshot or read node list — does it match the expected OWL concept?
2. **OWUI chat body**: read `document.body.innerText` to see what qwen3 actually generated.
   Look for which tools were called (relay result lines: `[Ontosphere — N tools ✓]`).

Key questions per turn:
- Did qwen3 use the right OWL concept? (e.g. `rdfs:subClassOf`, `owl:disjointWith`)
- Did it stay on-topic? (qwen3 sometimes introduces off-topic classes like `Person/Alice`)
- Did it call too many tools in one response (went ahead of where we wanted to stop)?
- Did the canvas change correctly?

### Step 4 — Drive turns interactively

Inject remaining turns one at a time via turn-driver.js OR manually via `__vgInjectResult`:

```text
mcp__playwright__browser_run_code_unsafe filename=.playwright/turn-driver.js
```

Or inject a single turn manually:
```js
// In browser_run_code_unsafe:
async (page) => {
  const owuiPage = page.context().pages().find(p => p.url().includes('gpuserver1-sit'));
  const ok = await owuiPage.evaluate(t => window.__vgInjectResult?.(t), 'Your question here');
  const btn = await owuiPage.$('#send-message-button:not([disabled])');
  if (btn) await btn.click();
  return { ok };
}
```

### Step 5 — Capture turn-by-turn results

After each turn completes (streaming=false), read the model response:

```js
async (page) => {
  const owuiPage = page.context().pages().find(p => p.url().includes('gpuserver1-sit'));
  return owuiPage.evaluate(() => {
    const texts = Array.from(document.querySelectorAll('[class*="prose"],[class*="markdown"]'))
      .map(e => e.innerText).filter(t => t.length > 20);
    return texts[texts.length - 1]?.slice(0, 3000);
  });
}
```

And check relay results in the OWUI chat for `[Ontosphere — N tools ✓]` lines.

### Step 6 — Iterate questions

If qwen3 goes off-topic, uses wrong format, or skips a concept:
- Adjust the question in `.playwright/turn-driver.js` (TURNS array)
- Add a **fallback nudge** (see `pizza-ontology.md` Fallback nudges section)
- Re-run from Step 2 with a fresh session (`demo-restart.sh` first)

Common failure modes:

| Failure | Cause | Fix |
|---------|-------|-----|
| Goes ahead of the question | Model is eager/comprehensive | Add "only do this one step" |
| Off-topic nodes (Person/Alice) | Hallucinated from training | Add "stay within the pizza domain" |
| Wrong format (triple-backtick) | Model forgot relay format | Nudge with `help({tool:"X"})` reminder |
| subClassOf reversed | Confuses direction | Nudge: "points from specific to general" |

### Step 7 — Promote validated questions to scripted spec

Once all T0–T9 questions produce the correct OWL concepts in order:
1. Copy the final TURNS array from `turn-driver.js` → `e2e/demo-openwebui-socratic.spec.ts`
2. Update caption text in `pizza-ontology.md` to match what qwen3 actually produced
3. Run `npm run demo:owui:video` to record the scripted version

The scripted spec replays the same questions against a live model session — it is not
pre-recorded; the model still runs live. The spec just drives the questions and waits for
tool-call completion at each turn.

---

## Planned videos

- `advert-intro` — done (relay demo, mock chat + app side by side)
- `foaf-social-network` — done (seed-driven, FOAF + employment + OWL-RL reasoning)
- `reasoning-demo` — done (seed-driven, OWL-RL class/property hierarchy)
- `scene-ontology` — done (seed-driven, film ontology on BFO/RO)
- `basic-demo` — next: walkthrough of core UI, manual node authoring, layout, export
