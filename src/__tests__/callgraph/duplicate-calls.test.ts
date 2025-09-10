import { beforeEach, test, expect } from 'vitest';
import { useOntologyStore } from '../../stores/ontologyStore';

declare const fallback: any;

// Simple RDF snippet (Turtle) for testing
const SAMPLE_TTL = `
@prefix ex: <http://example.org/> .
ex:subj ex:pred "value" .
`;

beforeEach(() => {
  // Reset store between tests
  try {
    useOntologyStore.getState().clearOntologies();
  } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } }
});

test('rdfManager.loadRDF should be de-duplicated for concurrent identical loads', async () => {
  const store = useOntologyStore.getState();

  // Ensure rdfManager exists
  const rdfManager: any = store.rdfManager;
  expect(rdfManager).toBeTruthy();

  // Spy the underlying parser.parse to count actual parse invocations (this reflects real work).
  // Access parser directly on the rdfManager instance (not public in types, but available at runtime).
  const parserInstance: any = (rdfManager as any).parser;
  const originalParse = parserInstance.parse.bind(parserInstance);
  let parseCount = 0;

  parserInstance.parse = (content: string, cb: any) => {
    parseCount += 1;
    return originalParse(content, cb);
  };

  // Call loadKnowledgeGraph twice concurrently with identical content.
  await Promise.all([
    store.loadKnowledgeGraph(SAMPLE_TTL),
    store.loadKnowledgeGraph(SAMPLE_TTL)
  ]);

  // The RDFManager implements in-flight dedupe, so the parser.parse should be invoked only once.
  expect(parseCount).toBe(1);
});
