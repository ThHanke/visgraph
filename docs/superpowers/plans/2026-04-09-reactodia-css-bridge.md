# Reactodia CSS Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a single CSS file that fully bridges Reactodia's `--reactodia-*` variables to the app's shadcn design tokens, fixing dialog transparency, wrong dropdown colors, and inconsistent theming across all Reactodia UI — without touching any layout, positioning, or sizing properties.

**Architecture:** New file `src/styles/reactodia-theme.css` contains the full variable bridge in three sections: (1) color variable mappings for light/dark workspace scopes, (2) solid surface override scoped to `.reactodia-dialog` only, (3) native form element color resets inside Reactodia dialogs. All existing Reactodia overrides in `index.css` migrate into this file. No component changes.

**Tech Stack:** CSS custom properties, Tailwind CSS (via `@import`), oklch color tokens

---

## Hard Constraints — Must Never Be Violated

**Never override these variables** (layout/positioning/timing — Reactodia uses them for element placement):
`--reactodia-z-index-base`, `--reactodia-dock-*`, `--reactodia-halo-*`, `--reactodia-spacing-*`, `--reactodia-toolbar-height`, `--reactodia-viewport-dock-margin`, `--reactodia-selection-single-box-margin`, `--reactodia-draggable-handle-*`, `--reactodia-border-radius-*`, `--reactodia-border-width-base`, `--reactodia-font-size-base`, `--reactodia-line-height-base`, `--reactodia-transition-duration`, `--reactodia-paper-panning-overlay-z-index`, `--reactodia-dialog-viewport-breakpoint-s`, `--reactodia-link-button-margin`, `--reactodia-link-button-size`, `--reactodia-resizable-box-border-width`, `--reactodia-accordion-transition-duration`

**Never add these CSS properties to any `.reactodia-*` selector:**
`position`, `z-index`, `top/left/right/bottom/inset`, `margin`, `padding`, `width`, `height`, `display`, `flex-*`, `grid-*`, `transform`, `backdrop-filter`, `filter` (except on `.reactodia-selection-action` which already uses it), `opacity`, `isolation`, `will-change`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/styles/reactodia-theme.css` | **Create** | All Reactodia CSS variable overrides and form element resets |
| `src/index.css` | **Modify** | Add `@import`, remove migrated Reactodia blocks |

---

## Task 1: Scaffold the new file and wire the import

**Files:**
- Create: `src/styles/reactodia-theme.css`
- Modify: `src/index.css`

- [ ] **Step 1: Create the styles directory and scaffold the new file**

Create `src/styles/reactodia-theme.css` with this exact content:

```css
/*
 * reactodia-theme.css
 *
 * Bridges Reactodia's --reactodia-* CSS variables to the app's shadcn design tokens.
 *
 * CONSTRAINTS — never override:
 *   layout/positioning: --reactodia-z-index-base, --reactodia-dock-*, --reactodia-halo-*,
 *     --reactodia-spacing-*, --reactodia-toolbar-height, --reactodia-viewport-dock-margin,
 *     --reactodia-selection-single-box-margin, --reactodia-draggable-handle-*,
 *     --reactodia-border-radius-*, --reactodia-border-width-base, --reactodia-font-size-base,
 *     --reactodia-line-height-base, --reactodia-transition-duration,
 *     --reactodia-paper-panning-overlay-z-index, --reactodia-dialog-viewport-breakpoint-s,
 *     --reactodia-link-button-margin, --reactodia-link-button-size,
 *     --reactodia-resizable-box-border-width, --reactodia-accordion-transition-duration
 *
 *   CSS properties: position, z-index, inset, margin, padding, width, height, display,
 *     flex-*, grid-*, transform, backdrop-filter, filter (except selection-action),
 *     opacity, isolation, will-change
 *
 * Three sections:
 *   1. Color variable bridge  (.reactodia-workspace / .reactodia-workspace-dark)
 *   2. Dialog solid surface   (.reactodia-dialog)
 *   3. Form element resets    (.reactodia-dialog form elements)
 */

/* ============================================================
   SECTION 1 — COLOR VARIABLE BRIDGE
   ============================================================ */

/* placeholder — filled in Tasks 2, 3, 4 */

/* ============================================================
   SECTION 2 — DIALOG SOLID SURFACE
   ============================================================ */

/* placeholder — filled in Task 5 */

/* ============================================================
   SECTION 3 — FORM ELEMENT RESETS
   ============================================================ */

/* placeholder — filled in Task 6 */
```

- [ ] **Step 2: Add `@import` at the top of `src/index.css` (after the tailwindcss import)**

In `src/index.css`, after the line `@import 'tailwindcss';`, add:

```css
@import './styles/reactodia-theme.css';
```

The top of `src/index.css` should now read:
```css
@config "../tailwind.config.ts";
@import 'tailwindcss';
@import './styles/reactodia-theme.css';
```

- [ ] **Step 3: Verify the app still builds**

```bash
cd /home/hanke/visgraph && npm run build 2>&1 | tail -20
```

Expected: build completes with no errors. CSS import resolves correctly.

---

## Task 2: Migrate existing Reactodia overrides from index.css

**Files:**
- Modify: `src/styles/reactodia-theme.css`
- Modify: `src/index.css`

Move the existing Reactodia-specific blocks out of `src/index.css` into the new file. These are the blocks currently at the bottom of `index.css` starting at "Reactodia toolbar overrides".

- [ ] **Step 1: Replace the placeholder comment in Section 1 of `reactodia-theme.css` with the migrated blocks**

In `src/styles/reactodia-theme.css`, replace `/* placeholder — filled in Tasks 2, 3, 4 */` with:

```css
/* ── Toolbar ────────────────────────────────────────────────── */
/* The .reactodia-toolbar wrapper is kept (required by Reactodia for dock positioning)
   but its background is removed so it is transparent. */
.reactodia-toolbar {
  background: transparent !important;
  border: none !important;
  box-shadow: none !important;
  padding: 0 !important;
}

/* ── Light workspace ─────────────────────────────────────────── */
.reactodia-workspace {
  /* Buttons */
  --reactodia-button-default-background-color: var(--glass-surface);
  --reactodia-button-default-background-color-focus: rgba(255, 255, 255, 0.80);
  --reactodia-button-default-background-color-active: oklch(67.5% 0.123 290.4 / 0.18);
  --reactodia-button-default-border-color: var(--glass-border-color);
  --reactodia-button-default-color: var(--foreground);
  --reactodia-button-default-color-focus: var(--foreground);
  /* Surfaces */
  --reactodia-background-color-surface: var(--glass-surface);
  --reactodia-border-color-base: var(--glass-border-color);
  /* Inputs */
  --reactodia-input-background-color: rgba(255, 255, 255, 0.4);
  --reactodia-input-color: var(--foreground);
  --reactodia-input-color-placeholder: var(--muted-foreground);
  --reactodia-input-border-color: var(--glass-border-color);
  /* Navigator/minimap */
  --reactodia-navigator-background-fill: var(--glass-surface);
  --reactodia-navigator-viewport-stroke-color: oklch(67.5% 0.123 290.4 / 0.5);
  /* Canvas background */
  --reactodia-background-color: var(--canvas-bg);
}

/* ── Dark workspace ──────────────────────────────────────────── */
.reactodia-workspace-dark {
  /* Buttons */
  --reactodia-button-default-background-color: var(--glass-surface);
  --reactodia-button-default-background-color-focus: rgba(50, 60, 85, 0.80);
  --reactodia-button-default-background-color-active: oklch(62% 0.145 289.1 / 0.25);
  --reactodia-button-default-border-color: var(--glass-border-color);
  --reactodia-button-default-color: var(--foreground);
  --reactodia-button-default-color-focus: var(--foreground);
  /* Surfaces */
  --reactodia-background-color-surface: var(--glass-surface);
  --reactodia-border-color-base: var(--glass-border-color);
  /* Inputs */
  --reactodia-input-background-color: rgba(30, 35, 50, 0.50);
  --reactodia-input-color: var(--foreground);
  --reactodia-input-color-placeholder: var(--muted-foreground);
  --reactodia-input-border-color: var(--glass-border-color);
  /* Navigator/minimap */
  --reactodia-navigator-background-fill: rgba(30, 35, 50, 0.80);
  --reactodia-navigator-viewport-stroke-color: oklch(62% 0.145 289.1 / 0.6);
  /* Canvas background */
  --reactodia-background-color: var(--canvas-bg);
}

/* ── glass-btn inside our own groups (TopBar A-Box/T-Box, Reasoning) ── */
.reactodia-btn-group .glass-btn.glass-btn--active {
  background: rgba(124, 92, 228, 0.22) !important;
  border-color: rgba(124, 92, 228, 0.35) !important;
  color: var(--primary) !important;
  box-shadow: none !important;
}
.dark .reactodia-btn-group .glass-btn.glass-btn--active {
  background: rgba(140, 110, 240, 0.28) !important;
}

/* ── Hamburger dropdown panel ───────────────────────────────── */
.reactodia-toolbar__menu .reactodia-dropdown__content {
  background: var(--glass-surface) !important;
  border: 1px solid var(--glass-border-color) !important;
  border-radius: 10px !important;
  backdrop-filter: var(--glass-blur) !important;
  -webkit-backdrop-filter: var(--glass-blur) !important;
  box-shadow: var(--glass-shadow) !important;
  overflow: hidden !important;
  padding: 4px !important;
  z-index: 99999 !important;
}
.reactodia-toolbar__menu .reactodia-dropdown-menu__items {
  display: flex !important;
  flex-direction: column !important;
  gap: 2px !important;
}
.reactodia-toolbar__menu .reactodia-dropdown__content .reactodia-btn {
  border: none !important;
  background: transparent !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  box-shadow: none !important;
  border-radius: 7px !important;
  justify-content: flex-start !important;
  width: 100% !important;
  text-align: left !important;
  transform: none !important;
}
.reactodia-toolbar__menu .reactodia-dropdown__content .reactodia-btn:hover {
  background: rgba(124, 92, 228, 0.1) !important;
  color: var(--primary) !important;
  box-shadow: none !important;
}
.dark .reactodia-toolbar__menu .reactodia-dropdown__content .reactodia-btn:hover {
  background: rgba(140, 110, 240, 0.15) !important;
}

/* ── Focus-visible ring ──────────────────────────────────────── */
.glass-btn:focus-visible,
.rail-btn:focus-visible,
.reactodia-btn:focus-visible {
  outline: 2px solid var(--ring) !important;
  outline-offset: 2px !important;
}

/* ── Node halo ghost buttons ────────────────────────────────── */
.reactodia-selection-action {
  background-color: transparent !important;
}
.reactodia-selection-action:hover {
  background-color: rgba(124, 92, 228, 0.12) !important;
}
.dark .reactodia-selection-action:hover {
  background-color: rgba(140, 110, 240, 0.18) !important;
}
/* Dark mode: invert SVG sprite icons so they read as light on dark canvas */
.dark .reactodia-selection-action {
  filter: invert(1) !important;
}
.dark .reactodia-selection-action:hover {
  filter: invert(1) hue-rotate(240deg) !important;
}
```

- [ ] **Step 2: Remove the migrated blocks from `src/index.css`**

Delete everything from line `/* Reactodia toolbar overrides — glass theme */` to the end of the file in `src/index.css`. The file should now end after the `.dark .reactodia-btn-default.active { ... }` block (around line 510).

- [ ] **Step 3: Verify the app still builds and toolbar/halo still look correct**

```bash
cd /home/hanke/visgraph && npm run build 2>&1 | tail -10
```

Expected: build succeeds. In the browser: toolbar glass effect intact, halo actions still visible, hamburger dropdown still styled.

- [ ] **Step 4: Commit**

```bash
cd /home/hanke/visgraph && git add src/styles/reactodia-theme.css src/index.css && git commit -m "refactor(css): extract Reactodia overrides into reactodia-theme.css"
```

---

## Task 3: Add missing light mode color bridge

**Files:**
- Modify: `src/styles/reactodia-theme.css`

Extend the `.reactodia-workspace` block with the full gray scale, emphasis scale, primary/danger variants, and other missing color variables. These fix the light-gray form elements and wrong palette in Reactodia's native UI.

- [ ] **Step 1: Add the extended light mode variables to `.reactodia-workspace` in `reactodia-theme.css`**

Append these lines inside the existing `.reactodia-workspace { }` block (after `--reactodia-background-color: var(--canvas-bg);`):

```css
  /* Font */
  --reactodia-font-color-base: var(--foreground);
  --reactodia-font-color-base-inverse: var(--background);
  /* Content */
  --reactodia-color-content: var(--foreground);
  --reactodia-color-content-contrast: var(--background);
  --reactodia-color-content-inverse: var(--background);
  /* Canvas */
  --reactodia-canvas-box-shadow: var(--glass-shadow);
  --reactodia-canvas-overlay-color: rgba(0, 0, 0, 0.60);
  /* Input (extended) */
  --reactodia-input-background-color-disabled: var(--muted);
  --reactodia-input-border-color-focus: var(--ring);
  /* Dialog border */
  --reactodia-dialog-border-color: var(--border);
  /* Inline entity / group */
  --reactodia-inline-entity-color: var(--primary);
  --reactodia-standard-group-color: var(--muted-foreground);
  --reactodia-link-stroke-color: var(--edge-default);
  --reactodia-selection-link-color: var(--primary);
  /* Tree */
  --reactodia-tree-background-color-active: var(--muted);
  --reactodia-tree-background-color-focus: oklch(67.5% 0.123 290.4 / 0.12);
  --reactodia-tree-border-color-active: var(--border);
  --reactodia-tree-border-color-focus: var(--ring);
  /* Primary color scale */
  --reactodia-color-primary: var(--primary);
  --reactodia-color-primary-contrast-background: oklch(100% 0 0);
  --reactodia-color-primary-contrast-foreground: oklch(100% 0 0);
  --reactodia-color-primary-light:    oklch(77%   0.100 290.4);
  --reactodia-color-primary-lighter:  oklch(85%   0.070 290.4);
  --reactodia-color-primary-lightest: oklch(92%   0.040 290.4);
  --reactodia-color-primary-dark:     oklch(60%   0.140 290.4);
  --reactodia-color-primary-darker:   oklch(52%   0.150 290.4);
  --reactodia-color-primary-darkest:  oklch(44%   0.150 290.4);
  /* Danger/destructive color scale */
  --reactodia-color-danger: var(--destructive);
  --reactodia-color-danger-contrast-background: oklch(100% 0 0);
  --reactodia-color-danger-contrast-foreground: oklch(100% 0 0);
  --reactodia-color-danger-light:    oklch(83%   0.085  9.2);
  --reactodia-color-danger-lighter:  oklch(90%   0.055  9.2);
  --reactodia-color-danger-lightest: oklch(95%   0.030  9.2);
  --reactodia-color-danger-dark:     oklch(65%   0.130  9.2);
  --reactodia-color-danger-darker:   oklch(55%   0.140  9.2);
  --reactodia-color-danger-darkest:  oklch(45%   0.140  9.2);
  /* Gray scale (0=lightest/background → 1000=darkest/foreground) */
  --reactodia-color-gray-0:    oklch(98.4% 0.002 247.8); /* --background */
  --reactodia-color-gray-100:  oklch(95%   0.004 250.0);
  --reactodia-color-gray-200:  oklch(88%   0.008 252.0);
  --reactodia-color-gray-300:  oklch(78%   0.015 254.0);
  --reactodia-color-gray-400:  oklch(67%   0.022 255.0);
  --reactodia-color-gray-500:  oklch(58%   0.028 256.0); /* --muted-foreground */
  --reactodia-color-gray-600:  oklch(50%   0.033 256.5);
  --reactodia-color-gray-700:  oklch(43%   0.038 257.0);
  --reactodia-color-gray-800:  oklch(35%   0.041 257.0);
  --reactodia-color-gray-900:  oklch(28%   0.043 257.0);
  --reactodia-color-gray-1000: oklch(25%   0.045 256.8); /* --foreground */
  /* Emphasis scale (same progression as gray in light mode) */
  --reactodia-color-emphasis-0:    oklch(98.4% 0.002 247.8);
  --reactodia-color-emphasis-100:  oklch(95%   0.004 250.0);
  --reactodia-color-emphasis-200:  oklch(88%   0.008 252.0);
  --reactodia-color-emphasis-300:  oklch(78%   0.015 254.0);
  --reactodia-color-emphasis-400:  oklch(67%   0.022 255.0);
  --reactodia-color-emphasis-500:  oklch(58%   0.028 256.0);
  --reactodia-color-emphasis-600:  oklch(50%   0.033 256.5);
  --reactodia-color-emphasis-700:  oklch(43%   0.038 257.0);
  --reactodia-color-emphasis-800:  oklch(35%   0.041 257.0);
  --reactodia-color-emphasis-900:  oklch(28%   0.043 257.0);
  --reactodia-color-emphasis-1000: oklch(25%   0.045 256.8);
  /* Selection */
  --reactodia-selection-single-box-color: var(--primary);
  --reactodia-selection-single-box-shadow: 0 0 0 2px var(--ring);
  --reactodia-selection-multiple-box-shadow: 0 0 0 1px var(--ring);
```

- [ ] **Step 2: Build and verify**

```bash
cd /home/hanke/visgraph && npm run build 2>&1 | tail -10
```

Expected: build succeeds with no CSS errors.

---

## Task 4: Add missing dark mode color bridge

**Files:**
- Modify: `src/styles/reactodia-theme.css`

- [ ] **Step 1: Append the extended dark mode variables to `.reactodia-workspace-dark`**

Inside the existing `.reactodia-workspace-dark { }` block, after `--reactodia-background-color: var(--canvas-bg);`, add:

```css
  /* Font */
  --reactodia-font-color-base: var(--foreground);
  --reactodia-font-color-base-inverse: var(--background);
  /* Content */
  --reactodia-color-content: var(--foreground);
  --reactodia-color-content-contrast: var(--background);
  --reactodia-color-content-inverse: var(--background);
  /* Canvas */
  --reactodia-canvas-box-shadow: var(--glass-shadow);
  --reactodia-canvas-overlay-color: rgba(0, 0, 0, 0.75);
  /* Input (extended) */
  --reactodia-input-background-color-disabled: var(--muted);
  --reactodia-input-border-color-focus: var(--ring);
  /* Dialog border */
  --reactodia-dialog-border-color: var(--border);
  /* Inline entity / group */
  --reactodia-inline-entity-color: var(--primary);
  --reactodia-standard-group-color: var(--muted-foreground);
  --reactodia-link-stroke-color: var(--edge-default);
  --reactodia-selection-link-color: var(--primary);
  /* Tree */
  --reactodia-tree-background-color-active: var(--muted);
  --reactodia-tree-background-color-focus: oklch(62% 0.145 289.1 / 0.15);
  --reactodia-tree-border-color-active: var(--border);
  --reactodia-tree-border-color-focus: var(--ring);
  /* Primary color scale */
  --reactodia-color-primary: var(--primary);
  --reactodia-color-primary-contrast-background: oklch(100% 0 0);
  --reactodia-color-primary-contrast-foreground: oklch(100% 0 0);
  --reactodia-color-primary-light:    oklch(72%   0.120 289.1);
  --reactodia-color-primary-lighter:  oklch(80%   0.090 289.1);
  --reactodia-color-primary-lightest: oklch(88%   0.060 289.1);
  --reactodia-color-primary-dark:     oklch(54%   0.160 289.1);
  --reactodia-color-primary-darker:   oklch(46%   0.160 289.1);
  --reactodia-color-primary-darkest:  oklch(38%   0.150 289.1);
  /* Danger/destructive color scale */
  --reactodia-color-danger: var(--destructive);
  --reactodia-color-danger-contrast-background: oklch(100% 0 0);
  --reactodia-color-danger-contrast-foreground: oklch(100% 0 0);
  --reactodia-color-danger-light:    oklch(83%   0.085  9.2);
  --reactodia-color-danger-lighter:  oklch(90%   0.055  9.2);
  --reactodia-color-danger-lightest: oklch(95%   0.030  9.2);
  --reactodia-color-danger-dark:     oklch(65%   0.130  9.2);
  --reactodia-color-danger-darker:   oklch(55%   0.140  9.2);
  --reactodia-color-danger-darkest:  oklch(45%   0.140  9.2);
  /* Gray scale (0=darkest/background → 1000=lightest/foreground in dark mode) */
  --reactodia-color-gray-0:    oklch(18.7% 0.017 256.8); /* --background */
  --reactodia-color-gray-100:  oklch(23.0% 0.020 256.8); /* --card */
  --reactodia-color-gray-200:  oklch(26.1% 0.022 256.8); /* --muted */
  --reactodia-color-gray-300:  oklch(31.1% 0.025 256.8); /* --node-border */
  --reactodia-color-gray-400:  oklch(38.8% 0.028 256.8); /* --border */
  --reactodia-color-gray-500:  oklch(50.0% 0.025 256.0);
  --reactodia-color-gray-600:  oklch(62.0% 0.020 252.0);
  --reactodia-color-gray-700:  oklch(72.0% 0.014 250.0);
  --reactodia-color-gray-800:  oklch(82.3% 0.016 256.7); /* --muted-foreground */
  --reactodia-color-gray-900:  oklch(91.0% 0.008 248.0);
  --reactodia-color-gray-1000: oklch(96.1% 0.004 247.9); /* --foreground */
  /* Emphasis scale */
  --reactodia-color-emphasis-0:    oklch(18.7% 0.017 256.8);
  --reactodia-color-emphasis-100:  oklch(23.0% 0.020 256.8);
  --reactodia-color-emphasis-200:  oklch(26.1% 0.022 256.8);
  --reactodia-color-emphasis-300:  oklch(31.1% 0.025 256.8);
  --reactodia-color-emphasis-400:  oklch(38.8% 0.028 256.8);
  --reactodia-color-emphasis-500:  oklch(50.0% 0.025 256.0);
  --reactodia-color-emphasis-600:  oklch(62.0% 0.020 252.0);
  --reactodia-color-emphasis-700:  oklch(72.0% 0.014 250.0);
  --reactodia-color-emphasis-800:  oklch(82.3% 0.016 256.7);
  --reactodia-color-emphasis-900:  oklch(91.0% 0.008 248.0);
  --reactodia-color-emphasis-1000: oklch(96.1% 0.004 247.9);
  /* Selection */
  --reactodia-selection-single-box-color: var(--primary);
  --reactodia-selection-single-box-shadow: 0 0 0 2px var(--ring);
  --reactodia-selection-multiple-box-shadow: 0 0 0 1px var(--ring);
```

- [ ] **Step 2: Build and verify**

```bash
cd /home/hanke/visgraph && npm run build 2>&1 | tail -10
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
cd /home/hanke/visgraph && git add src/styles/reactodia-theme.css && git commit -m "feat(css): add full Reactodia color variable bridge for light and dark modes"
```

---

## Task 5: Dialog solid-surface override

**Files:**
- Modify: `src/styles/reactodia-theme.css`

This is the fix for dialog transparency. We scope `--reactodia-background-color-surface` to `var(--card)` (solid) inside `.reactodia-dialog` only. Toolbars and canvas panels keep their glass surface.

**Critical:** Only CSS variable overrides inside `.reactodia-dialog`. No new CSS properties added to the selector itself — that would break stacking context.

- [ ] **Step 1: Replace the Section 2 placeholder in `reactodia-theme.css`**

Replace `/* placeholder — filled in Task 5 */` with:

```css
/*
 * Override --reactodia-background-color-surface to solid only inside .reactodia-dialog.
 * Toolbar, navigator, and canvas-level panels keep the glass surface (set in Section 1).
 *
 * IMPORTANT: Only variable overrides here.
 * Do NOT add backdrop-filter, filter, transform, opacity, or any layout property
 * to .reactodia-dialog — that would create a new stacking context and break
 * child z-index / dialog positioning.
 */
.reactodia-dialog {
  --reactodia-background-color-surface: var(--card);
  --reactodia-border-color-base: var(--border);
  --reactodia-font-color-base: var(--foreground);
  --reactodia-input-background-color: var(--input);
  --reactodia-input-border-color: var(--border);
  --reactodia-input-color: var(--foreground);
  --reactodia-input-color-placeholder: var(--muted-foreground);
}
```

- [ ] **Step 2: Build and visually verify dialog is solid**

```bash
cd /home/hanke/visgraph && npm run build 2>&1 | tail -10
```

Open the app in the browser and trigger the "Edit relation" dialog (click on a link between two nodes, then click edit). Verify:
- Dialog background is solid (no canvas bleeding through)
- Dialog position and size are unchanged
- Close button still works
- No layout shifts on the canvas behind the dialog

---

## Task 6: Form element resets inside Reactodia dialogs

**Files:**
- Modify: `src/styles/reactodia-theme.css`

The `DefaultPropertyEditor` (relation editor) uses native HTML `<select>` elements. Reactodia's gray color scale now maps to our theme tokens, but the browser's native `<select>` option list can still render with system colors. This section forces color-only overrides on those elements.

**Critical:** Only color/background/border-color properties. No sizing, padding, border-radius, or layout.

- [ ] **Step 1: Replace the Section 3 placeholder in `reactodia-theme.css`**

Replace `/* placeholder — filled in Task 6 */` with:

```css
/*
 * Color-only resets for native form elements inside Reactodia dialogs.
 * Only background-color, color, border-color are set. No sizing/layout properties.
 */

/* Inputs and textareas */
.reactodia-dialog input,
.reactodia-dialog textarea {
  background-color: var(--input);
  color: var(--foreground);
  border-color: var(--border);
}
.reactodia-dialog input::placeholder,
.reactodia-dialog textarea::placeholder {
  color: var(--muted-foreground);
}
.reactodia-dialog input:focus,
.reactodia-dialog textarea:focus {
  border-color: var(--ring);
  outline-color: var(--ring);
}

/* Native select elements (used by DefaultPropertyEditor relation type picker) */
.reactodia-dialog select {
  background-color: var(--input);
  color: var(--foreground);
  border-color: var(--border);
}
.reactodia-dialog select option {
  background-color: var(--card);
  color: var(--foreground);
}
.reactodia-dialog select option:checked,
.reactodia-dialog select option:hover {
  background-color: var(--muted);
  color: var(--foreground);
}

/* Scrollbars inside Reactodia dialog panels */
.reactodia-dialog ::-webkit-scrollbar-track {
  background-color: var(--muted);
}
.reactodia-dialog ::-webkit-scrollbar-thumb {
  background-color: var(--border);
}
.reactodia-dialog ::-webkit-scrollbar-thumb:hover {
  background-color: var(--muted-foreground);
}
```

- [ ] **Step 2: Build and verify**

```bash
cd /home/hanke/visgraph && npm run build 2>&1 | tail -10
```

Expected: build succeeds.

- [ ] **Step 3: Visual check — relation editor dropdown**

Open the app. Click a link, trigger "Edit relation". Open the relation type dropdown. Verify:
- Dropdown list items have dark background in dark mode
- Selected item is highlighted with `--muted` background (not browser default blue)
- Text is readable (light text on dark background in dark mode)
- Dialog position has not changed
- Canvas elements behind the dialog are not visible through it

- [ ] **Step 4: Visual check — entity editor**

Click a node, trigger "Edit entity". Verify:
- Input fields use `--input` background (slightly lighter than card)
- Placeholder text is muted
- Type autocomplete inputs look consistent with the rest of the form

- [ ] **Step 5: Visual check — light mode**

Switch to light mode (if toggle available) or check with browser devtools. Verify:
- Dialog background is solid white/card color
- Form elements use light mode tokens
- No contrast issues

- [ ] **Step 6: Commit**

```bash
cd /home/hanke/visgraph && git add src/styles/reactodia-theme.css && git commit -m "feat(css): fix dialog solid surface and form element colors in Reactodia dialogs"
```

---

## Task 7: Final verification across all affected surfaces

No file changes. Verification only.

- [ ] **Step 1: Verify toolbar and navigation (must not be broken)**

In the browser:
- Toolbar buttons still have glass effect (semi-transparent background)
- Hamburger menu dropdown still styled correctly (glass panel)
- Mini-map / navigator still renders with correct fill colors
- Node halo actions (edit/delete/connect icons) still visible and correctly colored
- Focus ring appears on keyboard navigation (`Tab` key)

- [ ] **Step 2: Verify instances search / tree panels (if accessible)**

If a Reactodia sidebar panel or instances search opens, verify:
- Background uses themed surface (not pure white in dark mode)
- Tree active/focus highlights use primary color
- Input fields themed correctly

- [ ] **Step 3: Verify canvas element positioning is intact**

- Drag nodes around the canvas — no layout shifts
- Resize a group node — handles still work
- Open and close the relation editor dialog multiple times — position always centered on canvas overlay
- The dialog close button (×) is in the correct position
- No z-index stacking issues (dialog should appear above canvas, below tooltips)

- [ ] **Step 4: Final commit if any adjustments were made during verification**

```bash
cd /home/hanke/visgraph && git add -p && git commit -m "fix(css): adjust Reactodia theme bridge after visual verification"
```
