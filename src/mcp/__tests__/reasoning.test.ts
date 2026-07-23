// src/mcp/__tests__/reasoning.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockClearInferred, mockClearInferredCallback, mockRunReasoning, mockSetShaclEnabled,
  mockExplainEntailment, mockExplainInconsistency, mockExplainInconsistencyWithLaconic,
  mockValidate, mockFetchQuadsPage, mockRunShaclValidation, mockSparqlQuery,
  mockVerifyRepair, mockVerifyRepairDetailed, mockRunReasoningRdf,
} = vi.hoisted(() => ({
  mockClearInferred: vi.fn(),
  mockClearInferredCallback: vi.fn(),
  mockRunReasoning: vi.fn(),
  mockSetShaclEnabled: vi.fn(),
  mockExplainEntailment: vi.fn(),
  mockExplainInconsistency: vi.fn(),
  mockExplainInconsistencyWithLaconic: vi.fn(),
  mockValidate: vi.fn(),
  mockFetchQuadsPage: vi.fn(),
  mockRunShaclValidation: vi.fn(),
  mockSparqlQuery: vi.fn(),
  mockVerifyRepair: vi.fn(),
  mockVerifyRepairDetailed: vi.fn(),
  mockRunReasoningRdf: vi.fn(),
}));

vi.mock('@/mcp/workspaceContext', () => {
  const dataProvider = { clearInferred: mockClearInferred };
  return {
    getWorkspaceRefs: vi.fn(() => ({
      ctx: {},
      dataProvider,
      clearInferred: mockClearInferredCallback,
      runReasoning: mockRunReasoning,
    })),
  };
});

vi.mock('@/stores/appConfigStore', () => ({
  useAppConfigStore: {
    getState: vi.fn(() => ({
      config: { shaclEnabled: true },
      setShaclEnabled: mockSetShaclEnabled,
    })),
  },
}));

vi.mock('@/utils/rdfManager', () => ({
  rdfManager: {
    explainEntailment: mockExplainEntailment,
    explainInconsistency: mockExplainInconsistency,
    explainInconsistencyWithLaconic: mockExplainInconsistencyWithLaconic,
    validate: mockValidate,
    fetchQuadsPage: mockFetchQuadsPage,
    runShaclValidation: mockRunShaclValidation,
    sparqlQuery: mockSparqlQuery,
    verifyRepair: mockVerifyRepair,
    verifyRepairDetailed: mockVerifyRepairDetailed,
    runReasoning: mockRunReasoningRdf,
  },
}));

import { reasoningTools } from '../tools/reasoning';
import { getWorkspaceRefs } from '@/mcp/workspaceContext';

const tool = (name: string) => {
  const t = reasoningTools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
describe('runReasoning', () => {
  it('returns inferredTriples from meta.addedCount when available', async () => {
    mockRunReasoning.mockResolvedValueOnce({ meta: { addedCount: 42 } });
    const result = await tool('runReasoning').handler({});
    expect(result).toEqual({ success: true, data: { inferredTriples: 42, isConsistent: null, errors: [] } });
  });

  it('calls refs.runReasoning exactly once per invocation', async () => {
    mockRunReasoning.mockResolvedValueOnce({ meta: { addedCount: 5 } });
    await tool('runReasoning').handler({});
    expect(mockRunReasoning).toHaveBeenCalledOnce();
  });

  it('passes reasonerBackend: n3 through to refs.runReasoning', async () => {
    mockRunReasoning.mockResolvedValueOnce({ meta: { addedCount: 0 } });
    await tool('runReasoning').handler({ reasonerBackend: 'n3' });
    expect(mockRunReasoning).toHaveBeenCalledWith('n3');
  });

  it('passes reasonerBackend: konclude through to refs.runReasoning', async () => {
    mockRunReasoning.mockResolvedValueOnce({ meta: { addedCount: 0 } });
    await tool('runReasoning').handler({ reasonerBackend: 'konclude' });
    expect(mockRunReasoning).toHaveBeenCalledWith('konclude');
  });

  it('passes undefined when no reasonerBackend given (canvas uses config default)', async () => {
    mockRunReasoning.mockResolvedValueOnce({ meta: { addedCount: 0 } });
    await tool('runReasoning').handler({});
    expect(mockRunReasoning).toHaveBeenCalledWith(undefined);
  });

  it('still returns success when runReasoning is not registered', async () => {
    (getWorkspaceRefs as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      ctx: {},
      dataProvider: { clearInferred: mockClearInferred },
    });
    const result = await tool('runReasoning').handler({});
    expect(result).toEqual({ success: true, data: { inferredTriples: 0, isConsistent: null, errors: [] } });
  });

  it('falls back to inferences.length when meta.addedCount is absent', async () => {
    mockRunReasoning.mockResolvedValueOnce({
      inferences: [{ type: 'class', subject: 'a', predicate: 'b', object: 'c', confidence: 1 }],
    });
    const result = await tool('runReasoning').handler({});
    expect(result).toEqual({ success: true, data: { inferredTriples: 1, isConsistent: null, errors: [] } });
  });

  it('returns error if refs.runReasoning throws', async () => {
    mockRunReasoning.mockRejectedValueOnce(new Error('reasoning error'));
    const result = await tool('runReasoning').handler({});
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('reasoning error') });
  });

  it('does not toggle shaclEnabled when shaclValidation=true (default matches store)', async () => {
    mockRunReasoning.mockResolvedValueOnce({ meta: { addedCount: 0 } });
    await tool('runReasoning').handler({});
    expect(mockSetShaclEnabled).not.toHaveBeenCalled();
  });

  it('disables shaclEnabled when shaclValidation=false, then restores', async () => {
    mockRunReasoning.mockResolvedValueOnce({ meta: { addedCount: 0 } });
    await tool('runReasoning').handler({ shaclValidation: false });
    expect(mockSetShaclEnabled).toHaveBeenCalledWith(false);
    expect(mockSetShaclEnabled).toHaveBeenCalledWith(true);
  });

  it('restores shaclEnabled even when reasoning throws', async () => {
    mockRunReasoning.mockRejectedValueOnce(new Error('boom'));
    await tool('runReasoning').handler({ shaclValidation: false });
    expect(mockSetShaclEnabled).toHaveBeenCalledWith(true);
  });
});

// ---------------------------------------------------------------------------
describe('clearInferred', () => {
  it('calls registered clearInferred callback when available', async () => {
    const result = await tool('clearInferred').handler({});
    expect(result).toEqual({ success: true, data: { cleared: true } });
    expect(mockClearInferredCallback).toHaveBeenCalledOnce();
    expect(mockClearInferred).not.toHaveBeenCalled();
  });

  it('falls back to dataProvider.clearInferred() when callback not registered', async () => {
    (getWorkspaceRefs as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      ctx: {},
      dataProvider: { clearInferred: mockClearInferred },
    });
    const result = await tool('clearInferred').handler({});
    expect(result).toEqual({ success: true, data: { cleared: true } });
    expect(mockClearInferred).toHaveBeenCalledOnce();
  });

  it('returns error if clearInferred throws', async () => {
    (getWorkspaceRefs as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      ctx: {},
      dataProvider: { clearInferred: vi.fn() },
      clearInferred: vi.fn(() => { throw new Error('clear error'); }),
    });
    const result = await tool('clearInferred').handler({});
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('clear error') });
  });
});

// ---------------------------------------------------------------------------
describe('getCapabilities', () => {
  it('returns static layout algorithms and export formats', async () => {
    const result = await tool('getCapabilities').handler({});
    expect(result).toEqual({
      success: true,
      data: {
        layoutAlgorithms: ['dagre-lr', 'dagre-tb', 'elk-layered', 'elk-force', 'elk-stress', 'elk-radial'],
        exportFormats: ['turtle', 'jsonld', 'rdfxml', 'svg', 'png'],
        reasonerBackends: ['konclude', 'n3'],
      },
    });
  });
});

// ---------------------------------------------------------------------------
// explainEntailment
// ---------------------------------------------------------------------------
const SUB = 'http://example.org/A';
const PRED = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const OBJ = 'http://example.org/B';

describe('explainEntailment', () => {
  it('returns error when subjectIri is missing', async () => {
    const result = await tool('explainEntailment').handler({ predicateIri: PRED, objectIri: OBJ });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('requires') });
    expect(mockExplainEntailment).not.toHaveBeenCalled();
  });

  it('returns error when predicateIri is missing', async () => {
    const result = await tool('explainEntailment').handler({ subjectIri: SUB, objectIri: OBJ });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('requires') });
  });

  it('returns error when objectIri is missing', async () => {
    const result = await tool('explainEntailment').handler({ subjectIri: SUB, predicateIri: PRED });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('requires') });
  });

  it('returns ontologyInconsistent when the ontology has a contradiction', async () => {
    mockExplainEntailment.mockResolvedValueOnce({
      isEntailed: null,
      justifications: [],
      ontologyInconsistent: true,
      reason: 'Ontology is inconsistent',
    });
    const result = await tool('explainEntailment').handler({ subjectIri: SUB, predicateIri: PRED, objectIri: OBJ });
    expect(result).toMatchObject({
      success: true,
      data: {
        isEntailed: null,
        ontologyInconsistent: true,
        justifications: [],
      },
    });
    expect((result as any).data.summary).toContain('inconsistent');
    expect((result as any).data.summary).toContain('explainDiagnostics');
  });

  it('returns vacuous when subject class is unsatisfiable', async () => {
    mockExplainEntailment.mockResolvedValueOnce({
      isEntailed: true,
      justifications: [[{ subject: SUB, predicate: PRED, object: OBJ }]],
      vacuous: true,
      reason: 'Subject class is unsatisfiable',
    });
    const result = await tool('explainEntailment').handler({ subjectIri: SUB, predicateIri: PRED, objectIri: OBJ });
    expect(result).toMatchObject({
      success: true,
      data: { isEntailed: true, vacuous: true },
    });
    expect((result as any).data.summary).toContain('VACUOUSLY');
    expect((result as any).data.summary).toContain('unsatisfiable');
  });

  it('returns NOT entailed when the axiom does not hold', async () => {
    mockExplainEntailment.mockResolvedValueOnce({
      isEntailed: false,
      justifications: [],
    });
    const result = await tool('explainEntailment').handler({ subjectIri: SUB, predicateIri: PRED, objectIri: OBJ });
    expect(result).toMatchObject({
      success: true,
      data: { isEntailed: false, justifications: [] },
    });
    expect((result as any).data.summary).toContain('NOT entailed');
  });

  it('returns directly asserted when entailed with no justifications', async () => {
    mockExplainEntailment.mockResolvedValueOnce({
      isEntailed: true,
      justifications: [],
    });
    const result = await tool('explainEntailment').handler({ subjectIri: SUB, predicateIri: PRED, objectIri: OBJ });
    expect(result).toMatchObject({
      success: true,
      data: { isEntailed: true, justifications: [] },
    });
    expect((result as any).data.summary).toContain('directly asserted');
  });

  it('formats justification axioms in the summary', async () => {
    const j1 = { subject: 'http://ex.org/A', predicate: 'http://ex.org/subClassOf', object: 'http://ex.org/B' };
    const j2 = { subject: 'http://ex.org/B', predicate: 'http://ex.org/subClassOf', object: 'http://ex.org/C' };
    mockExplainEntailment.mockResolvedValueOnce({
      isEntailed: true,
      justifications: [[j1, j2]],
    });
    const result = await tool('explainEntailment').handler({ subjectIri: SUB, predicateIri: PRED, objectIri: OBJ });
    expect(result).toMatchObject({ success: true, data: { isEntailed: true } });
    expect((result as any).data.summary).toContain('inferred because');
    expect((result as any).data.justifications).toHaveLength(1);
    expect((result as any).data.justifications[0]).toHaveLength(2);
  });

  it('numbers multiple justification sets', async () => {
    const ax = { subject: 'http://ex.org/X', predicate: 'http://ex.org/p', object: 'http://ex.org/Y' };
    mockExplainEntailment.mockResolvedValueOnce({
      isEntailed: true,
      justifications: [[ax], [ax]],
    });
    const result = await tool('explainEntailment').handler({ subjectIri: SUB, predicateIri: PRED, objectIri: OBJ });
    expect((result as any).data.summary).toContain('[1]');
    expect((result as any).data.summary).toContain('[2]');
  });

  it('passes maxJustifications to rdfManager', async () => {
    mockExplainEntailment.mockResolvedValueOnce({ isEntailed: false, justifications: [] });
    await tool('explainEntailment').handler({ subjectIri: SUB, predicateIri: PRED, objectIri: OBJ, maxJustifications: 5 });
    expect(mockExplainEntailment).toHaveBeenCalledWith(SUB, PRED, OBJ, { maxJustifications: 5 });
  });

  it('returns error when rdfManager.explainEntailment throws', async () => {
    mockExplainEntailment.mockRejectedValueOnce(new Error('worker died'));
    const result = await tool('explainEntailment').handler({ subjectIri: SUB, predicateIri: PRED, objectIri: OBJ });
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('worker died') });
  });
});

// ---------------------------------------------------------------------------
// explainDiagnostics — handler-level wiring tests (mocked rdfManager)
//
// Pipeline correctness (MIPS → repairs → weakening → verification →
// minimality → brief) is tested with REAL Konclude in
// explainDiagnostics.integration.test.ts. These tests cover handler-specific
// dispatch logic that requires mocking rdfManager: laconic API fallback,
// matchWarning from verifyRepairDetailed, SHACL threading, error wrapping,
// and arg passthrough.
// ---------------------------------------------------------------------------

const MIPS_AXIOM_1 = { subject: 'http://ex.org/A', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://ex.org/B' };
const MIPS_AXIOM_2 = { subject: 'http://ex.org/C', predicate: 'http://www.w3.org/2000/01/rdf-schema#subClassOf', object: 'http://ex.org/D' };

function setupConsistentMocks() {
  mockRunReasoningRdf.mockResolvedValue({ isConsistent: true });
  mockValidate.mockResolvedValue({ unsatisfiable: [] });
  mockFetchQuadsPage.mockResolvedValue({ items: [] });
  mockRunShaclValidation.mockResolvedValue({ violations: [] });
}

function setupInconsistentMocks() {
  mockRunReasoningRdf.mockResolvedValue({ isConsistent: false });
  mockExplainInconsistencyWithLaconic.mockResolvedValue({
    justifications: [[MIPS_AXIOM_1, MIPS_AXIOM_2]],
    laconicJustifications: [],
  });
  mockValidate.mockResolvedValue({ unsatisfiable: [] });
  mockFetchQuadsPage.mockResolvedValue({ items: [] });
  mockRunShaclValidation.mockResolvedValue({ violations: [] });
  mockSparqlQuery.mockResolvedValue({ type: 'select', rows: [] });
  mockVerifyRepair.mockResolvedValue(false);
  mockVerifyRepairDetailed.mockResolvedValue({ verifiedConsistent: true, matchedCount: 1, requestedCount: 1 });
}

describe('explainDiagnostics — handler wiring', () => {
  it('laconic fallback: uses explainInconsistency when laconic method absent', async () => {
    setupInconsistentMocks();
    const { rdfManager } = await import('@/utils/rdfManager');
    const original = rdfManager.explainInconsistencyWithLaconic;
    (rdfManager as any).explainInconsistencyWithLaconic = undefined;
    mockExplainInconsistency.mockResolvedValue([[MIPS_AXIOM_1, MIPS_AXIOM_2]]);

    const result = await tool('explainDiagnostics').handler({});

    (rdfManager as any).explainInconsistencyWithLaconic = original;
    expect(result).toMatchObject({ success: true });
    expect(mockExplainInconsistency).toHaveBeenCalled();
    expect((result as any).data.justifications).toHaveLength(1);
  });

  it('consistent ontology skips MIPS and verification calls', async () => {
    setupConsistentMocks();
    const result = await tool('explainDiagnostics').handler({});
    expect(result).toMatchObject({
      success: true,
      data: {
        isConsistent: true,
        justifications: [],
        repairSetVerifiedConsistent: null,
      },
    });
    expect(mockExplainInconsistency).not.toHaveBeenCalled();
    expect(mockExplainInconsistencyWithLaconic).not.toHaveBeenCalled();
    expect(mockVerifyRepair).not.toHaveBeenCalled();
  });

  it('surfaces repairSetMatchWarning when matchedCount < requestedCount', async () => {
    setupInconsistentMocks();
    mockVerifyRepairDetailed.mockResolvedValue({
      verifiedConsistent: false,
      matchedCount: 0,
      requestedCount: 1,
    });
    const result = await tool('explainDiagnostics').handler({});
    expect(result).toMatchObject({ success: true });
    expect((result as any).data.repairSetMatchWarning).toContain('0 of 1');
  });

  it('threads SHACL violations through when ontology is consistent', async () => {
    setupConsistentMocks();
    mockRunShaclValidation.mockResolvedValue({
      violations: [{ focusNode: 'http://ex.org/x', message: 'missing property', severity: 'Violation' }],
    });
    const result = await tool('explainDiagnostics').handler({});
    expect(result).toMatchObject({ success: true });
    expect((result as any).data.shaclViolations).toHaveLength(1);
  });

  it('wraps runReasoning exception as { success: false }', async () => {
    mockRunReasoningRdf.mockRejectedValue(new Error('wasm crash'));
    const result = await tool('explainDiagnostics').handler({});
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('wasm crash'),
    });
  });

  it('passes maxJustifications to the inconsistency explainer', async () => {
    setupInconsistentMocks();
    await tool('explainDiagnostics').handler({ maxJustifications: 7 });
    expect(mockExplainInconsistencyWithLaconic).toHaveBeenCalledWith(7);
  });
});
