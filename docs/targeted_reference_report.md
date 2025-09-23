Targeted reference check report
Entry: src/components/Canvas/KnowledgeCanvas.tsx
Source: docs/call_graph.generated.json (ts-morph symbol-level graph)
Checked files:
  - src/components/Canvas/core/DiagramManager.ts
  - src/components/Canvas/core/TemplateManager.ts
  - src/components/Canvas/core/EventHandlers.ts
  - src/components/Canvas/ReactFlowCanvas.tsx
  - src/components/Canvas/AnnotationPropertyDialog.tsx
  - src/components/Canvas/NamespaceLegend.tsx
  - src/components/Canvas/helpers/diagramHelpers.ts
  - src/components/Canvas/helpers/paletteHelpers.ts

Summary of findings (per-file)
1) src/components/Canvas/core/DiagramManager.ts
   - Definitions: DiagramManager (defined in this file)
   - Calls inside file: NONE (no call-sites recorded in call graph)
   - Implication: DiagramManager defines a symbol but no recorded internal call-sites. It may be referenced externally; use textual search before deletion. Risk: MEDIUM (canvas-adjacent core).

2) src/components/Canvas/core/TemplateManager.ts
   - Definitions:
       - TemplateManager (defined in this file)
       - computeDisplayInfo (defined in multiple places including tests and nodeDisplay)
   - Calls inside file: getState, computeDisplayInfo, getRdfManager (call sites within the same file were recorded)
   - Notable: computeDisplayInfo is defined in and referenced by tests and also in nodeDisplay/diagramHelpers — indicates cross-file and test usage.
   - Implication: TemplateManager and computeDisplayInfo participate in project logic and are referenced by tests and helper modules. Risk: HIGH→MEDIUM (do not delete without careful verification).

3) src/components/Canvas/core/EventHandlers.ts
   - Definitions: EventHandlerManager (defined in this file)
   - Calls inside file: NONE
   - Implication: core runtime manager; could be unused or used dynamically. Risk: MEDIUM.

4) src/components/Canvas/ReactFlowCanvas.tsx
   - Definitions: NONE (no top-level symbol definitions found by ts-morph)
   - Calls inside file: NONE
   - Implication: file exists but no function/class symbols detected in call graph; could be a pure component or wrapper that ts-morph didn't attribute. Inspect file manually. Risk: MEDIUM.

5) src/components/Canvas/AnnotationPropertyDialog.tsx
   - Definitions found (local symbols and setters): useState (hook usage), setProperties, setNewPropertyUri, setNewPropertyValue, onSave, setOpen, handleRemoveProperty
   - Calls inside file: many (map, filter, useState, onSave, setOpen, success, handleRemoveProperty, etc.)
   - Notable: onSave and handleRemoveProperty are also defined/used by NodePropertyEditor / LinkPropertyEditor per call graph.
   - Implication: This dialog shares behavior with node/link editors — likely used by other canvas UI paths. Risk: MEDIUM→HIGH (verify usage paths; don't delete blindly).

6) src/components/Canvas/NamespaceLegend.tsx
   - Definitions: NONE
   - Calls inside file: NONE
   - Implication: might be a simple presentational component that wasn't symbolized; verify manually. Risk: LOW→MEDIUM.

7) src/components/Canvas/helpers/diagramHelpers.ts
   - Definitions:
       - computeDisplayInfo (also defined elsewhere; shared)
       - computeBadgeText
       - filterNodesByViewMode
       - applyPaletteToModelForDiagram
       - buildPaletteForRdfManager
   - Calls inside file: many (computeDisplayInfo, computeBadgeText, buildPaletteForRdfManager, diagram.* ops)
   - Notable: computeDisplayInfo and computeBadgeText are used by CustomOntologyNode, nodeDisplay, and tests.
   - Implication: helper implements core diagram utilities used across canvas. Risk: HIGH (do not remove without deep verification).

8) src/components/Canvas/helpers/paletteHelpers.ts
   - Definitions:
       - deriveNamespaceFromInfo
       - getColorFromPalette
   - Calls inside file: String, split, replace, includes, endsWith (internal)
   - Implication: palette helpers are used to derive colors/namespaces; likely referenced by palette-building code. Risk: MEDIUM.

Recommendations (next safe steps)
- Do NOT delete any files yet. The symbol-level call graph shows that many of these files define core symbols or share symbols used in tests and other helpers.
- For each medium/high risk file, run:
    - git grep / textual search for direct imports (e.g., git grep "DiagramManager" -- src)
    - Search for runtime uses (window access, dynamic import strings).
    - Cross-reference the call graph: jq or grep call_graph.generated.json for function names defined in the file.
- Follow the safe archive workflow:
    1. Create a branch: git checkout -b cleanup/knowledgecanvas-unused
    2. For low-risk items (e.g., NamespaceLegend if confirmed unused), move to archive in small batches:
         mkdir -p archived/knowledgecanvas_candidates
         git mv <file> archived/knowledgecanvas_candidates/
         npm run build && npm test
         If green: commit. If not: revert.
    3. For medium/high risk files, only archive after verifying no remaining references from reachable files:
         - Use jq to locate call sites in docs/call_graph.generated.json
         - Use git grep for symbol names and file paths
- I can run these automated checks for you:
    - A) Run git grep for symbol names found in each file to surface textual references across repo.
    - B) Produce a per-file annotated JSON with: definitions, callSites (from call_graph.generated.json), textual grep hits (if any).
    - C) Prepare safe git mv commands for a chosen subset (won't execute them).

If you want me to perform automated textual greps for the symbols found above (option A), confirm and I'll run them and return the results.
