import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwind from "@tailwindcss/vite";
import path from "path";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import rollupNodePolyFill from "rollup-plugin-node-polyfills";

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
    // Provide small dev-time polyfills so dev server behavior remains consistent
    nodePolyfills({
      protocolImports: true,
    }),
    react(),
    tailwind(),
  ],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Minimal, targeted aliases to help Rollup/Vite resolve small Node shims
      "process/browser": path.resolve(__dirname, "node_modules", "process", "browser.js"),
      process: path.resolve(__dirname, "node_modules", "process", "browser.js"),
      buffer: path.resolve(__dirname, "node_modules", "buffer", "index.js"),
      stream: path.resolve(__dirname, "node_modules", "stream-browserify", "index.js"),
      "readable-stream": path.resolve(__dirname, "node_modules", "readable-stream-patched"),
    },
  },

  // Focused production build config: only what's necessary to produce self-contained worker bundles
  build: {
    rollupOptions: {
      // Force worker files to be treated as explicit entry points so Rollup bundles their deps.
      input: {
        main: path.resolve(__dirname, "index.html"),
        "parseRdf.worker": path.resolve(__dirname, "src/workers/parseRdf.worker.ts"),
        "reasoner.worker": path.resolve(__dirname, "src/workers/reasoner.worker.ts"),
      },
      output: {
        // Group worker-related polyfills and heavy deps into a dedicated chunk so worker entry
        // chunks import a single polyfills file instead of leaving bare specifiers unresolved.
        manualChunks(id: string) {
          if (!id) return;
          const lowered = id.toLowerCase();
          if (
            lowered.includes('readable-stream') ||
            lowered.includes('/node_modules/buffer') ||
            lowered.includes('/node_modules/process') ||
            lowered.includes('rdf-parse') ||
            lowered.includes('rdf-serialize') ||
            lowered.includes('/node_modules/n3') ||
            lowered.includes('stream-browserify')
          ) {
            return 'worker-polyfills';
          }
        },
      },
      plugins: [
        // Ensure node builtin imports are rewritten for Rollup (run early)
        (rollupNodePolyFill() as any),

        // Rename emitted .ts assets to .js so static servers serve workers with JS MIME type.
        {
          name: 'rename-ts-workers',
          generateBundle(_options, bundle) {
            const renameMap = new Map();
            for (const fileName of Object.keys(bundle)) {
              if (fileName.endsWith('.ts')) {
                const chunk: any = bundle[fileName];
                const newName = fileName.replace(/\.ts$/, '.js');
                if (!bundle[newName]) {
                  bundle[newName] = { ...chunk, fileName: newName };
                }
                renameMap.set(fileName, newName);
                delete bundle[fileName];
              }
            }
            if (renameMap.size > 0) {
              for (const [origName, newName] of renameMap.entries()) {
                for (const otherName of Object.keys(bundle)) {
                  const entry: any = bundle[otherName];
                  if (entry && entry.type === 'chunk' && typeof entry.code === 'string') {
                    if (entry.code.includes(origName)) {
                      entry.code = entry.code.split(origName).join(newName);
                    }
                  }
                  if (entry && entry.type === 'asset' && typeof entry.source === 'string') {
                    if (entry.source.includes(origName)) {
                      entry.source = entry.source.split(origName).join(newName);
                    }
                  }
                }
              }
            }
          }
        }
      ]
    }
  }
});
