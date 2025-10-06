/** Tailwind config mapping CSS variables to color tokens so classes like
 *  bg-background, text-foreground, border-border, bg-card, etc. are generated.
 *
 *  This uses the CSS variables defined in src/index.css (e.g. --background,
 *  --foreground, --border, etc.) and exposes them as Tailwind colors that
 *  support the `/alpha` opacity slash syntax.
 */

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Core
        'background': 'oklch(var(--background) / <alpha-value>)',
        'foreground': 'oklch(var(--foreground) / <alpha-value>)',

        // Surface
        'card': 'oklch(var(--card) / <alpha-value>)',
        'card-foreground': 'oklch(var(--card-foreground) / <alpha-value>)',
        'popover': 'oklch(var(--popover) / <alpha-value>)',
        'popover-foreground': 'oklch(var(--popover-foreground) / <alpha-value>)',

        // Brand
        'primary': 'oklch(var(--primary) / <alpha-value>)',
        'primary-foreground': 'oklch(var(--primary-foreground) / <alpha-value>)',
        'primary-hover': 'oklch(var(--primary-hover) / <alpha-value>)',

        'secondary': 'oklch(var(--secondary) / <alpha-value>)',
        'secondary-foreground': 'oklch(var(--secondary-foreground) / <alpha-value>)',
        'secondary-hover': 'oklch(var(--secondary-hover) / <alpha-value>)',

        'accent': 'oklch(var(--accent) / <alpha-value>)',
        'accent-foreground': 'oklch(var(--accent-foreground) / <alpha-value>)',
        'accent-hover': 'oklch(var(--accent-hover) / <alpha-value>)',

        // Muted / Destructive / Inputs
        'muted': 'oklch(var(--muted) / <alpha-value>)',
        'muted-foreground': 'oklch(var(--muted-foreground) / <alpha-value>)',
        'destructive': 'oklch(var(--destructive) / <alpha-value>)',
        'destructive-foreground': 'oklch(var(--destructive-foreground) / <alpha-value>)',

        // Borders / Inputs / Rings
        'border': 'oklch(var(--border) / <alpha-value>)',
        'input': 'oklch(var(--input) / <alpha-value>)',
        'ring': 'oklch(var(--ring) / <alpha-value>)',

        // Canvas / card helper
        'canvas-bg': 'oklch(var(--canvas-bg) / <alpha-value>)',
        'canvas-grid': 'oklch(var(--canvas-grid) / <alpha-value>)',

        // Additional tokens that appear in code
        'sidebar-border': 'oklch(var(--glass-border) / <alpha-value>)',
      },
    },
  },
  plugins: [],
}
