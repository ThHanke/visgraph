import { defineConfig } from "vite";
import type { ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import react from "@vitejs/plugin-react-swc";
import tailwind from "@tailwindcss/vite";
import path from "path";
import fs from "fs";
import { nodePolyfills } from 'vite-plugin-node-polyfills'

// Vite dev server proxy helper:
// We expose a small dev-only endpoint at /__external?url=<encoded-url>
// that fetches the remote resource server-side and returns it to the browser.
// This avoids CORS issues when the browser tries to fetch RDF/ontology files
// from servers that don't set Access-Control-Allow-Origin headers.
//
// IMPORTANT: This is only enabled in development mode (not in production).
export default defineConfig(({ mode }) => ({
  server: {
    host: "::",
    port: 8080,
    allowedHosts: true,
    // If developer has placed certs in .certs/localhost.pem and .certs/localhost-key.pem
    // enable HTTPS automatically to avoid mixed-content issues during export testing.
    // Return undefined when no certs are present so the config type matches Vite's ServerOptions.
    https: (() => {
      try {
        const certDir = path.resolve(__dirname, '.certs');
        const certPath = path.join(certDir, 'localhost.pem');
        const keyPath = path.join(certDir, 'localhost-key.pem');
        if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
          return {
            cert: fs.readFileSync(certPath),
            key: fs.readFileSync(keyPath),
          };
        }
      } catch (e) { void e; /* ignore and fall back to http */ }
      return undefined;
    })(),
    fs: {
      // Allow serving files from the project root during development so
      // requests like "/?url=..." that Vite rejects by default (403) will work.
      // This is safe for local development only.
      allow: [path.resolve(__dirname)]
    }
  },
  plugins: [
    react(),
    tailwind(),
    nodePolyfills({
      include: ['process', 'stream', 'buffer'],
      globals: { global: true, process: true, Buffer: true },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      process: 'process/browser',
      // Force patched readable-stream fork in production builds
      'readable-stream': 'readable-stream-patched',
      // Ensure stream and buffer polyfills resolve to browser-compatible packages so
      // client code can access stream.Readable and Buffer at runtime (not externalized).
      stream: 'stream-browserify',
      buffer: 'buffer',
    },
  },

  // Ensure Vite pre-bundles heavy RDF & stream-related dependencies so the dev server
  // does not attempt to fetch dynamic /node_modules/.vite/deps/* assets at runtime.
  // This reduces the chance of runtime 504 / corrupted responses for polyfills.
  optimizeDeps: {
    include: [
      "rdf-parse",
      "rdf-serialize",
      "n3",
      "rdfxml-streaming-parser",
      "readable-stream-patched",
      "streamify-string"
    ]
  },

  base: process.env.NODE_ENV === 'production' ? '/visgraph/' : '/',

  // Ensure worker assets emitted with .js extension so servers serve them with correct JS MIME type.
  // We rewrite emitted filenames during the Rollup generateBundle phase to replace .ts suffixes with .js.
  build: {
    rollupOptions: {
      plugins: [
        {
          name: 'rename-ts-workers',
          generateBundle(_options, bundle) {
            // First pass: rename .ts entries to .js and record a mapping of old -> new names.
            const renameMap = new Map();
            for (const fileName of Object.keys(bundle)) {
              if (fileName.endsWith('.ts')) {
                const chunk = bundle[fileName];
                const newName = fileName.replace(/\.ts$/, '.js');
                // Ensure we don't collide with an existing entry
                if (!bundle[newName]) {
                  // Preserve the emitted chunk under a new file name
                  // @ts-ignore - mutating bundle in generateBundle hook
                  bundle[newName] = { ...chunk, fileName: newName };
                }
                renameMap.set(fileName, newName);
                // Delete the original .ts entry
                delete bundle[fileName];
              }
            }
            // Second pass: update internal references in other chunks/assets so runtime
            // code points to the renamed .js files (e.g. Worker URLs built from import.meta.url).
            if (renameMap.size > 0) {
              for (const [origName, newName] of renameMap.entries()) {
                for (const otherName of Object.keys(bundle)) {
                  const entry = bundle[otherName];
                  // Update chunk JS code
                  if (entry && entry.type === 'chunk' && typeof entry.code === 'string') {
                    if (entry.code.includes(origName)) {
                      entry.code = entry.code.split(origName).join(newName);
                    }
                  }
                  // Update asset sources (e.g., injected HTML or CSS) if needed
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
  },

  // Preview server middleware: ensure .ts assets are served with JS MIME type
  // so worker files built with .ts extension load correctly in the browser preview.
  configurePreviewServer: (server: any) => {
    server.middlewares.use((req: IncomingMessage & { url?: string }, res: ServerResponse, next: (err?: unknown) => void) => {
      try {
        if (req.url && req.url.endsWith('.ts')) {
          res.setHeader('Content-Type', 'application/javascript');
        }
      } catch (e) { /* noop */ }
      return next();
    });
  },

  // Development-only server hook to proxy arbitrary external URLs and serve a dev demo TTL.
  // The browser should call /__external?url=<ENCODED_URL> for proxied fetches.
  // Additionally, a dev-only endpoint /__vg_debug_ttl returns a small hard-coded Turtle
  // snippet so the client can load demo RDF without external network requests.
  configureServer: (server: ViteDevServer) => {
    // Dev demo toggle and TTL (only used in development)
    const VG_DEV_LOAD_DEMO = true;
    const DEV_DEMO_TTL = `
      @prefix : <https://github.com/Mat-O-Lab/IOFMaterialsTutorial/> .
      @prefix iof: <https://spec.industrialontologies.org/ontology/core/Core/> .
      @prefix iof-qual: <https://spec.industrialontologies.org/ontology/qualities/> .
      @prefix iof-mat: <https://spec.industrialontologies.org/ontology/materials/Materials/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

      :SpecimenLength a iof-qual:Length ;
          iof:masuredByAtSomeTime :Caliper .

      :Caliper a iof-mat:MeasurementDevice .
    `;

    // Ensure .ts assets are served with JS MIME type (fix worker MIME issue in preview)
    server.middlewares.use((req: IncomingMessage & { url?: string }, res: ServerResponse, next: (err?: unknown) => void) => {
      try {
        if (req.url && req.url.endsWith('.ts')) {
          // Some servers map .ts to non-JS MIME types; workers must be served as JS.
          res.setHeader('Content-Type', 'application/javascript');
        }
      } catch (e) { /* noop */ }
      return next();
    });

    // Dev endpoint: return hard-coded TTL when the dev flag is enabled.
    server.middlewares.use((req: IncomingMessage & { url?: string }, res: ServerResponse, next: (err?: unknown) => void) => {
      try {
        if (!req.url) return next();
        if (req.url.startsWith('/__vg_debug_ttl')) {
          if (!VG_DEV_LOAD_DEMO || process.env.NODE_ENV === 'production') {
            res.statusCode = 404;
            res.end('Not found');
            return;
          }
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ success: true, ttl: DEV_DEMO_TTL }));
          return;
        }
      } catch (e) {
        // fall through to next handler
      }
      return next();
    });

    server.middlewares.use(async (req: IncomingMessage & { url?: string }, res: ServerResponse, next: (err?: unknown) => void) => {
      try {
        if (!req.url) return next();
        if (!req.url.startsWith('/__external')) return next();

        const u = new URL(req.url, 'http://localhost');
        const target = u.searchParams.get('url');
        if (!target) {
          res.statusCode = 400;
          res.end('Missing "url" query parameter');
          return;
        }

        // Prevent abuse: only allow http(s) targets
        if (!/^https?:\/\//i.test(target)) {
          res.statusCode = 400;
          res.end('Only http/https targets are allowed');
          return;
        }

        // Forward headers (user-agent) minimally
        const headers: Record<string, string> = {
          'User-Agent': req.headers['user-agent'] || 'vite-dev-proxy'
        };

        const fetchRes = await fetch(target, { headers });
        res.statusCode = fetchRes.status;

        // Try to infer a better Content-Type for RDF files based on the URL extension,
        // because some servers (GitHub raw URLs etc.) return text/plain which breaks rdf parsers.
        const inferredType = (() => {
          try {
            const u2 = new URL(target);
            const pathname = u2.pathname || '';
            if (/\.(ttl|turtle)$/i.test(pathname)) return 'text/turtle';
            if (/\.(n3)$/i.test(pathname)) return 'text/n3';
            if (/\.(nt)$/i.test(pathname)) return 'application/n-triples';
            if (/\.(rdf|xml)$/i.test(pathname)) return 'application/rdf+xml';
            if (/\.(jsonld|json)$/i.test(pathname)) return 'application/ld+json';
          } catch (_) {}
          return null;
        })();

        // Copy response headers, but avoid hop-by-hop headers that Node will set
        fetchRes.headers.forEach((value: string, key: string) => {
          const k = key.toLowerCase();
          if (['transfer-encoding', 'content-encoding', 'content-length'].includes(k)) return;
          // If remote content-type is generic text/plain but we inferred a more specific type, override it.
          if (k === 'content-type' && inferredType && /^text\/plain/i.test(value)) {
            res.setHeader('Content-Type', inferredType);
            return;
          }
          res.setHeader(key, value);
        });

        const buf = Buffer.from(await fetchRes.arrayBuffer());
        if (!res.getHeader('Content-Length')) res.setHeader('Content-Length', String(buf.length));
        res.end(buf);
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.statusCode = 502;
        res.end(`Proxy fetch failed: ${msg}`);
        return;
      }
    });
  }
}));
