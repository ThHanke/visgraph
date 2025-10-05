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
        'background': 'hsl(var(--background) / <alpha-value>)',
        'foreground': 'hsl(var(--foreground) / <alpha-value>)',

        // Surface
        'card': 'hsl(var(--card) / <alpha-value>)',
        'card-foreground': 'hsl(var(--card-foreground) / <alpha-value>)',
        'popover': 'hsl(var(--popover) / <alpha-value>)',
        'popover-foreground': 'hsl(var(--popover-foreground) / <alpha-value>)',

        // Brand
        'primary': 'hsl(var(--primary) / <alpha-value>)',
        'primary-foreground': 'hsl(var(--primary-foreground) / <alpha-value>)',
        'primary-hover': 'hsl(var(--primary-hover) / <alpha-value>)',

        'secondary': 'hsl(var(--secondary) / <alpha-value>)',
        'secondary-foreground': 'hsl(var(--secondary-foreground) / <alpha-value>)',
        'secondary-hover': 'hsl(var(--secondary-hover) / <alpha-value>)',

        'accent': 'hsl(var(--accent) / <alpha-value>)',
        'accent-foreground': 'hsl(var(--accent-foreground) / <alpha-value>)',
        'accent-hover': 'hsl(var(--accent-hover) / <alpha-value>)',

        // Muted / Destructive / Inputs
        'muted': 'hsl(var(--muted) / <alpha-value>)',
        'muted-foreground': 'hsl(var(--muted-foreground) / <alpha-value>)',
        'destructive': 'hsl(var(--destructive) / <alpha-value>)',
        'destructive-foreground': 'hsl(var(--destructive-foreground) / <alpha-value>)',

        // Borders / Inputs / Rings
        'border': 'hsl(var(--border) / <alpha-value>)',
        'input': 'hsl(var(--input) / <alpha-value>)',
        'ring': 'hsl(var(--ring) / <alpha-value>)',

        // Canvas / card helper
        'canvas-bg': 'hsl(var(--canvas-bg) / <alpha-value>)',
        'canvas-grid': 'hsl(var(--canvas-grid) / <alpha-value>)',

        // Additional tokens that appear in code
        'sidebar-border': 'hsl(var(--glass-border) / <alpha-value>)',
      },
    },
  },
  plugins: [],
}
