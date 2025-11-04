import express from 'express';
import http from 'http';
import fs from 'fs/promises';
import { createServer as createViteServer } from 'vite';
import { Server as IOServer } from 'socket.io';

const app = express();

// Add headers for worker assets so cross-origin worker errors are not opaque
// and so misdetected .ts worker files are still served as JS by the browser.
//
// - If a worker resource is requested under /visgraph/assets/*, set CORS so
//   ErrorEvents are not opaque.
// - If a worker asset path ends with ".ts" (leftover built filename), force the
//   Content-Type to "application/javascript" so the browser will attempt to execute it.
// This is a temporary server-side safeguard; the proper fix is to ensure built
// assets are emitted with .js extension and served with the correct MIME.
app.use((req, res, next) => {
  if (req.method === 'GET' && req.originalUrl && req.originalUrl.startsWith('/visgraph/assets/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    // If the asset ends with .ts, some servers may wrongly detect a binary MIME.
    // Force JS MIME type so the browser will try to execute the worker.
    if (req.originalUrl.endsWith('.ts')) {
      res.setHeader('Content-Type', 'application/javascript');
    }
  }
  next();
});

const server = http.createServer(app);
const PORT = process.env.PORT || 8080;

(async () => {
  // Start Vite in middleware mode so the app is served via this Node server.
  // This keeps a single process that also hosts the socket.io control channel.
  const vite = await createViteServer({
    server: { middlewareMode: 'html' },
    appType: 'custom',
  });

  // Use Vite's connect instance as middleware
  app.use(vite.middlewares);

  // SPA fallback: serve index.html for unknown routes (so "/" and client-side routes work)
  // Use a generic middleware instead of an express path pattern to avoid path-to-regexp parsing issues.
  app.use(async (req, res, next) => {
    // Ignore non-GET requests and socket.io traffic
    if (req.method !== 'GET' || req.originalUrl.startsWith('/socket.io')) {
      return next();
    }
    try {
      const url = req.originalUrl;
      const indexHtml = await fs.readFile('index.html', 'utf-8');
      const transformed = await vite.transformIndexHtml(url, indexHtml);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html');
      res.end(transformed);
    } catch (e) {
      vite.ssrFixStacktrace?.(e);
      next(e);
    }
  });

  // Start HTTP server
  server.listen(PORT, () => {
    console.log(`Dev server listening on http://localhost:${PORT}`);
    console.log('Use "npm run stop" to trigger a graceful stop via socket.');
  });

  // Socket.IO for stop command
  const io = new IOServer(server, {
    // Restrict CORS to localhost - adjust as needed.
    cors: {
      origin: `http://localhost:${PORT}`,
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    console.log('stop socket connected');

    socket.on('npmStop', () => {
      console.log('npmStop received — shutting down');
      // Close Vite server (if available), then exit.
      (async () => {
        try {
          await vite.close();
        } catch (e) {
          // ignore
        }
        // close http server then exit
        server.close(() => {
          console.log('HTTP server closed, exiting process.');
          process.exit(0);
        });
        // In case server.close hangs, force exit after timeout
        setTimeout(() => {
          console.log('Forcing exit.');
          process.exit(0);
        }, 2000);
      })();
    });

    socket.on('disconnect', () => {
      // ignore
    });
  });
})();
