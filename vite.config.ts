import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwind from "@tailwindcss/vite";
import path from "path";
import { NodeGlobalsPolyfillPlugin } from "@esbuild-plugins/node-globals-polyfill";
import { NodeModulesPolyfillPlugin } from "@esbuild-plugins/node-modules-polyfill";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import rollupNodePolyFill from "rollup-plugin-node-polyfills";

export default defineConfig({
  // Minimal config for local development
  server: {
    host: "::",
    port: 8080,
    allowedHosts: true,
  },
  plugins: [
    // Provide Node stdlib polyfills to both dev and build (affects worker bundles too)
    nodePolyfills({
      // Whether to polyfill `node:` protocol imports, safe to enable
      protocolImports: true,
    }),
    react(),
    tailwind(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Browser-friendly shims for Node builtins used by workers/deps
      // Resolve to absolute paths so esbuild/vite do not rewrite imports to relative paths.
      "process/browser": path.resolve(__dirname, "node_modules", "process", "browser.js"),
      // Map plain "process" to the same browser shim (covers imports of "process")
      process: path.resolve(__dirname, "node_modules", "process", "browser.js"),
      // Handle imports like require('process/') used by some packages
      "process/": path.resolve(__dirname, "node_modules", "process"),
      buffer: path.resolve(__dirname, "node_modules", "buffer", "index.js"),
      stream: path.resolve(__dirname, "node_modules", "stream-browserify", "index.js"),
      "readable-stream": path.resolve(__dirname, "node_modules", "readable-stream-patched")
    },
  },

  // Ensure dev pre-bundling (esbuild) provides Node globals/polyfills where needed.
  optimizeDeps: {
    // Force pre-bundling of node-like modules used by workers/deps so dev worker bundles
    // include transformed ESM browser-compatible variants.
    include: [
      "buffer",
      "process",
      "process/browser",
      "stream-browserify",
      "readable-stream",
      "readable-stream-patched",
      "rdf-parse",
      "rdf-serialize",
      "streamify-string"
    ],
    esbuildOptions: {
      define: { global: "globalThis" },
      plugins: [
        NodeGlobalsPolyfillPlugin({ process: true, buffer: true }),
        NodeModulesPolyfillPlugin()
      ]
    }
  },

  // Ensure Rollup (production build) includes node polyfills so emitted worker bundles
  // run in browser workers without Node stdlib.
  build: {
    rollupOptions: {
      plugins: [
        // rollup-plugin-node-polyfills may have slightly different typings; cast to any
        // so TypeScript does not error in this vite.config.ts file.
        (rollupNodePolyFill() as any)
      ]
    }
  }
});
