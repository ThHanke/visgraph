/**
 * SECURITY e2e — relay.html opener-origin trust model.
 *
 * Proves the relay popup (public/relay.html) accepts `vg-call` messages from
 * any concrete origin (since the popup can only be opened by the user-installed
 * bookmarklet), while still rejecting the opaque "null" origin, empty strings,
 * and the wildcard '*'.
 *
 * This test is fully self-contained: it serves public/relay.html from a local
 * HTTP server, loads it in a real browser, and exercises the ACTUAL shipped code.
 *
 * Run:
 *   npx playwright test e2e/relay-origin-allowlist.spec.ts
 */

import { test, expect } from '@playwright/test';
import fs from 'fs';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import type { AddressInfo } from 'net';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY_PATH = path.resolve(__dirname, '../public/relay.html');
const RELAY_HTML = fs.readFileSync(RELAY_PATH, 'utf8');

function startServer(): Promise<{ origin: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(RELAY_HTML);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

test.describe('relay.html — opener-origin trust model (security)', () => {
  let origin: string;
  let close: () => Promise<void>;

  test.beforeAll(async () => {
    ({ origin, close } = await startServer());
  });

  test.afterAll(async () => {
    await close();
  });

  test('isOriginAllowed: any concrete origin accepted, opaque/empty/wildcard rejected', async ({ page }) => {
    await page.goto(`${origin}/relay.html`);
    await page.waitForFunction(() => typeof (window as any).isOriginAllowed === 'function');

    const result = await page.evaluate((selfOrigin) => {
      const f = (window as any).isOriginAllowed as (o: string) => boolean;
      return {
        // ── Accepted (any concrete origin) ──
        chatgpt:       f('https://chatgpt.com'),
        claude:        f('https://claude.ai'),
        gemini:        f('https://gemini.google.com'),
        fhgenie:       f('https://fhgenie.fraunhofer.de'),
        owui:          f('https://gpuserver1-sit.iwm.fraunhofer.de'),
        sameOrigin:    f(selfOrigin),
        localhost:     f('http://localhost:5173'),
        loopback:      f('http://127.0.0.1:8080'),
        arbitrary:     f('https://any-ai-platform.example'),
        // ── Rejected (opaque/empty/wildcard) ──
        star:          f('*'),
        nullOrigin:    f('null'),
        empty:         f(''),
      };
    }, origin);

    // Accepted
    expect(result.chatgpt).toBe(true);
    expect(result.claude).toBe(true);
    expect(result.gemini).toBe(true);
    expect(result.fhgenie).toBe(true);
    expect(result.owui).toBe(true);
    expect(result.sameOrigin).toBe(true);
    expect(result.localhost).toBe(true);
    expect(result.loopback).toBe(true);
    expect(result.arbitrary).toBe(true);

    // Rejected
    expect(result.star).toBe(false);
    expect(result.nullOrigin).toBe(false);
    expect(result.empty).toBe(false);
  });

  test('live message handler: opaque-origin vg-call is NOT forwarded, concrete origin IS forwarded', async ({ page }) => {
    await page.goto(`${origin}/relay.html`);
    await page.waitForFunction(() => typeof (window as any).isOriginAllowed === 'function');

    const forwarded = await page.evaluate(async () => {
      const CHANNEL_NAME = 'ontosphere-relay-v1';
      const seen: Array<{ type: string; tool?: string }> = [];
      const bc = new BroadcastChannel(CHANNEL_NAME);
      bc.onmessage = (e: MessageEvent) => {
        const d = e.data;
        if (d && d.type === 'vg-call') seen.push({ type: d.type, tool: d.tool });
      };

      function fire(originStr: string, tool: string) {
        window.dispatchEvent(new MessageEvent('message', {
          data: { type: 'vg-call', tool, requestId: 'rq-test', params: {} },
          origin: originStr,
        }));
      }

      // Opaque "null" origin — must be ignored.
      fire('null', 'queryGraph');
      // Concrete origin (arbitrary) — must be forwarded.
      fire('https://any-ai-platform.example', 'addNode');

      await new Promise((r) => setTimeout(r, 300));
      bc.close();
      return seen;
    });

    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].tool).toBe('addNode');
    expect(forwarded.some((m) => m.tool === 'queryGraph')).toBe(false);
  });

  test('source contains no "*" postMessage target fallback', () => {
    const lines = RELAY_HTML.split('\n');
    const offending = lines.filter((l) => {
      const code = l.replace(/\/\/.*$/, '');
      return /postMessage\s*\([^)]*['"]\*['"]/.test(code);
    });
    expect(offending).toEqual([]);
    expect(RELAY_HTML).toContain('function isOriginAllowed');
  });
});
