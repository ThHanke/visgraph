import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwind from "@tailwindcss/vite";
import path from "path";
import { NodeGlobalsPolyfillPlugin } from "@esbuild-plugins/node-globals-polyfill";
import { NodeModulesPolyfillPlugin } from "@esbuild-plugins/node-modules-polyfill";

export default defineConfig({
  // Minimal config for local development
  server: {
    host: "::",
    port: 8080,
    allowedHosts: true,
  },
  plugins: [
    react(),
    tailwind(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Browser-friendly shims for Node builtins used by workers/deps
      process: "process/browser",
      buffer: "buffer",
      stream: "stream-browserify",
      "readable-stream": "readable-stream-patched"
    },
  },

  // Ensure dev pre-bundling (esbuild) provides Node globals/polyfills where needed.
  optimizeDeps: {
    esbuildOptions: {
      define: { global: "globalThis" },
      plugins: [
        NodeGlobalsPolyfillPlugin({ process: true, buffer: true }),
        NodeModulesPolyfillPlugin()
      ]
    }
  },
});
