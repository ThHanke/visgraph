import { defineConfig } from "vite";
import type { ViteDevServer } from "vite";
import type { IncomingMessage, ServerResponse } from "http";
import react from "@vitejs/plugin-react-swc";
import path from "path";

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
    fs: {
      // Allow serving files from the project root during development so
      // requests like "/?url=..." that Vite rejects by default (403) will work.
      // This is safe for local development only.
      allow: [path.resolve(__dirname)]
    }
  },
  plugins: [
    react()
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  base: process.env.NODE_ENV === 'production' ? '/visgraph/' : '/',
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

        // Copy response headers, but avoid hop-by-hop headers that Node will set
        fetchRes.headers.forEach((value: string, key: string) => {
          const k = key.toLowerCase();
          if (['transfer-encoding', 'content-encoding', 'content-length'].includes(k)) return;
          res.setHeader(key, value);
        });

        const buf = Buffer.from(await fetchRes.arrayBuffer());
        res.setHeader('Content-Length', String(buf.length));
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
