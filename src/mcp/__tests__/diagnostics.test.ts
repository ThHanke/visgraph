// src/mcp/__tests__/diagnostics.test.ts
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRunReasoning,
  mockExplainInconsistency,
  mockExplainInconsistencyWithLaconic,
  mockRunShacl,
  mockValidate,
  mockFetchQuadsPage,
  mockVerifyRepair,
  mockVerifyRepairDetailed,
} = vi.hoisted(() => ({
  mockRunReasoning: vi.fn(),
  mockExplainInconsistency: vi.fn(),
  mockExplainInconsistencyWithLaconic: vi.fn(),
  mockRunShacl: vi.fn(),
  mockValidate: vi.fn(),
  mockFetchQuadsPage: vi.fn(),
  mockVerifyRepair: vi.fn(),
  mockVerifyRepairDetailed: vi.fn(),
}));

// NOTE: explainInconsistencyWithLaconic is intentionally OMITTED from the default
// mock object so reasoning.ts falls back to explainInconsistency for the existing
// suite (which asserts explainInconsistency call args). The dedicated laconic test
// below re-mocks rdfManager to add it.
vi.mock('@/utils/rdfManager', () => ({
  rdfManager: {
    runReasoning: mockRunReasoning,
    explainInconsistency: mockExplainInconsistency,
    runShaclValidation: mockRunShacl,
    validate: mockValidate,
    fetchQuadsPage: mockFetchQuadsPage,
    verifyRepair: mockVerifyRepair,
    verifyRepairDetailed: mockVerifyRepairDetailed,
  },
}));

// reasoning.ts also imports these — keep them inert for this suite.
vi.mock('@/mcp/workspaceContext', () => ({ getWorkspaceRefs: vi.fn(() => ({ ctx: {}, dataProvider: {} })) }));
vi.mock('@/stores/appConfigStore', () => ({
  useAppConfigStore: { getState: vi.fn(() => ({ config: { shaclEnabled: true }, setShaclEnabled: vi.fn() })) },
}));

import { reasoningTools } from '../tools/reasoning';
import { rdfManager } from '@/utils/rdfManager';

const explainDiagnostics = reasoningTools.find((t) => t.name === 'explainDiagnostics')!;

beforeEach(() => {
  vi.clearAllMocks();
  // sensible "clean" defaults; individual tests override.
  mockRunReasoning.mockResolvedValue({ isConsistent: true, errors: [] });
  mockExplainInconsistency.mockResolvedValue([]);
  mockRunShacl.mockResolvedValue({ conforms: true, violations: [], shapeCount: 0 });
  mockValidate.mockResolvedValue({ consistent: true, unsatisfiable: [] });
  mockFetchQuadsPage.mockResolvedValue({ items: [] });
  mockVerifyRepair.mockResolvedValue(true);
  mockVerifyRepairDetailed.mockResolvedValue({
    verifiedConsistent: true,
    removedCount: 1,
    requestedCount: 1,
    matchedCount: 1,
  });
});

describe('explainDiagnostics', () => {
  it('is registered', () => {
    expect(explainDiagnostics).toBeTruthy();
  });

  it('clean graph → consistent, no issues, "No issues detected." brief', async () => {
    const res = await explainDiagnostics.handler({});
    expect(res.success).toBe(true);
    expect(res.data.isConsistent).toBe(true);
    expect(res.data.justifications).toEqual([]);
    expect(res.data.repairBrief).toBe('No issues detected.');
    // does not call explainInconsistency when consistent
    expect(mockExplainInconsistency).not.toHaveBeenCalled();
  });

  it('inconsistent graph → returns justifications and a clash brief', async () => {
    mockRunReasoning.mockResolvedValue({ isConsistent: false, errors: [] });
    mockExplainInconsistency.mockResolvedValue([
      [
        { subject: 'http://ex/frank', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://ex/Employee' },
        { subject: 'http://ex/Employee', predicate: 'http://www.w3.org/2002/07/owl#disjointWith', object: 'http://ex/Contractor' },
      ],
    ]);
    const res = await explainDiagnostics.handler({ maxJustifications: 2 });
    expect(res.success).toBe(true);
    expect(res.data.isConsistent).toBe(false);
    expect(res.data.justifications).toHaveLength(1);
    expect(res.data.justifications[0]).toHaveLength(2);
    expect(mockExplainInconsistency).toHaveBeenCalledWith(2);
    expect(res.data.repairBrief.toLowerCase()).toContain('disjointwith');
  });

  it('inconsistent graph → returns ranked, verified suggestedRepairs targeting a justification axiom', async () => {
    mockRunReasoning.mockResolvedValue({ isConsistent: false, errors: [] });
    const mips = [
      [
        { subject: 'http://ex/frank', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://ex/Employee' },
        { subject: 'http://ex/frank', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://ex/Contractor' },
        { subject: 'http://ex/Employee', predicate: 'http://www.w3.org/2002/07/owl#disjointWith', object: 'http://ex/Contractor' },
      ],
    ];
    mockExplainInconsistency.mockResolvedValue(mips);
    mockVerifyRepair.mockResolvedValue(true);

    const res = (await explainDiagnostics.handler({ maxJustifications: 3 })) as { success: boolean; data: any };
    expect(res.success).toBe(true);
    expect(Array.isArray(res.data.suggestedRepairs)).toBe(true);
    expect(res.data.suggestedRepairs.length).toBeGreaterThanOrEqual(1);

    const top = res.data.suggestedRepairs[0];
    // The action targets an axiom that actually appears in a justification.
    const axiomKeys = new Set(mips.flat().map((a) => `${a.subject} ${a.predicate} ${a.object}`));
    const topKey = `${top.action.args.subjectIri} ${top.action.args.predicateIri} ${top.action.args.objectIri}`;
    expect(axiomKeys.has(topKey)).toBe(true);
    // The top candidate was symbolically verified.
    expect(top.verifiedConsistent).toBe(true);
    expect(top.action.tool).toMatch(/removeLink|removeTriple/);
    // verifyRepair was invoked with the chosen axiom.
    expect(mockVerifyRepair).toHaveBeenCalled();
    // The brief enumerates the ranked repairs.
    expect(res.data.repairBrief).toContain('SUGGESTED REPAIRS');
  });

  it('does not call verifyRepair when the graph is consistent', async () => {
    await explainDiagnostics.handler({});
    expect(mockVerifyRepair).not.toHaveBeenCalled();
    expect(mockVerifyRepairDetailed).not.toHaveBeenCalled();
  });

  it('M2: two disjoint contradictions → per-axiom false, but full-set verified true is surfaced', async () => {
    mockRunReasoning.mockResolvedValue({ isConsistent: false, errors: [] });
    // Two INDEPENDENT contradictions (no shared axiom).
    const mips = [
      [
        { subject: 'http://ex/frank', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://ex/A' },
        { subject: 'http://ex/frank', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://ex/B' },
      ],
      [
        { subject: 'http://ex/gina', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://ex/P' },
        { subject: 'http://ex/gina', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://ex/Q' },
      ],
    ];
    mockExplainInconsistency.mockResolvedValue(mips);
    // Per-axiom removal NEVER restores consistency (the other clash remains).
    mockVerifyRepair.mockResolvedValue(false);
    // The FULL set together DOES restore consistency.
    mockVerifyRepairDetailed.mockResolvedValue({
      verifiedConsistent: true,
      removedCount: 2,
      requestedCount: 2,
      matchedCount: 2,
    });

    const res = (await explainDiagnostics.handler({ maxJustifications: 3 })) as { success: boolean; data: any };
    expect(res.success).toBe(true);

    const inc = res.data.suggestedRepairs.filter((r: any) => r.issue === 'inconsistency' && !r.needsManualReview);
    expect(inc.length).toBeGreaterThanOrEqual(2);
    // Every per-axiom verdict is false…
    for (const r of inc) expect(r.verifiedConsistent).toBe(false);
    // …yet the full-set verdict is true and surfaced both top-level and per-repair.
    expect(res.data.repairSetVerifiedConsistent).toBe(true);
    for (const r of inc) expect(r.verifiedSet).toBe(true);
    // The brief must NOT read a per-axiom false as "this repair is wrong".
    expect(res.data.repairBrief).toContain('apply the full repair set');
    expect(res.data.repairBrief).toContain('restore consistency');
    // The FIRST verifyRepairDetailed call carries ALL removals (the full-set
    // check); any subsequent calls are the bounded subset-minimality search.
    expect(mockVerifyRepairDetailed).toHaveBeenCalled();
    expect(mockVerifyRepairDetailed.mock.calls[0][0]).toHaveLength(2);
  });

  it('BUG B: per-axiom AND full-set verifyRepair receive the graph + typed-literal threaded from the MIPS', async () => {
    mockRunReasoning.mockResolvedValue({ isConsistent: false, errors: [] });
    const XSD_INT = 'http://www.w3.org/2001/XMLSchema#integer';
    // A single-axiom MIPS whose covering axiom lives in urn:vg:ontologies and
    // has a typed-literal object — the worker's explainInconsistency threads
    // graph + objectTermType + objectDatatype, which computeRepairs carries into
    // action.args. The verify call MUST forward them so it matches the SAME
    // triple the apply path (removeLink) removes.
    mockExplainInconsistency.mockResolvedValue([
      [
        {
          subject: 'http://ex/i',
          predicate: 'http://ex/age',
          object: '42',
          objectTermType: 'Literal',
          objectDatatype: XSD_INT,
          graph: 'urn:vg:ontologies',
        },
      ],
    ]);
    mockVerifyRepair.mockResolvedValue(true);
    mockVerifyRepairDetailed.mockResolvedValue({
      verifiedConsistent: true, removedCount: 1, requestedCount: 1, matchedCount: 1,
    });

    const res = (await explainDiagnostics.handler({ maxJustifications: 3 })) as { success: boolean; data: any };
    expect(res.success).toBe(true);

    // Per-axiom verifyRepair was called with the EXACT structured removal.
    expect(mockVerifyRepair).toHaveBeenCalled();
    const perAxiom = mockVerifyRepair.mock.calls[0][0];
    expect(perAxiom).toHaveLength(1);
    expect(perAxiom[0]).toMatchObject({
      subject: 'http://ex/i',
      predicate: 'http://ex/age',
      object: '42',
      objectTermType: 'Literal',
      objectDatatype: XSD_INT,
      graph: 'urn:vg:ontologies',
    });

    // The FIRST (full-set) verifyRepairDetailed call carries the same metadata;
    // any subsequent calls are the bounded subset-minimality search.
    expect(mockVerifyRepairDetailed).toHaveBeenCalled();
    const fullSet = mockVerifyRepairDetailed.mock.calls[0][0];
    expect(fullSet[0]).toMatchObject({
      objectTermType: 'Literal',
      objectDatatype: XSD_INT,
      graph: 'urn:vg:ontologies',
    });
  });

  it('L2: a matchedCount < requestedCount surfaces a warning (nothing-matched vs still-inconsistent)', async () => {
    mockRunReasoning.mockResolvedValue({ isConsistent: false, errors: [] });
    mockExplainInconsistency.mockResolvedValue([
      [
        { subject: 'http://ex/frank', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://ex/A' },
        { subject: 'http://ex/frank', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://ex/B' },
      ],
    ]);
    mockVerifyRepair.mockResolvedValue(false);
    // One removal requested but zero matched (serialization mismatch).
    mockVerifyRepairDetailed.mockResolvedValue({
      verifiedConsistent: false,
      removedCount: 0,
      requestedCount: 1,
      matchedCount: 0,
    });
    const res = (await explainDiagnostics.handler({})) as { success: boolean; data: any };
    expect(res.success).toBe(true);
    expect(res.data.repairSetMatchWarning).toBeTruthy();
    expect(res.data.repairSetMatchWarning).toContain('0 of 1');
    expect(res.data.repairBrief).toContain('WARNING');
  });

  it('unsatisfiable class from Konclude is reported', async () => {
    mockValidate.mockResolvedValue({ consistent: true, unsatisfiable: ['http://ex/EmptyClass'] });
    const res = await explainDiagnostics.handler({});
    expect(res.data.unsatisfiableClasses).toContain('http://ex/EmptyClass');
    expect(res.data.repairBrief).toContain('EmptyClass');
  });

  // Profile detection removed — will be re-added via rdf-reasoner-konclude API.

  it('SHACL violation is reported', async () => {
    mockRunShacl.mockResolvedValue({
      conforms: false,
      violations: [{ focusNode: 'http://ex/projectAlpha', path: null, severity: 'sh:Violation', message: 'missing rdfs:comment', sourceShape: 'http://ex/S', constraint: 'http://www.w3.org/ns/shacl#MinCountConstraintComponent' }],
      shapeCount: 1,
    });
    const res = await explainDiagnostics.handler({});
    expect(res.data.shaclViolations).toHaveLength(1);
    expect(res.data.repairBrief).toContain('projectAlpha');
  });

  it('returns success:false with context on internal error', async () => {
    mockRunReasoning.mockRejectedValue(new Error('worker boom'));
    const res = await explainDiagnostics.handler({});
    expect(res.success).toBe(false);
    expect(res.error).toContain('explainDiagnostics');
    expect(res.error).toContain('worker boom');
  });

  // LACONIC threading (Horridge et al. ISWC 2008): when rdfManager exposes the
  // laconic-enriched call, explainDiagnostics threads laconicJustifications into
  // the response data and surfaces the precise culprit PART in the repair brief.
  it('threads laconicJustifications into the response and brief when available', async () => {
    mockRunReasoning.mockResolvedValue({ isConsistent: false, errors: [] });
    const justifications = [
      [
        { subject: 'http://ex/A', predicate: 'http://www.w3.org/2000/01/rdf-schema#subClassOf', object: '_:int' },
        { subject: 'http://ex/B', predicate: 'http://www.w3.org/2002/07/owl#disjointWith', object: 'http://ex/D' },
        { subject: 'http://ex/x', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://ex/A' },
        { subject: 'http://ex/x', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://ex/D' },
      ],
    ];
    const laconicJustifications = [
      {
        sharpened: true,
        skipped: false,
        parts: [
          {
            subject: 'http://ex/A',
            predicate: 'http://www.w3.org/2000/01/rdf-schema#subClassOf',
            object: 'http://ex/B',
            sourceSubject: 'http://ex/A',
            sourcePredicate: 'http://www.w3.org/2000/01/rdf-schema#subClassOf',
            sourceObject: '_:int',
            isPartOf: true,
          },
        ],
      },
    ];
    mockExplainInconsistencyWithLaconic.mockResolvedValue({ justifications, laconicJustifications });
    // Inject the laconic-enriched method onto the mocked rdfManager for this test.
    (rdfManager as unknown as { explainInconsistencyWithLaconic?: unknown }).explainInconsistencyWithLaconic =
      mockExplainInconsistencyWithLaconic;
    mockVerifyRepair.mockResolvedValue(true);

    try {
      const res = (await explainDiagnostics.handler({ maxJustifications: 3 })) as {
        success: boolean;
        data: any;
      };
      expect(res.success).toBe(true);
      // The laconic refinement is surfaced in the response data …
      expect(Array.isArray(res.data.laconicJustifications)).toBe(true);
      expect(res.data.laconicJustifications[0].sharpened).toBe(true);
      expect(res.data.laconicJustifications[0].parts[0].object).toBe('http://ex/B');
      // … and the precise culprit PART is rendered in the brief.
      expect(res.data.repairBrief).toContain('Precise culprit');
      expect(res.data.repairBrief).toContain('part of');
      expect(mockExplainInconsistencyWithLaconic).toHaveBeenCalledWith(3);
    } finally {
      delete (rdfManager as unknown as { explainInconsistencyWithLaconic?: unknown })
        .explainInconsistencyWithLaconic;
    }
  });
});
