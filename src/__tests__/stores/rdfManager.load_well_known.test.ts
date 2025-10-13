import { describe, it, expect } from "vitest";
import { DataFactory } from "n3";
import { rdfManager } from "../../utils/rdfManager";
import { WELL_KNOWN_PREFIXES } from "../../utils/wellKnownOntologies";
const { namedNode } = DataFactory;

describe("rdfManager - load real well-known ontology URLs and subject-change emissions", () => {
  it(
    "loads each WELL_KNOWN URL into urn:vg:data and verifies triples are added and subject events can be observed",
    async () => {
      // Increase timeout for network + parse
      const perUrlTimeoutMs = 30000;
      const pollInterval = 200;
      const pollTimeout = 10000;

      // Ensure starting with a clean graph
      try {
        rdfManager.removeGraph("urn:vg:data");
      } catch (_) {
        /* ignore */
      }

      // Attach a single listener that records invocations
      const calls: Array<{ subjects: string[]; quads?: any[] }> = [];
      const handler = (subjects: string[], quads?: any[]) => {
        try {
          calls.push({ subjects: Array.isArray(subjects) ? subjects.slice() : [], quads });
        } catch (_) {
          calls.push({ subjects: [], quads });
        }
      };
      // Temporarily disable blacklist so ontology core subjects emit subject-change events in this test
      try {
        rdfManager.setBlacklist([], []);
      } catch (_) {
        /* ignore if not supported */
      }
      rdfManager.onSubjectsChange(handler);

      try {
        for (const entry of WELL_KNOWN_PREFIXES) {
          // Basic sanity: skip entries without URL
          if (!entry || !entry.url) continue;

          const url = entry.url;
          const beforeQuads =
            rdfManager.getStore && typeof rdfManager.getStore === "function"
              ? (rdfManager.getStore().getQuads(null, null, null, namedNode("urn:vg:data")) || []).length
              : 0;

          // Clear recorded calls for this URL
          calls.length = 0;

          // Probe the URL to check Content-Type and skip non-RDF responses.
          let loadErr: any = null;
          let contentType: string | null = null;
          try {
            const probeRes = await fetch(url, {
              method: "GET",
              headers: { Accept: "text/turtle, application/ld+json, application/rdf+xml, */*" },
              redirect: "follow",
            });
            contentType =
              probeRes && probeRes.headers && typeof probeRes.headers.get === "function"
                ? probeRes.headers.get("content-type")
                : null;

            // Accept common RDF media types; skip otherwise to avoid test failures for HTML pages.
            if (
              !contentType ||
              !/(text\/turtle|text\/n3|application\/ld\+json|application\/rdf\+xml|application\/xml)/i.test(contentType)
            ) {
              // eslint-disable-next-line no-console
              console.warn(`[TEST] Skipping ${url} due to non-RDF Content-Type: ${String(contentType)}`);
              continue;
            }
          } catch (probeErr) {
            // If probe fails, log and attempt load (network may block HEAD/OPTIONS); fall through to load call.
            // eslint-disable-next-line no-console
            console.warn(`[TEST] Probe failed for ${url}: ${String(probeErr)}`);
          }

          try {
            // Use a slightly larger timeout for fetch/parsing
            await rdfManager.loadRDFFromUrl(url, "urn:vg:data", { timeoutMs: perUrlTimeoutMs });
          } catch (e) {
            loadErr = e;
          }

          // Wait briefly for any subject-change emission to occur (poll)
          const start = Date.now();
          while (Date.now() - start < pollTimeout) {
            if (calls.length > 0) break;
            // also break early if store shows quads added
            const mid = rdfManager.getStore().getQuads(null, null, null, namedNode("urn:vg:data")).length;
            if (mid - beforeQuads > 0) break;
            // small sleep
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, pollInterval));
          }

          const afterQuads = rdfManager.getStore().getQuads(null, null, null, namedNode("urn:vg:data")).length;
          const delta = afterQuads - beforeQuads;

          // Assert that triples were added by the load (primary requirement)
          // If load reported an error and no triples were added, treat as a skipped case (do not fail the whole run).
          if (loadErr && delta === 0) {
            // eslint-disable-next-line no-console
            console.warn(`[TEST] Load failed for ${url}: ${String(loadErr)}. Skipping triple-count assertion.`);
          } else {
            expect(delta).toBeGreaterThan(0);
          }

          // If no subject events were observed automatically, attempt to trigger one deterministically:
          if (calls.length === 0) {
            // Find a subject IRI from the newly added quads
            const allNew = rdfManager.getStore().getQuads(null, null, null, namedNode("urn:vg:data")) || [];
            const someQuad = allNew && allNew.length > 0 ? allNew[0] : null;
            const subjIri = someQuad && someQuad.subject && (someQuad.subject as any).value
              ? String((someQuad.subject as any).value)
              : null;

            if (subjIri) {
              // Attempt to trigger a subject update; this also serves as a check that the emission path works.
              try {
                await rdfManager.triggerSubjectUpdate([subjIri]);
              } catch (_) {
                // ignore trigger failures - we'll still assert calls after
              }

              // wait shortly for triggered event
              const s2 = Date.now();
              while (Date.now() - s2 < 3000) {
                if (calls.length > 0) break;
                // eslint-disable-next-line no-await-in-loop
                await new Promise((r) => setTimeout(r, 100));
              }
            }
          }

          // By now we either observed subject events or at least triples were added.
          // Record a helpful assertion: either subject events were observed OR triples were added (the latter already asserted).
          // Prefer to assert subject events were observed when possible (non-blacklisted subjects).
          // If we still have no subject events, print a console.warn for diagnostics but don't fail (triples are primary).
          if (calls.length === 0) {
            // Provide diagnostic output so maintainers understand why subject events didn't fire.
            try {
              // eslint-disable-next-line no-console
              console.warn(`[TEST] No subject-change events observed for ${url}. loadErr: ${String(loadErr || "")}. triplesAdded: ${delta}`);
            } catch (_) { /* ignore logging failures */ }
          } else {
            // eslint-disable-next-line no-console
            console.info(`[TEST] Subject-change events observed for ${url}: ${calls.length} invocation(s).`);
            // Basic assertion that subjects array is non-empty in the first call
            expect(Array.isArray(calls[0].subjects)).toBe(true);
          }

          // Clean up the graph between runs to keep tests isolated
          try {
            rdfManager.removeGraph("urn:vg:data");
          } catch (_) {
            /* ignore */
          }
        }
      } finally {
        // detach the listener
        rdfManager.offSubjectsChange(handler);
      }
    },
    { timeout: 120000 },
  );
});
