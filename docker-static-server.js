/**
 * Minimal production static file server for the Ontosphere Docker image.
 *
 * Sets Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers
 * so that SharedArrayBuffer is available, which the Konclude WASM reasoner
 * requires (https://developer.chrome.com/blog/enabling-shared-array-buffer).
 *
 * Serves HTTPS by default (self-signed cert generated at image build) so
 * SharedArrayBuffer works on remote hostnames. Set HTTPS=false to serve HTTP.
 *
 * Usage (inside container):  node docker-static-server.js
 * Direct usage:               PORT=8080 node docker-static-server.js
 */

import express from 'express';
import https from 'node:https';
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8080;
const DIST = path.join(__dirname, 'dist');
const CERT_DIR = path.join(__dirname, 'certs');
const useHttps = (process.env.HTTPS ?? 'true').toLowerCase() !== 'false';

// Cross-origin isolation headers — required for SharedArrayBuffer (WASM pthreads).
app.use((_req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  next();
});

// Serve built assets with long-lived cache (Vite hashes file names).
app.use(
  express.static(DIST, {
    maxAge: '1y',
    immutable: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }),
);

// SPA fallback — all unknown GET paths serve index.html so client-side routing works.
app.use((_req, res) => {
  res.sendFile(path.join(DIST, 'index.html'));
});

if (useHttps && fs.existsSync(path.join(CERT_DIR, 'key.pem'))) {
  const key = fs.readFileSync(path.join(CERT_DIR, 'key.pem'));
  const cert = fs.readFileSync(path.join(CERT_DIR, 'cert.pem'));
  https.createServer({ key, cert }, app).listen(PORT, () => {
    console.log(`Ontosphere static server listening on https://localhost:${PORT}`);
    console.log('Self-signed certificate — browser will show a security warning on first visit.');
    console.log('Cross-origin isolation headers (COOP/COEP) active — WASM reasoner will work.');
  });
} else {
  app.listen(PORT, () => {
    console.log(`Ontosphere static server listening on http://localhost:${PORT}`);
    console.log('Cross-origin isolation headers (COOP/COEP) active — WASM reasoner will work.');
    if (!useHttps) {
      console.log('HTTPS disabled. SharedArrayBuffer (OWL reasoner) requires HTTPS on non-localhost hostnames.');
    }
  });
}
