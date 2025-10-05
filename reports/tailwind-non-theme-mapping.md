Tailwind migration — file-by-file mapping of non-theme colors & inline styles
=============================================================================

Purpose
-------
This document lists occurrences of non-theme color literals (hex colors), inline style usage, and other presentational code that should be converted to Tailwind utilities or CSS-variable-driven values. For each entry I include:
- why it matters,
- suggested replacement approach,
- the file path and short description of the code to change.

I generated this mapping from automated scans of the repository and manual inspection of high-impact Canvas + UI components.

How to read recommendations
- Prefer CSS variables (defined in src/index.css :root and .dark) for dynamic colors: set e.g. --node-color and use bg-[hsl(var(--node-color))] or inline style referencing hsl(var(--node-color)).
- Replace hardcoded hex colors with token classes (text-foreground, text-muted-foreground, text-primary, text-warning, text-destructive) or CSS variables.
- Replace inline layout styles (position, left/top/height) with Tailwind utilities on the element when possible, or keep minimal inline style that sets CSS variables only.

Mapping (file → findings & recommended action)
-----------------------------------------------

1) src/components/Canvas/CustomOntologyNode.tsx
   - Findings:
     - Default themeBg fallback uses "#ffffff".
     - Inline style for left bar and badge background: style={{ background: nodeColor }} and badge uses darken(nodeColor, ...)
   - Why:
     - Explicit hex fallback and JS color manipulation bypass theme tokens and cause inconsistent dark mode rendering.
   - Action:
     - Remove darken() JS helper.
     - Set CSS variables on the node container: style={{ ['--node-color']: nodeColor }} and then use CSS variable for left bar and for badge bg/border:
       - left bar: style={{ background: 'hsl(var(--node-color-h))' }} or use inline hsl if nodeColor already hsl.
       - badge: use color-mix or a computed CSS var: --node-badge-bg and reference it in style or via Tailwind arbitrary: bg-[hsl(var(--node-badge-bg))].
     - Replace "#ffffff" fallback by reading --card or --node-bg token: getComputedStyle fallback should use 'hsl(var(--card))'.

2) src/components/Canvas/FloatingConnectionLine.tsx
   - Findings:
     - Hardcoded stroke="#222" and fill="#fff" in SVG elements.
   - Why:
     - Hardcoded colors ignore theme tokens; in dark mode stroke may be invisible or too strong.
   - Action:
     - Replace with stroke="hsl(var(--edge-default))" or use stroke="currentColor" and set className with Tailwind token (text-edge) on parent.
     - For fill, use fill="hsl(var(--card))" or fill="currentColor" and set color via class.

3) src/components/Canvas/FloatingEdge.tsx
   - Findings:
     - Inline style transform for label positioning (ok), and some fill "#fff" or other color literals in places.
   - Action:
     - Keep transform inline (layout-driven) but move color literals to CSS variables or Tailwind token classes applied to the element.

4) src/components/Canvas/core/namespacePalette.ts
   - Findings:
     - Array of hardcoded pastel hex colors used as palette (#7DD3FC, #A7F3D0, etc.).
   - Why:
     - These are acceptable as a palette choice but they are hex literals scattered in code.
   - Action:
     - Convert palette to HSL tokens or set/derive CSS variables for each palette entry (e.g., --ns-color-1) and use them when rendering nodes. Keep this file as canonical palette but ensure components set CSS variables rather than inline hexs.

5) src/components/Canvas/NamespaceLegendCore.tsx
   - Findings:
     - style={{ backgroundColor: getColor(prefix) || undefined }} used for legend color dot.
   - Action:
     - Keep logic but set the color as a CSS variable on the legend item (e.g., style={{ ['--ns-color']: getColor(prefix) }}) and use Tailwind classes with arbitrary value or inline style for background: style={{ background: 'hsl(var(--ns-color))' }}. Prefer HSL palette entries.

6) src/components/ui/chart.tsx
   - Findings:
     - ClassName contains selectors that include stroke='#ccc' and references to item.color in inline style: style={{ backgroundColor: item.color }}.
   - Action:
     - Replace '#ccc' with a token reference: stroke="hsl(var(--border))" or map to Tailwind tokens via CSS custom properties.
     - For item.color (dynamic palette), set CSS variable on the chart item element and use a Tailwind arbitrary background: bg-[rgba(var(--item-color-rgb)/0.9)] or style with hsl(var(--...)).

7) src/components/ui/progress.tsx
   - Findings:
     - Inline style transform: transform: `translateX(-${100 - (value || 0)}%)`
   - Action:
     - This is layout-driven and fine as inline. No color change needed. Keep inline transform.

8) src/components/ui/EntityAutocomplete.tsx
   - Findings:
     - style={{ zIndex: 9999 }} used on popover root.
   - Action:
     - Prefer using utility class z-[9999] or a lower Tailwind z-index token if acceptable. If this fixed value is important, convert to Tailwind arbitrary: className="z-[9999]".

9) src/components/Canvas/ResizableNamespaceLegend.tsx
   - Findings:
     - Inline styles for position/size: style={{ left: position.x, top: position.y, width: size.width, height: size.height, zIndex: 50 }} and style for inner height: style={{ height: size.height - 60, overflowY: needsScroll ? "auto" : "hidden" }}
   - Action:
     - Keep direct position/size styles (they are runtime layout values). For overflow/scroll behavior, prefer classnames computed and applied (e.g., className={needsScroll ? "overflow-y-auto" : "overflow-hidden"}) — already used in part. Only style to keep: computed pixel widths and left/top remain inline.

10) src/components/Canvas/CustomOntologyNode.tsx (additional)
    - Findings:
      - Uses getComputedStyle fallback values that return '#ffffff' strings.
    - Action:
      - Replace hardcoded hex fallback with reading CSS variables and converting to HSL via CSS var usage, e.g., use 'hsl(var(--card))' as fallback.

11) Tests & fixtures
    - Findings:
      - Some tests reference fixtures with color values (ok to leave).
    - Action:
      - Tests can keep hex literals; migration is focused on runtime UI. No change required unless you want tests to use tokenized palette.

12) src/reactflow-controls.css.bak and other .bak files
    - Findings:
      - Backups contain many hex values and direct colors. These are backups — no change needed now, but review before deleting backups.
    - Action:
      - Keep backups. If you later remove global rules, ensure the backup is kept in repository or a branch.

Scan results summary (counts)
- Hex color occurrences found by automated scan: 48 matches across the codebase.
- Inline style (style={{) occurrences found: ~10 that are important to review (positional transforms, color backgrounds, zIndex).

Quick prioritized next edits (practical)
1. Replace badge darken() logic in CustomOntologyNode (set --node-color and --node-badge-bg).
2. Replace SVG strokes/fills using '#222' / '#fff' in FloatingConnectionLine & FloatingEdge to use CSS variables or `currentColor`.
3. Convert palette in namespacePalette.ts into HSL token values or expose as CSS variables and use them via CSS var references.
4. Replace inline backgroundColor: item.color in charts with CSS variables set on the element.
5. Sweep components under src/components/ui for hex literals (badgeVariants, buttonVariants, avatar) and convert to token refs.

Deliverable next
- If you confirm, I will:
  - Implement step 1 (badge darken replacement) and step 2 (SVG color variableization) and capture before/after light & dark screenshots.
  - Or, I can produce a more exhaustive file-by-file diff plan listing exact code lines to change — tell me which you prefer.

Notes
- Many inline style usages are layout-related (position/transform/height/width) and should remain inline. The mapping focuses on presentational inline styles and color literals.
- Where color is dynamic (user- or ontology-driven), prefer setting CSS variables on the element and consuming them via CSS vars (this keeps the runtime dynamic aspect while enabling consistent theming).
