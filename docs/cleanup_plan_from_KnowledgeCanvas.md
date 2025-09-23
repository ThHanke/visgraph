Summary
-------

I generated a conservative, ts-morph-based call graph for everything reachable from
src/components/Canvas/KnowledgeCanvas.tsx and placed the output under:
- docs/call_graph.generated.json

What I produced so far
- Reachability analysis from KnowledgeCanvas -> docs/reachable_from_KnowledgeCanvas_tsx.json
- A conservative function-level call graph (symbol resolution) -> docs/call_graph.generated.json

High-level findings
- KnowledgeCanvas is the entrypoint for a canvas subgraph that touches:
  - many canvas components (CanvasToolbar, NodePropertyEditor, LinkPropertyEditor, LayoutManager, etc.)
  - core helpers under src/components/Canvas/core (mappingHelpers, edgeHelpers, namespacePalette, nodeDisplay, TemplateManager)
  - several stores (ontologyStore, appConfigStore, reasoningStore, settingsStore)
  - utils used by canvas (rdfManager, rdfParser, startupDebug, termUtils)
- The generated graph is conservative: it may include ambiguous or library-level calls and some "unknown" entries where dynamic resolution prevented precise mapping.
- There is also an explicit list of files that were NOT reachable from KnowledgeCanvas:
  - docs/unreachable_from_KnowledgeCanvas_tsx.json contains the produced unreachable list (review that before deletion).

Safe cleanup plan (recommended, step-by-step)
1) Review artifacts I produced
   - docs/reachable_from_KnowledgeCanvas_tsx.json  (list of reachable files)
   - docs/unreachable_from_KnowledgeCanvas_tsx.json (list of files not reachable)
   - docs/call_graph.generated.json (detailed function/symbol map)
   Action: open and scan these files for false positives (dynamic imports, test-only helpers, dev tooling).

2) Generate a conservative file-deletion candidates list
   - Base this on docs/unreachable_from_KnowledgeCanvas_tsx.json and cross-check:
     - test files under src/__tests__ (do NOT delete)
     - files exported from index files or re-exported (search for references)
     - runtime dynamic imports (search for string specifiers)
   - I can prepare a candidates file: docs/candidates_delete_from_canvas.json

3) Stage deletions in small batches and validate
   For each small batch (5-20 files):
   - Create a feature branch: git checkout -b cleanup/knowledgecanvas-1
   - Move files to an archive folder first: git mv <file> docs/archive/ || mv <file> docs/archive/
     (This preserves history and allows quick undo)
   - Run the test suite: npm test --if-present --silent
   - Run a local dev server / smoke test the UI where needed: npm run dev (if available)
   - If tests and manual checks pass, commit and open a PR. Keep batch sizes small.

4) Permanently remove archived files after validation
   - After review + CI (tests + a quick smoke test), remove archived files and push.

5) Post-cleanup
   - Run TypeScript build / lint and fix remaining type errors.
   - Update imports that used deleted modules (if any remain).
   - Optional: run a code formatter (prettier/TS) and update docs.

Immediate next step I can perform (pick one)
A) Produce docs/candidates_delete_from_canvas.json using docs/unreachable_from_KnowledgeCanvas_tsx.json and conservative heuristics (exclude tests, public assets, manifests).
B) Produce a refined import-level file graph (edges between files only) derived from docs/call_graph.generated.json to make deletion decisions easier.
C) Start an automated, reversible archive move for a small batch (I will only prepare the git commands and NOT execute destructive moves until you confirm).

Recommended default: Option A (create conservative deletion candidates file). It is fast and safe.

Commands I will suggest when you approve step A:
- git checkout -b cleanup/knowledgecanvas-candidates
- node scripts/prepare_delete_candidates_from_unreachable.js docs/unreachable_from_KnowledgeCanvas_tsx.json docs/candidates_delete_from_canvas.json
- (review docs/candidates_delete_from_canvas.json)
- For each approved batch:
  - mkdir -p docs/archive
  - git mv <file1> <file2> docs/archive/  || mv <file1> docs/archive/ && git add docs/archive && git commit -m "archive: move candidate files"
  - npm test --if-present --silent
  - If tests pass: push & open PR

Notes and caveats
- Dynamic imports, test-only helpers, or tooling scripts can be included as "unused" by conservative static analysis — manual review is required.
- I will not delete or permanently remove files without explicit confirmation; archive/move is the safe default.
- I can run additional checks to reduce false positives (search repo for string specifiers, template strings, usage in HTML, or references by name).

Next action
- I will produce the conservative deletion-candidate list (docs/candidates_delete_from_canvas.json) based on docs/unreachable_from_KnowledgeCanvas_tsx.json unless you prefer option B or C.

Task progress
- [x] Run reachability analysis from KnowledgeCanvas
- [x] Produce function-level map for reachable files
- [ ] Present mapping and a plan to delete unused files
