import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwind from "@tailwindcss/vite";
import path from "path";
import { mcpManifestPlugin } from './vite-plugin-mcp-manifest';
import { bookmarkletPlugin } from './vite-plugin-bookmarklet';
import { workerComunicaPlugin, diagnosticsChannelStub } from './vite-plugin-worker-comunica';

// COOP/COEP are required for SharedArrayBuffer (Konclude WASM).
// relay.html must be exempted: it needs window.opener to bridge postMessages
// between the AI chat tab (cross-origin opener) and the Ontosphere app.
function coiHeadersPlugin(): Plugin {
  function middleware(req: any, res: any, next: () => void) {
    if (!req.url?.includes('relay.html') && !req.url?.includes('relay-mock-chat.html') && !req.url?.includes('demo-stage.html')) {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    }
    next();
  }
  return {
    name: 'coi-headers',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}


export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? (process.env.NODE_ENV === 'production' ? '/ontosphere/' : '/'),
  // Dev server settings (keep for local development)
  server: {
    host: "::",
    port: 8080,
    allowedHosts: true,
  },

  preview: {},

  // Dev plugins: keep minimal for fast dev runs
  plugins: [
    react(),
    tailwind(),
    mcpManifestPlugin(),
    bookmarkletPlugin(),
    coiHeadersPlugin(),
  ],

  // Ensure worker bundles use ES modules output so Rollup can code-split worker chunks.
  // Default 'iife' will fail when code-splitting; explicitly set 'es' for modern browsers.
  // Comunica v5 has circular CJS deps that Rollup's require_libXXX stubs can't
  // reconstruct. The workerComunicaPlugin intercepts the import and substitutes
  // an esbuild-compiled flat ESM bundle — same strategy as InProcessWorker tests.
  worker: {
    format: "es",
    plugins: () => [workerComunicaPlugin()],
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Comunica's dependency chain has two browser-incompatible patterns that must be
  // fixed in the dep optimizer pre-bundle:
  //   1. node:diagnostics_channel (used by lru-cache): Vite's Proxy stub returns undefined
  //      for all property accesses → "(0, L.channel) is not a function" at init time.
  //   2. `global` identifier (used by promise-polyfill): not defined in browser workers;
  //      define → globalThis so promise-polyfill resolves its root object correctly.
  //      This also prevents a cascade failure where promise-polyfill's broken __commonJS
  //      wrapper caches an empty exports object, breaking downstream class inheritance.
  optimizeDeps: {
    esbuildOptions: {
      define: {
        global: "globalThis",
      },
      plugins: [diagnosticsChannelStub],
    },
  },

  // Focused production build config: only what's necessary to produce self-contained worker bundles
  build: {
  },
});
