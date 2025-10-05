Tailwind + Vite migration — changes applied and next steps
=========================================================

Summary (what I changed so far)
- Project build verified repeatedly after each batch of edits.
- Replaced JS darken() badge logic in nodes:
  - CustomOntologyNode now sets --node-color from the node data (hex preserved).
  - Badge background uses var(--node-color) so node-provided hexs remain visible.
  - Added per-node JS helper to compute a readable badge text color (sets --node-badge-foreground to either #ffffff or #111827 based on relative luminance).
- Centralized theme tokens tuned:
  - Adjusted canvas token tints for light and dark (--canvas-bg / --canvas-grid).
  - Tuned dark-mode muted-foreground and border tokens for better contrast.
- Moved dynamic color handling into CSS variables:
  - Namespace legend swatches set --ns-color (plus inline fallback) so legend matches nodes.
  - Chart legend/tooltips updated to use CSS variables where appropriate.
- Replaced hard-coded SVG/stroke/fill colors:
  - FloatingConnectionLine & FloatingEdge use currentColor, with a fallback color via --edge-default.
- Replaced presentational inline styles where appropriate:
  - EntityAutocomplete: replaced style zIndex with Tailwind z-[9999].
  - Chart legend & indicators: replaced selectors referencing hexes with token-based selectors.
- Visual/UI fixes:
  - Node bodies forced to solid surfaces to avoid translucency/readability issues.
  - Edge label forced styles reverted when badge components already control visuals.
- Added CSS helpers in src/index.css:
  - .node-badge uses var(--node-badge-foreground) and var(--node-color)
  - [data-ns-dot] uses --ns-color
  - .edge-container supports currentColor for SVG children
- Tests and palette:
  - Kept DEFAULT_PALETTE hex literals in src/components/Canvas/core/namespacePalette.ts (this is the canonical palette).
  - Test files still contain literals; left unchanged.

Files I updated (not exhaustive)
- src/index.css
- src/components/Canvas/CustomOntologyNode.tsx
- src/components/Canvas/FloatingConnectionLine.tsx
- src/components/Canvas/FloatingEdge.tsx
- src/components/Canvas/NamespaceLegendCore.tsx
- src/components/Canvas/ResizableNamespaceLegend.tsx
- src/components/ui/chart.tsx
- src/components/ui/EntityAutocomplete.tsx

Why these changes
- Preserve runtime, data-driven colors (hex) while ensuring text contrast and theme consistency.
- Move derived presentation into CSS variables and tokens so Tailwind and dark-mode both work predictably.
- Reduce global/translucent backgrounds for canvas content so visual elements remain readable.

What I did NOT change (intentional)
- Kept the namespace palette hex entries in namespacePalette.ts (this is a data/palette source).
- Left most tests and backup files untouched (they can contain literals).
- Did not replace programmatic or layout-related inline styles (transforms, positions).

Immediate next steps I will run (unless you ask otherwise)
1. Sweep remaining UI source files (avatar, card, toast, input variants, popover/dialog wrappers) for any remaining presentational inline color values or styles and convert them to token/CSS-var usage. Estimated: 20–40 minutes.
2. Run automated contrast checks for:
   - Sample node badges (random sample of nodes / palette colors)
   - Small annotation labels and chip texts
   Produce a short report with any failing items and recommended token adjustments. Estimated: 10–20 minutes.
3. Apply minor token tweaks (if needed) and capture final light/dark screenshots for your review. Estimated: 10–20 minutes.

Questions for you (pick one)
- Proceed with step 1: full sweep of remaining UI components and convert any hard-coded presentational colors? (I will create patches and run builds after changes.)
- Or, should I run the automated contrast checker first against current build to see if more token adjustments are necessary before sweeping UI files?

If you want me to continue automatically, reply "Proceed sweep" and I will:
- Run a focused sweep of src/components/ui and src/components/Canvas for remaining presentational color literals and convert them safely (keeping palette/test literals unchanged).
- Run a build, then run contrast checks and capture light/dark screenshots.

Task progress
- [x] Investigate and plan migration approach
- [x] Replace JS darken logic and use CSS variables for badges
- [x] Tune canvas & theme tokens for light/dark
- [x] Replace SVG hard-coded colors for edges
- [x] Sweep and fix several UI components (chart, entity autocomplete, badge/button variants)
- [ ] Sweep remaining UI components
- [ ] Automated contrast checks
- [ ] Final token adjustments and screenshots
