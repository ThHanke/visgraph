/**
 * Browser-level regression test for queryGraph MCP tool.
 *
 * Verifies that Comunica's QueryEngine initialises and executes correctly inside
 * the Vite web worker — the failure mode this test guards against is the Rollup /
 * esbuild CJS-circular-dep issue that previously caused every queryGraph call to
 * return an error at runtime even though unit tests (InProcessWorker) passed.
 *
 * Run:
 *   npx playwright test e2e/sparql-worker.spec.ts
 *
 * Requires a running dev server on http://localhost:8080 (npm run dev).
 */

import { test, expect, Page } from "@playwright/test";

const BASE_URL = process.env.VG_URL ?? "http://localhost:8080";

async function waitForTools(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const tools = (window as any).__mcpTools;
    return tools && typeof tools.queryGraph === "function";
  }, { timeout: 10_000 });
}

async function qg(page: Page, sparql: string, limit?: number) {
  return page.evaluate(
    async ({ sparql, limit }: { sparql: string; limit?: number }) => {
      const queryGraph = (window as any).__mcpTools.queryGraph;
      return queryGraph({ sparql, ...(limit !== undefined ? { limit } : {}) });
    },
    { sparql, limit },
  );
}

test.describe("queryGraph browser worker", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE_URL);
    await waitForTools(page);
  });

  test("INSERT DATA succeeds", async ({ page }) => {
    const result = await qg(
      page,
      "INSERT DATA { <urn:sparql-test:s> <urn:sparql-test:p> <urn:sparql-test:o> }",
    );
    expect(result.success).toBe(true);
    expect(result.data.updated).toBe(true);
  });

  test("SELECT returns inserted triple", async ({ page }) => {
    await qg(
      page,
      "INSERT DATA { <urn:sparql-test:s> <urn:sparql-test:p> <urn:sparql-test:o> }",
    );
    const result = await qg(
      page,
      "SELECT ?s ?p ?o WHERE { <urn:sparql-test:s> ?p ?o } LIMIT 1",
    );
    expect(result.success).toBe(true);
    expect(result.data.rows).toHaveLength(1);
    expect(result.data.rows[0].p).toBe("urn:sparql-test:p");
    expect(result.data.rows[0].o).toBe("urn:sparql-test:o");
  });

  test("CONSTRUCT returns triples", async ({ page }) => {
    await qg(
      page,
      "INSERT DATA { <urn:sparql-test:s> <urn:sparql-test:p> <urn:sparql-test:o> }",
    );
    const result = await qg(
      page,
      "CONSTRUCT { ?s <urn:sparql-test:p> ?o } WHERE { ?s <urn:sparql-test:p> ?o }",
    );
    expect(result.success).toBe(true);
    expect(result.data.triples.length).toBeGreaterThanOrEqual(1);
    const hit = result.data.triples.find(
      (t: any) => t.s === "urn:sparql-test:s",
    );
    expect(hit).toBeDefined();
    expect(hit.p).toBe("urn:sparql-test:p");
  });

  test("DELETE DATA removes triple; follow-up SELECT returns 0 rows", async ({ page }) => {
    await qg(
      page,
      "INSERT DATA { <urn:sparql-test:del> <urn:sparql-test:p> <urn:sparql-test:o> }",
    );
    await qg(
      page,
      "DELETE DATA { <urn:sparql-test:del> <urn:sparql-test:p> <urn:sparql-test:o> }",
    );
    const result = await qg(
      page,
      "SELECT ?o WHERE { <urn:sparql-test:del> <urn:sparql-test:p> ?o }",
    );
    expect(result.success).toBe(true);
    expect(result.data.rows).toHaveLength(0);
  });

  test("malformed SPARQL returns success:false with error string", async ({ page }) => {
    const result = await qg(page, "NOT VALID SPARQL !!!");
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
  });
});
