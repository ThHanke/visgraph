/**
 * Test helper functions for RDF operations
 * Provides convenient wrappers around the async worker API
 */

import { rdfManager } from "../../utils/rdfManager";

/**
 * Get the count of quads in a graph
 */
export async function getQuadCount(
  graphName: string = "urn:vg:data"
): Promise<number> {
  const result = await rdfManager.fetchQuadsPage({
    graphName,
    limit: 10000,
    serialize: true
  });
  return result?.items?.length || 0;
}

/**
 * Find quads matching the given filter
 */
export async function findQuads(
  filter: { subject?: string; predicate?: string; object?: string },
  graphName: string = "urn:vg:data"
): Promise<any[]> {
  const result = await rdfManager.fetchQuadsPage({
    graphName,
    limit: 10000,
    serialize: true,
    filter
  });
  return result?.items || [];
}

/**
 * Get all quads from a graph
 */
export async function getAllQuads(
  graphName: string = "urn:vg:data"
): Promise<any[]> {
  const result = await rdfManager.fetchQuadsPage({
    graphName,
    limit: 10000,
    serialize: true
  });
  return result?.items || [];
}

/**
 * Check if a specific quad exists
 */
export async function hasQuad(
  subject: string,
  predicate: string,
  object: string,
  graphName: string = "urn:vg:data"
): Promise<boolean> {
  const quads = await findQuads({ subject, predicate, object }, graphName);
  return quads.length > 0;
}

/**
 * Wait for async operations to complete (use after mutations)
 */
export async function waitForOperation(ms: number = 200): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}
