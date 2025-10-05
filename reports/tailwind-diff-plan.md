Tailwind migration — exhaustive diff plan (exact edits & rationale)
=================================================================

Goal
----
Provide an exact, actionable list of code edits (diff-style) to remove hard-coded colors and inline presentational styles, replace JS color math, and make components consume theme tokens / CSS variables so Tailwind can drive presentation consistently in light and dark mode.

For each file: I give
- a short rationale,
- exact before/after code snippets or replacement instructions,
- follow-up notes where a small CSS addition is required (I include the CSS snippets to add to src/index.css).

Safety
------
- I will create backups before applying any of these edits (src/*.bak already created for major CSS files).
- Apply edits in small batches and run the dev server / screenshots after each batch.

Plan: concrete edits
--------------------

1) src/components/Canvas/CustomOntologyNode.tsx
Rationale: currently uses inline style for badge background and a JS darken(hex, amt) helper. Replace with CSS-variable-driven styling and move color mixing to CSS so behavior is consistent across themes and visible to Tailwind.

Replace (SEARCH)
----------------
// current badge rendering (approx)
<div
  className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold text-black flex items-center gap-1"
  style={{
    background: nodeColor,
    border: nodeColor ? `1px solid ${darken(nodeColor, 0.12)}` : undefined,
  }}
>
  <span className="truncate">
    {badgeText || nodeData.classType}
  </span>
</div>

With (REPLACE)
--------------
{/* set CSS variables on the node root (already done for left-bar) */}
<div
  className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold text-foreground flex items-center gap-1 node-badge"
  style={{ ['--node-color']: nodeColor || 'transparent' }}
  aria-hidden="true"
>
  <span className="truncate">
    {badgeText || nodeData.classType}
  </span>
</div>

Add to src/index.css (or a small components CSS file)
-----------------------------------------------------
/* node badge uses the node color variable and derives a subtle bg/border */
.node-badge {
  background: color-mix(in srgb, var(--node-color) 12%, hsl(var(--card)));
  border: 1px solid color-mix(in srgb, var(--node-color) 20%, hsl(var(--border)));
  color: hsl(var(--node-foreground, 0 0% 0%));
}

Notes
- color-mix() is modern CSS; if you need older browser support, set two CSS variables from JS: --node-badge-bg and --node-badge-border instead of relying on color-mix. The JS just assigns the node color as a variable; the CSS computes the derived tones.
- Remove the darken(hex, ...) helper function entirely.

2) src/components/Canvas/FloatingConnectionLine.tsx and src/components/Canvas/FloatingEdge.tsx
Rationale: SVG stroke/fill use hard-coded '#222' and '#fff'. Use currentColor / CSS variable to derive these so edges adapt to theme tokens.

Replace (SEARCH)
----------------
<circle cx={...} cy={...} r={3} fill="#fff" />
<path d="..." stroke="#222" strokeWidth={1.5} />

With (REPLACE)
--------------
{/* set color via CSS variable on the SVG container or parent element */}
<g style={{ color: 'hsl(var(--edge-default))' }}>
  <circle cx={...} cy={...} r={3} fill="currentColor" className="edge-dot" />
  <path d="..." stroke="currentColor" strokeWidth={1.5} className="edge-path" />
</g>

Add to src/index.css (optional)
------------------------------
.edge-dot, .edge-path {
  /* color inherited from parent via currentColor, fallback to tokens if needed */
  /* no extra rules required if parent sets style color using hsl(var(--edge-default)) */
}

Notes
- Alternatively set stroke="hsl(var(--edge-default))" and fill="hsl(var(--card))" directly if you prefer explicit CSS var usage.

3) src/components/Canvas/core/namespacePalette.ts
Rationale: Palette currently uses hard-coded hex values. Keep the palette, but make components set CSS variables instead of inlining hex strings.

Replace usage pattern (in node renderers / legend)
-------------------------------------------------
Currently code often does: style={{ backgroundColor: palette[i] }}

Replace with
------------
style={{ ['--ns-color']: palette[i] }}
and in markup/class use: style={{ background: 'hsl(var(--ns-color))' }} or CSS rules that reference var(--ns-color).

If you prefer to keep literals in palette file, convert palette entries to HSL strings or keep them and set CSS variables where used.

4) src/components/Canvas/NamespaceLegendCore.tsx
Rationale: inline style backgroundColor used for legend dot.

Replace (SEARCH)
----------------
<div style={{ backgroundColor: getColor(prefix) || undefined }} className="h-2 w-2 ..."></div>

With (REPLACE)
--------------
<div style={{ ['--ns-color']: getColor(prefix) || '' }} className="h-2 w-2 rounded-[2px]" aria-hidden="true" data-ns-dot>
</div>

And add CSS (src/index.css)
---------------------------
[data-ns-dot] { background: color-mix(in srgb, var(--ns-color) 18%, hsl(var(--card))); }

5) src/components/ui/chart.tsx
Rationale: selectors reference stroke='#ccc' and item.color used in style backgroundColor.

Replace occurrences in className selectors ('#ccc') with token references or remove the inline selector and apply CSS variables in rendered elements.

Change dynamic item background assignment
-----------------------------------------
SEARCH
style={{ backgroundColor: item.color }}

REPLACE
style={{ ['--item-color']: item.color }} and then use
style={{ background: 'color-mix(in srgb, var(--item-color) 90%, hsl(var(--card)))' }} on the element or use inline background: 'hsl(var(--item-color))' if item.color is already HSL.

6) src/components/ui/EntityAutocomplete.tsx
Rationale: style={{ zIndex: 9999 }} — convert to Tailwind utility.

Replace
-------
style={{ zIndex: 9999 }}

With
------
className="z-[9999]"  // or a lower token like z-50 if acceptable

7) src/components/Canvas/ResizableNamespaceLegend.tsx
Rationale: many inline layout styles are legitimate. Keep position/size inline. For overflow decisions, use computed classNames (already present). No change required other than ensuring any color values are tokenized.

8) src/components/Canvas/CustomOntologyNode.tsx (getComputedStyle fallbacks)
Rationale: fallback values like "#ffffff" should reference tokens.

Replace
-------
if (typeof document === "undefined") return "#ffffff";
...
return v || "#ffffff";

With
-------
if (typeof document === "undefined") return "hsl(var(--card))";
...
return v || getComputedStyle(document.documentElement).getPropertyValue("--card") || "hsl(0 0% 100%)";

Better: avoid returning '#ffffff' literal; return 'hsl(var(--card))' or set consumers to use CSS var directly.

9) src/components/ui/* files (badgeVariants, buttonVariants, card, avatar, etc.)
Rationale: various UI variants may use hardcoded color values or non-token classes. Sweep and replace 'bg-...' or color hex literals with token-driven classes in tailwind config.

Example change in badgeVariants.ts (conceptual)
-----------------------------------------------
SEARCH
default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",

REPLACE (no change needed if tokens map correctly) but ensure tailwind.config.ts maps 'primary' to use hsl(var(--primary)) so Tailwind class names correspond to tokens.

10) Tests
Rationale: tests include color fixtures — generally ok to keep.

General guidelines for code edits
---------------------------------
- For runtime dynamic colors (from ontology/palette), prefer to set CSS variables on the element:
  - style={{ ['--node-color']: nodeColor }}
  - consume in CSS: background: color-mix(in srgb, var(--node-color) 12%, hsl(var(--card)));
- Avoid JS color math functions (darken/lighten). Move derived tones to CSS via color-mix, or set additional CSS variables in JS (but not compute hex manipulation).
- Replace inline numeric zIndex or transforms only when they can map to Tailwind utilities; leave layout transforms/position values inline.

Suggested small CSS additions (src/index.css)
---------------------------------------------
/* helpers used by node renderers */
.node-badge {
  background: color-mix(in srgb, var(--node-color) 12%, hsl(var(--card)));
  border: 1px solid color-mix(in srgb, var(--node-color) 20%, hsl(var(--border)));
  color: hsl(var(--node-foreground));
}

/* namespace dot fallback */
[data-ns-dot] { background: color-mix(in srgb, var(--ns-color) 18%, hsl(var(--card))); }

/* edge default color fallback (if a parent doesn't set color) */
.edge-container { color: hsl(var(--edge-default)); }

Execution notes
---------------
- I can now apply these edits automatically in small batches (I will:
  - create .bak copies before edits,
  - run npm run build and a dev check after each batch).
- Tell me whether to (A) run these edits now (I will patch the files and capture before/after screenshots) or (B) stop: you've got the exhaustive diff plan to review.

Task progress (for tracker)
---------------------------
- [x] Mapping: produced reports/tailwind-non-theme-mapping.md
- [x] Diff plan: produced this file reports/tailwind-diff-plan.md
- [ ] Apply changes: awaiting confirmation
