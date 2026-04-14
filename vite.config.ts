import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwind from "@tailwindcss/vite";
import path from "path";
import { mcpManifestPlugin } from './vite-plugin-mcp-manifest';

/**
 * Proxy plugin: exposes GET /rdf-proxy?url=<encoded-url> on the Vite dev server.
 * This allows the browser to bypass broken or missing CORS headers on external RDF
 * and SPARQL endpoints by fetching them server-side (no browser CORS restrictions).
 */
function rdfCorsProxyPlugin(): Plugin {
  return {
    name: "rdf-cors-proxy",
    configureServer(server) {
      server.middlewares.use("/rdf-proxy", async (req, res) => {
        const qs = req.url?.includes("?") ? req.url.split("?")[1] : "";
        const targetUrl = new URLSearchParams(qs).get("url");
        if (!targetUrl) {
          res.statusCode = 400;
          res.end("Missing url parameter");
          return;
        }
        try {
          const accept = (req.headers["accept"] as string) || "text/turtle, application/n-triples, */*";
          const upstream = await fetch(targetUrl, { headers: { Accept: accept } });
          const ct = upstream.headers.get("content-type");
          res.statusCode = upstream.status;
          if (ct) res.setHeader("Content-Type", ct);
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.end(await upstream.text());
        } catch (err) {
          res.statusCode = 502;
          res.end(`Proxy error: ${String(err)}`);
        }
      });
    },
  };
}

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
    rdfCorsProxyPlugin(),
    mcpManifestPlugin(),
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
