import { test, expect, vi } from "vitest";
import { useOntologyStore } from "../../stores/ontologyStore";
import { RDFManagerImpl } from "../../utils/rdfManager.impl";

const SAMPLE_TTL = `
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>.
@prefix owl: <http://www.w3.org/2002/07/owl#>.
@prefix : <https://w3id.org/pmd/co/test/shape7/>.

<https://w3id.org/pmd/co/test/shape7> a owl:Ontology;
    owl:imports <https://w3id.org/pmd/co/>.
:dummy a owl:NamedIndividual.
`;

test("discoverReferencedOntologies reports failure progress for large imports", async () => {
  const originalLoadOntology = useOntologyStore.getState().loadOntology;
  const originalManager = useOntologyStore.getState().rdfManager;

  const manager = new RDFManagerImpl();
  useOntologyStore.setState({
    rdfManager: manager,
    loadedOntologies: [],
    availableClasses: [],
    availableProperties: [],
    namespaceRegistry: [],
  } as any);

  try {
    await useOntologyStore
      .getState()
      .loadOntologyFromRDF(SAMPLE_TTL, undefined, false, "urn:vg:data");

    const progress: Array<{ pct: number; message: string }> = [];
    const onProgress = vi.fn((pct: number, message: string) => {
      progress.push({ pct, message });
    });

    const failingLoad = vi.fn().mockResolvedValue({
      success: false,
      url: "https://w3id.org/pmd/co/",
      error: "simulated failure",
    });

    useOntologyStore.setState({ loadOntology: failingLoad } as any);

    const discovery = useOntologyStore.getState().discoverReferencedOntologies;
    expect(discovery).toBeDefined();

    await expect(
      discovery?.({
        graphName: "urn:vg:data",
        load: "sync",
        onProgress,
      }),
    ).rejects.toThrow("simulated failure");

    expect(failingLoad).toHaveBeenCalledWith("https://w3id.org/pmd/co/", { autoload: true });
    expect(onProgress).toHaveBeenCalled();
    expect(progress.some((entry) => entry.pct === 100)).toBe(true);
  } finally {
    useOntologyStore.setState({
      rdfManager: originalManager,
      loadOntology: originalLoadOntology,
      loadedOntologies: [],
      availableClasses: [],
      availableProperties: [],
      namespaceRegistry: [],
    } as any);
  }
});
