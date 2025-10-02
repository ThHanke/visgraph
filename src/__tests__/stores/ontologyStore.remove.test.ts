import { beforeEach, test, expect } from 'vitest';
import { useOntologyStore } from '../../../src/stores/ontologyStore';
import { useAppConfigStore } from '../../../src/stores/appConfigStore';
import { rdfManager } from '../../../src/utils/rdfManager';
import { DataFactory } from 'n3';

declare const fallback: any;

const { namedNode } = DataFactory;

beforeEach(() => {
  // Reset stores and RDF manager to a clean state before each test
  try {
    useOntologyStore.getState().clearOntologies();
  } catch (e) {
    try {
      if (typeof fallback === "function") {
        fallback("emptyCatch", { error: String(e) });
      }
    } catch (_) { /* empty */ }
  }

  try {
    useAppConfigStore.getState().resetToDefaults();
  } catch (e) {
    try {
      if (typeof fallback === "function") {
        fallback("emptyCatch", { error: String(e) });
      }
    } catch (_) { /* empty */ }
  }

  try {
    rdfManager.clear();
  } catch (e) {
    try {
      if (typeof fallback === "function") {
        fallback("emptyCatch", { error: String(e) });
      }
    } catch (_) { /* empty */ }
  }
});

test('removeLoadedOntology removes ontology meta, persisted config entry and namespace triples', async () => {
  const url = 'http://example.org/mock-ontology';
  const nsUri = 'http://example.org/mock#';
  const prefix = 'm';

  // Prepare a mock ontology entry
  const mockOntology = {
    url,
    name: 'MOCK',
    classes: [
      {iri: `${prefix}:Class`, label: 'Class', namespace: prefix, properties: [], restrictions: {} }
    ],
    properties: [],
    namespaces: { [prefix]: nsUri }
  };

  // Inject into ontology store and app config
  useOntologyStore.setState({
    loadedOntologies: [mockOntology],
    availableClasses: mockOntology.classes,
    availableProperties: []
  });

  useAppConfigStore.getState().addAdditionalOntology(url);

  // Add namespace and a sample triple to RDF manager so removeNamespaceAndQuads has something to remove
  await rdfManager.loadRDFIntoGraph(`@prefix ${prefix}: <${nsUri}> . ${prefix}:Class a <http://www.w3.org/2002/07/owl#Class> .`, "urn:vg:data");

  // Sanity checks before removal
  expect(useOntologyStore.getState().loadedOntologies.some((o) => o.url === url)).toBe(true);
  expect(useAppConfigStore.getState().config.additionalOntologies).toContain(url);
  expect(rdfManager.getNamespaces()[prefix]).toBe(nsUri);

  // Invoke removal
  useOntologyStore.getState().removeLoadedOntology(url);

  // Expectations after removal
  expect(useOntologyStore.getState().loadedOntologies.find((o) => o.url === url)).toBeUndefined();
  expect(useAppConfigStore.getState().config.additionalOntologies).not.toContain(url);
  // Namespace should be removed (best-effort)
  expect(rdfManager.getNamespaces()[prefix]).toBeUndefined();

  // Any triples in that namespace should be gone (best-effort)
  const quadsRemaining = rdfManager.getStore().getQuads(namedNode(`${nsUri}Class`), null, null, null) || [];
  expect(quadsRemaining.length).toBe(0);
});
