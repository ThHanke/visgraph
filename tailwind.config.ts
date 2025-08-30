import type { Config } from "tailwindcss";

export default {
	darkMode: ["class"],
	content: [
		"./pages/**/*.{ts,tsx}",
		"./components/**/*.{ts,tsx}",
		"./app/**/*.{ts,tsx}",
		"./src/**/*.{ts,tsx}",
	],
	prefix: "",
	theme: {
		container: {
			center: true,
			padding: '2rem',
			screens: {
				'2xl': '1400px'
			}
		},
		extend: {
			colors: {
				border: 'hsl(var(--border))',
				input: 'hsl(var(--input))',
				ring: 'hsl(var(--ring))',
				background: 'hsl(var(--background))',
				foreground: 'hsl(var(--foreground))',
				primary: {
					DEFAULT: 'hsl(var(--primary))',
					foreground: 'hsl(var(--primary-foreground))',
					hover: 'hsl(var(--primary-hover))'
				},
				secondary: {
					DEFAULT: 'hsl(var(--secondary))',
					foreground: 'hsl(var(--secondary-foreground))',
					hover: 'hsl(var(--secondary-hover))'
				},
				destructive: {
					DEFAULT: 'hsl(var(--destructive))',
					foreground: 'hsl(var(--destructive-foreground))'
				},
				muted: {
					DEFAULT: 'hsl(var(--muted))',
					foreground: 'hsl(var(--muted-foreground))'
				},
				accent: {
					DEFAULT: 'hsl(var(--accent))',
					foreground: 'hsl(var(--accent-foreground))',
					hover: 'hsl(var(--accent-hover))'
				},
				popover: {
					DEFAULT: 'hsl(var(--popover))',
					foreground: 'hsl(var(--popover-foreground))'
				},
				card: {
					DEFAULT: 'hsl(var(--card))',
					foreground: 'hsl(var(--card-foreground))'
				},
				canvas: {
					bg: 'hsl(var(--canvas-bg))',
					grid: 'hsl(var(--canvas-grid))'
				},
				namespace: {
					lavender: 'hsl(var(--ns-lavender))',
					mint: 'hsl(var(--ns-mint))',
					peach: 'hsl(var(--ns-peach))',
					sky: 'hsl(var(--ns-sky))',
					rose: 'hsl(var(--ns-rose))',
					sage: 'hsl(var(--ns-sage))',
					cream: 'hsl(var(--ns-cream))',
					lilac: 'hsl(var(--ns-lilac))',
					seafoam: 'hsl(var(--ns-seafoam))',
					blush: 'hsl(var(--ns-blush))',
					periwinkle: 'hsl(var(--ns-periwinkle))',
					coral: 'hsl(var(--ns-coral))',
					eucalyptus: 'hsl(var(--ns-eucalyptus))',
					champagne: 'hsl(var(--ns-champagne))',
					orchid: 'hsl(var(--ns-orchid))',
					aqua: 'hsl(var(--ns-aqua))',
					apricot: 'hsl(var(--ns-apricot))',
					mauve: 'hsl(var(--ns-mauve))',
					'mint-cream': 'hsl(var(--ns-mint-cream))',
					powder: 'hsl(var(--ns-powder))',
					honey: 'hsl(var(--ns-honey))',
					thistle: 'hsl(var(--ns-thistle))'
				}
			},
			boxShadow: {
				'node': 'var(--node-shadow)',
				'glass': 'var(--glass-shadow)'
			},
			backdropBlur: {
				'glass': '20px'
			},
			animation: {
				'accordion-down': 'accordion-down 0.2s ease-out',
				'accordion-up': 'accordion-up 0.2s ease-out',
				'fade-in': 'fadeIn 0.3s ease-out',
				'slide-in': 'slideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
				'pulse-soft': 'pulseSoft 2s ease-in-out infinite'
			},
			borderRadius: {
				lg: 'var(--radius)',
				md: 'calc(var(--radius) - 2px)',
				sm: 'calc(var(--radius) - 4px)'
			},
			keyframes: {
				'accordion-down': {
					from: { height: '0' },
					to: { height: 'var(--radix-accordion-content-height)' }
				},
				'accordion-up': {
					from: { height: 'var(--radix-accordion-content-height)' },
					to: { height: '0' }
				},
				'fadeIn': {
					from: { opacity: '0', transform: 'translateY(10px)' },
					to: { opacity: '1', transform: 'translateY(0)' }
				},
				'slideIn': {
					from: { opacity: '0', transform: 'translateX(-20px)' },
					to: { opacity: '1', transform: 'translateX(0)' }
				},
				'pulseSoft': {
					'0%, 100%': { opacity: '1' },
					'50%': { opacity: '0.7' }
				}
			}
		}
	},
	plugins: [require("tailwindcss-animate")],
} satisfies Config;
