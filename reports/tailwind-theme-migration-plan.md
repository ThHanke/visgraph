Tailwind migration & theme improvement plan — visual inspection report
=====================================================================

Context
-------
I rendered the app in both light and dark modes using the provided demo TTL and inspected the UI carefully. The dev server pages used:
- Light: http://localhost:8080/?rdfUrl=https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/refs/heads/main/LengthMeasurement.ttl
- Dark: http://localhost:8080/?theme=dark&rdfUrl=https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/refs/heads/main/LengthMeasurement.ttl

Observed problems (summary)
---------------------------
- Overall layout is fine and many components now use Tailwind utilities.
- Still present:
  - Several small text fragments and annotation labels use non-theme colors or inline styles, producing low contrast in dark mode.
  - Some badges/chips still use JS color math (darken) which creates inconsistent badge background/border across themes.
  - A few components still rely on inline background styles or leftover global presentational CSS rather than theme tokens (makes scanning by Tailwind incomplete).
  - React Flow micro-styling: chips, tiny labels and subtle borders/shadows are too faint in dark mode and inconsistent across node types.
  - Dialog/popover sizing: occasional overflow/long-label issues (max-height/overflow-y may need tightening).
  - A small number of dynamic classes could be missed by Tailwind's scanner during migration.

A clear, modern theme idea (clever & nice)
------------------------------------------
Goal: consistent, readable, slightly "soft" aesthetic with clear hierarchy and strong accessibility in dark mode.

- Use HSL-based CSS variables as canonical tokens (already present). Keep variables in :root and .dark.
- Palette intentions:
  - Backgrounds: very subtle tinted surfaces instead of pure grayscale (e.g., canvas light: hsl(210 20% 98%), canvas dark: hsl(214 18% 10%)).
  - Primary: gentle saturated blue/purple for action accent (HSL variable: --primary), tuned slightly desaturated in dark theme to avoid eye-strain.
  - Accent / secondary: soft mint/green for "success/info"-ish chips.
  - Muted: use lower-contrast HSL tokens for secondary text; increase contrast in dark mode.
- Treatment:
  - All small chips/badges use a two-layer approach:
    - left strip (namespace color) rendered as explicit element (we already added it).
    - badge body uses a token-driven subtle background (e.g., color-mix or CSS variable derived tone) and a thin border using a slightly darker variant (via CSS var).
  - Use rounded-md card surfaces, consistent shadow level (soft) set via CSS variable (--card-shadow).
  - Use consistent spacing scale mapped to Tailwind utility classes.
- Accessibility:
  - Make text-muted-foreground darker in dark mode so small labels remain readable (goal: WCAG AA on crucial items).
  - Prefer semibold for small chips to help readability.

Prioritized actionable checklist (what I recommend, with file targets)
----------------------------------------------------------------------
1) Replace JS darken() badge logic (HIGH)
   - Files: src/components/Canvas/CustomOntologyNode.tsx (and any other node files that compute hex color).
   - Action: remove darken() helper. Set CSS variables per-node:
     - --node-color: original namespace color
     - --node-badge-bg: a derived token (e.g., color-mix(in srgb, var(--node-color) 12%, hsl(var(--card))) or explicit fallback)
     - Use inline style for CSS variable assignment and use bg-[hsl(var(--node-badge-bg))] or style={{ background: 'hsl(var(--node-badge-bg))' }} for the badge.
   - Why: consistent across themes and Tailwind-friendly.
   - Est: 10–20 minutes.

2) Normalize text colors to theme tokens (CRITICAL)
   - Files: all src/components/Canvas/* + src/components/ui/*
   - Action: scan for hex literals and non-theme classes, replace with text-foreground / text-muted-foreground / text-primary / text-warning / text-destructive; dynamic colors -> CSS variables.
   - Est: 30–60 minutes initial sweep.

3) Replace inline presentation with Tailwind utilities (MEDIUM)
   - Files: Node renderers, CanvasToolbar, ReasoningReportModal, FloatingEdge, FloatingConnectionLine
   - Action: convert inline backgrounds/paddings to Tailwind classes; keep only dynamic color variables in style props.
   - Est: 30–60 minutes.

4) React Flow node/edge finalization (MEDIUM)
   - Files: src/components/Canvas/* (all node renderers), FloatingEdge, FloatingConnectionLine
   - Action: enforce explicit left-bar elements for all nodes; ensure node bodies, chips, labels use Tailwind utilities and CSS vars.
   - Est: 20–40 minutes.

5) Sweep ui/variants and tailor tailwind.config (MEDIUM)
   - Files: src/components/ui/buttonVariants.ts, badgeVariants.ts, card.tsx, avatar.tsx, etc.
   - Action: normalize variant tokens to refer to the CSS variables / Tailwind tokens defined in tailwind.config.ts. Add small safelist for unavoidable dynamic classes while migrating.
   - Est: 45–90 minutes.

6) Accessibility / contrast tuning (REQUIRED)
   - Files: src/index.css (tokens), then adjust components if needed.
   - Action: increase muted text in dark mode, test with demo TTL. Make token adjustments in :root and .dark, not component-level tweaks.
   - Est: 20–40 minutes.

7) Verification
   - For each batch, run dev server and build; test both theme states and capture screenshots. Fix regressions.
   - Est: 10–30 minutes per iteration.

Risk management and safety
--------------------------
- I will create backups (.bak) before changing any file (already done for main CSS files earlier).
- Make changes in small batches and re-run dev build / visual checks after each batch.
- Use a temporary Tailwind safelist while migrating; remove safelist when complete.

Deliverables I can produce next (pick one)
-----------------------------------------
- Option A — Implement step #1 now (replace badge darken), then capture and return light/dark screenshots and an annotated list of changes visible in the screenshots.
- Option B — Produce a file-by-file mapping of every non-theme color / inline style occurrence (Plan-only), i.e., a checklist you can review before edits.
- Option C — Proceed with the full sweep (steps 1–3) in batches, showing screenshots after each batch.

Which do you want next?
- Reply with "A — Proceed", "B — Map only", or "C — Full sweep" and I will run that action. If you pick A or C I will back up files and then make edits + capture screenshots; I'm already in Act mode and ready to proceed.

Task progress (current)
- [x] Backed up original CSS files
- [x] Minimalized src/index.css keeping theme tokens and essential structural rules
- [x] Create trimmed src/index.no-tailwind.css
- [x] Create trimmed src/reactflow-controls.css
- [x] Refactor CustomOntologyNode to use explicit left-bar and Tailwind classes
- [x] Refactor ResizableNamespaceLegend, ReasoningIndicator, CanvasToolbar to static classes
- [x] Refactor NodePropertyEditor to use Tailwind utilities
- [x] Refactor LinkPropertyEditor to use Tailwind utilities
- [ ] Refactor ReasoningReportModal further if needed
- [ ] Run production build and verify
