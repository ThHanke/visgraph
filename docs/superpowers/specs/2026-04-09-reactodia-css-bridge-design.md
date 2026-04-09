# Design: Reactodia CSS Variable Bridge

**Date:** 2026-04-09  
**Status:** Approved

## Problem

The app has two CSS systems that are not fully bridged:

1. **shadcn/Tailwind** — `--background`, `--foreground`, `--border`, `--input`, `--card`, `--primary`, `--destructive`, etc.
2. **Reactodia** — `--reactodia-background-color-surface`, `--reactodia-input-*`, `--reactodia-color-gray-*`, `--reactodia-color-primary`, etc.

Only ~10 Reactodia variables are currently overridden. The rest fall back to Reactodia's hardcoded light-mode defaults, causing:

- **Dialog transparency** — `.reactodia-dialog` uses `--reactodia-background-color-surface`, which is set to `rgba(255,255,255,0.55)` (glass). Dialogs bleed through to the canvas.
- **Wrong dropdown/form colors** — `DefaultPropertyEditor` selects, inputs, and list items use Reactodia's gray color scale (`--reactodia-color-gray-*`) which is never overridden → renders light-gray in dark mode.
- **Inconsistent theming** — halo actions, tree views, search panels, selection boxes all use Reactodia's default palette instead of the app's design tokens.

## Solution: Full Variable Bridge

### File structure

New file: `src/styles/reactodia-theme.css`  
Imported once at the top of `src/index.css`.  
All existing Reactodia overrides in `.reactodia-workspace` / `.reactodia-workspace-dark` in `index.css` move into this file (no duplication).

### Three sections

#### Section 1 — Color variable bridge (`.reactodia-workspace` / `.reactodia-workspace-dark`)

Map every safe `--reactodia-*` color variable to the app's shadcn tokens. Both light and dark variants.

| Reactodia variable | Light value | Dark value |
|---|---|---|
| `--reactodia-background-color` | `var(--canvas-bg)` | `var(--canvas-bg)` |
| `--reactodia-background-color-surface` | `var(--glass-surface)` | `var(--glass-surface)` |
| `--reactodia-font-color-base` | `var(--foreground)` | `var(--foreground)` |
| `--reactodia-font-color-base-inverse` | `var(--background)` | `var(--background)` |
| `--reactodia-border-color-base` | `var(--border)` | `var(--border)` |
| `--reactodia-input-background-color` | `var(--input)` | `var(--input)` |
| `--reactodia-input-background-color-disabled` | `var(--muted)` | `var(--muted)` |
| `--reactodia-input-color` | `var(--foreground)` | `var(--foreground)` |
| `--reactodia-input-color-placeholder` | `var(--muted-foreground)` | `var(--muted-foreground)` |
| `--reactodia-input-border-color` | `var(--border)` | `var(--border)` |
| `--reactodia-input-border-color-focus` | `var(--ring)` | `var(--ring)` |
| `--reactodia-button-default-color` | `var(--foreground)` | `var(--foreground)` |
| `--reactodia-button-default-color-focus` | `var(--foreground)` | `var(--foreground)` |
| `--reactodia-button-default-background-color` | `var(--glass-surface)` | `var(--glass-surface)` |
| `--reactodia-button-default-background-color-focus` | `var(--muted)` | `var(--muted)` |
| `--reactodia-button-default-background-color-active` | `oklch(67.5% 0.123 290.4 / 0.18)` | `oklch(62% 0.145 289.1 / 0.25)` |
| `--reactodia-button-default-border-color` | `var(--glass-border-color)` | `var(--glass-border-color)` |
| `--reactodia-color-primary` | `var(--primary)` | `var(--primary)` |
| `--reactodia-color-primary-contrast-foreground` | `var(--primary-foreground)` | `var(--primary-foreground)` |
| `--reactodia-color-danger` | `var(--destructive)` | `var(--destructive)` |
| `--reactodia-color-danger-contrast-foreground` | `var(--destructive-foreground)` | `var(--destructive-foreground)` |
| `--reactodia-color-emphasis-0` | `var(--background)` | `var(--background)` |
| `--reactodia-color-emphasis-100` | `var(--muted)` | `var(--muted)` |
| `--reactodia-color-emphasis-200..900` | stepped oklch from muted → foreground | same |
| `--reactodia-color-emphasis-1000` | `var(--foreground)` | `var(--foreground)` |
| `--reactodia-color-gray-0` | `var(--background)` | `var(--background)` |
| `--reactodia-color-gray-100..900` | stepped from background → foreground | same |
| `--reactodia-color-gray-1000` | `var(--foreground)` | `var(--foreground)` |
| `--reactodia-color-content` | `var(--foreground)` | `var(--foreground)` |
| `--reactodia-color-content-contrast` | `var(--background)` | `var(--background)` |
| `--reactodia-dialog-border-color` | `var(--border)` | `var(--border)` |
| `--reactodia-canvas-overlay-color` | `rgba(0,0,0,0.6)` | `rgba(0,0,0,0.75)` |
| `--reactodia-canvas-box-shadow` | `var(--glass-shadow)` | `var(--glass-shadow)` |
| `--reactodia-navigator-background-fill` | `var(--glass-surface)` | `var(--glass-surface)` |
| `--reactodia-navigator-viewport-stroke-color` | `oklch(67.5% 0.123 290.4 / 0.5)` | `oklch(62% 0.145 289.1 / 0.6)` |
| `--reactodia-selection-single-box-color` | `var(--primary)` | `var(--primary)` |
| `--reactodia-selection-single-box-shadow` | `0 0 0 2px var(--ring)` | `0 0 0 2px var(--ring)` |
| `--reactodia-tree-background-color-active` | `var(--muted)` | `var(--muted)` |
| `--reactodia-tree-background-color-focus` | `oklch(67.5% 0.123 290.4 / 0.12)` | `oklch(62% 0.145 289.1 / 0.15)` |
| `--reactodia-tree-border-color-active` | `var(--border)` | `var(--border)` |
| `--reactodia-tree-border-color-focus` | `var(--ring)` | `var(--ring)` |
| `--reactodia-inline-entity-color` | `var(--primary)` | `var(--primary)` |
| `--reactodia-standard-group-color` | `var(--muted-foreground)` | `var(--muted-foreground)` |
| `--reactodia-link-stroke-color` | `var(--edge-default)` | `var(--edge-default)` |
| `--reactodia-selection-link-color` | `var(--primary)` | `var(--primary)` |
| `--reactodia-monochrome-icon-filter` | `none` | `invert(1) brightness(0.8)` |

#### Section 2 — Dialog solid-surface override (`.reactodia-dialog` scope only)

```css
.reactodia-dialog {
  --reactodia-background-color-surface: var(--card);
  --reactodia-border-color-base: var(--border);
  --reactodia-font-color-base: var(--foreground);
}
```

**Rules:**
- Only overrides CSS variables — no layout properties.
- No `backdrop-filter`, `filter`, `transform`, `opacity`, `isolation`, or `will-change` added.
- No `position`, `z-index`, `inset`, `margin`, `padding`, `width`, `height` touched.
- The dialog solid background is achieved solely by changing `--reactodia-background-color-surface` to `var(--card)` in this scope, not by adding new CSS properties to `.reactodia-dialog`.

#### Section 3 — Native form element resets inside Reactodia overlays

Scope: `.reactodia-dialog select, .reactodia-dialog input, .reactodia-dialog textarea` and the instances-search / property-editor list items.

These elements use browser defaults + Reactodia gray scale. We add minimal color-only overrides:
- `background-color: var(--input)`
- `color: var(--foreground)`
- `border-color: var(--border)`
- Option elements: `background-color: var(--card); color: var(--foreground)`

No sizing, padding, border-radius, or layout properties changed.

### Hard constraints — never violated

These variables are **never touched** (layout/positioning/timing):

- `--reactodia-z-index-base`
- `--reactodia-dock-*`
- `--reactodia-halo-*` (runtime-set by Reactodia JS)
- `--reactodia-spacing-*`
- `--reactodia-toolbar-height`
- `--reactodia-viewport-dock-margin`
- `--reactodia-selection-single-box-margin`
- `--reactodia-draggable-handle-*`
- `--reactodia-border-radius-*`
- `--reactodia-border-width-base`
- `--reactodia-font-size-base`
- `--reactodia-line-height-base`
- `--reactodia-transition-duration`
- `--reactodia-paper-panning-overlay-z-index`
- `--reactodia-dialog-viewport-breakpoint-s`
- `--reactodia-link-button-margin`, `--reactodia-link-button-size`
- `--reactodia-resizable-box-border-width`
- `--reactodia-accordion-transition-duration`

CSS properties never added to any `.reactodia-*` selector:
`position`, `z-index`, `top/left/right/bottom/inset`, `margin`, `padding`, `width`, `height`, `display`, `flex-*`, `grid-*`, `transform`, `backdrop-filter`, `filter`, `opacity`, `isolation`, `will-change`

### Migration: existing overrides in index.css

The existing Reactodia-related blocks in `index.css` (`.reactodia-workspace`, `.reactodia-workspace-dark`, all `.reactodia-btn*`, `.reactodia-toolbar*`, `.reactodia-selection-action*`) move into `reactodia-theme.css`. The `index.css` gets a single `@import './styles/reactodia-theme.css'` replacing those blocks.

### What is NOT changed

- `src/components/Canvas/LayoutPopover.tsx` — glass popover is intentional
- `src/components/Canvas/rdfPropertyEditor.tsx` — EntityEditor form is already shadcn
- `src/components/ui/dialog.tsx` and all shadcn primitives — untouched
- Any Reactodia JavaScript / component code
- Any layout, positioning, or sizing behavior

## Affected dialogs / surfaces (all fixed by CSS only)

| Surface | Current issue | Fix |
|---|---|---|
| `.reactodia-dialog` (Edit relation, etc.) | Semi-transparent, wrong form colors | Section 2 solid override + Section 3 form reset |
| DefaultPropertyEditor select/dropdown | Light gray bg in dark mode | Section 3 form reset + gray scale bridge |
| Halo selection actions | Uses Reactodia default button colors | Section 1 button variable bridge |
| Instances search panel | Wrong background/input colors | Section 1 input/bg bridge |
| Navigator mini-map | Already partially themed | Section 1 navigator bridge |
| Connection wizard (if opened) | Wrong surface colors | Section 1 bg-surface bridge |
| Tree views (class tree, etc.) | Wrong active/focus highlights | Section 1 tree bridge |
