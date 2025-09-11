/**
 * Test helper to load centralized RDF fixtures into the RDF manager.
 *
 * Usage:
 *   import { loadFixtureRdf } from './utils/loadFixtureRdf';
 *   import { FIXTURES } from '../fixtures/rdfFixtures';
 *
 *   await loadFixtureRdf(FIXTURES['https://.../example.ttl'], 'test://graph');
 */

import { rdfManager } from "../../utils/rdfManager";

/**
 * Load a Turtle/TTL string into the RDF manager.
 * - ttl: Turtle content string
 * - graphName: optional named graph IRI (when provided the triples are loaded into that named graph)
 * - options:
 *    - clearGraphBeforeLoad: if true, remove the named graph before loading (default: false)
 */
export async function loadFixtureRdf(
  ttl: string,
  graphName?: string,
  options?: { clearGraphBeforeLoad?: boolean },
): Promise<void> {
  const clear = options?.clearGraphBeforeLoad === true;
  if (graphName && clear) {
    try {
      rdfManager.removeGraph(graphName);
    } catch (_) {
      /* ignore */
    }
  }

  if (graphName) {
    await rdfManager.loadRDFIntoGraph(ttl, graphName);
  } else {
    await rdfManager.loadRDF(ttl);
  }
}
