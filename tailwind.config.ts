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
        'background': 'var(--background)',
        'foreground': 'var(--foreground)',

        // Surface
        'card': 'var(--card)',
        'card-foreground': 'var(--card-foreground)',
        'popover': 'var(--popover)',
        'popover-foreground': 'var(--popover-foreground)',

        // Brand
        'primary': 'var(--primary)',
        'primary-foreground': 'var(--primary-foreground)',
        'primary-hover': 'var(--primary-hover)',

        'secondary': 'var(--secondary)',
        'secondary-foreground': 'var(--secondary-foreground)',
        'secondary-hover': 'var(--secondary-hover)',

        'accent': 'var(--accent)',
        'accent-foreground': 'var(--accent-foreground)',
        'accent-hover': 'var(--accent-hover)',

        // Muted / Destructive / Inputs
        'muted': 'var(--muted)',
        'muted-foreground': 'var(--muted-foreground)',
        'destructive': 'var(--destructive)',
        'destructive-foreground': 'var(--destructive-foreground)',

        // Borders / Inputs / Rings
        'border': 'var(--border)',
        'input': 'var(--input)',
        'ring': 'var(--ring)',

        // Canvas / card helper
        'canvas-bg': 'var(--canvas-bg)',
        'canvas-grid': 'var(--canvas-grid)',

        // Additional tokens that appear in code
        'sidebar-border': 'var(--glass-border)',
      },
    },
  },
  plugins: [],
}
