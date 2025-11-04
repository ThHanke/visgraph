import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwind from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  base: process.env.NODE_ENV === 'production' ? '/visgraph/' : '/',
  // Dev server settings (keep for local development)
  server: {
    host: "::",
    port: 8080,
    allowedHosts: true,
  },

  // Dev plugins: keep minimal for fast dev runs
  plugins: [
    react(),
    tailwind(),
  ],

  // Ensure worker bundles use ES modules output so Rollup can code-split worker chunks.
  // Default 'iife' will fail when code-splitting; explicitly set 'es' for modern browsers.
  worker: {
    format: "es",
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Focused production build config: only what's necessary to produce self-contained worker bundles
  build: {
  },
});
