// src/mcp/tools/diagnosticsBrief.ts
// Pure function: turns structured diagnostics into a ranked, plain-language,
// agent-actionable repair brief.

export interface DiagnosticsData {
  isConsistent: boolean | null;
  /**
   * Inconsistency justifications (MIPS). Each axiom carries the optional source
   * `graph` it physically resides in (urn:vg:data OR urn:vg:ontologies for
   * imported schema axioms) and, for literal objects, the object term's
   * `objectTermType`/`objectDatatype`/`objectLanguage`. These flow end-to-end
   * so the apply path targets the correct graph and reconstructs the EXACT
   * typed/lang literal (C1 + H2). All extra fields are OPTIONAL for back-compat.
   */
  justifications: {
    subject: string;
    predicate: string;
    object: string;
    objectTermType?: string;
    objectDatatype?: string;
    objectLanguage?: string;
    graph?: string;
  }[][];
  /**
   * LACONIC justifications (Horridge, Parsia, Sattler, ISWC 2008) — the
   * superfluous-part-free refinement of `justifications`, aligned BY INDEX:
   * entry i sharpens justification i. Each `part` is the precise culprit axiom
   * PART (e.g. the `A ⊑ B` part of `A ⊑ B ⊓ C`) and carries its source axiom's
   * principal triple (sourceSubject/sourcePredicate/sourceObject) so the brief
   * can attribute "the `A ⊑ B` part of axiom `A ⊑ B ⊓ C` is the culprit".
   * `sharpened` ⇒ laconic dropped a superfluous part; `skipped` ⇒ the worker's
   * cost cap suppressed laconic for this MIPS (parts == the regular axioms).
   * OPTIONAL: absent on older worker builds / non-inconsistency diagnostics.
   */
  laconicJustifications?: {
    parts: {
      subject: string;
      predicate: string;
      object: string;
      objectIsLiteral?: boolean;
      sourceSubject: string;
      sourcePredicate: string;
      sourceObject: string;
      isPartOf: boolean;
    }[];
    sharpened: boolean;
    skipped: boolean;
  }[];
  unsatisfiableClasses: string[];
  // TODO(rdf-reasoner-konclude): re-add profile/expressivity once reasoner
  // exposes detectProfiles(store) with per-named-graph EL/QL/RL/DL classification.
  profile?: {
    owl2dl: boolean;
    violations: { axiom: string; reason: string }[];
    el?: { valid: boolean; violations: { construct: string; axiom: string; reason: string }[] };
    ql?: { valid: boolean; violations: { construct: string; axiom: string; reason: string }[] };
    rl?: { valid: boolean; violations: { construct: string; axiom: string; reason: string }[] };
    mostRestrictive?: 'EL' | 'QL' | 'RL' | 'DL' | 'Full';
  };
  shaclViolations: {
    focusNode: string | null;
    path: string | null;
    severity: string | null;
    message: string | null;
    sourceShape: string | null;
    constraint: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// IRI → local name helper
// ---------------------------------------------------------------------------

/** Returns the local name after the last '#' or '/', or the full string if neither. */
function localName(iri: string): string {
  if (!iri) return iri;
  const hashIdx = iri.lastIndexOf('#');
  if (hashIdx !== -1 && hashIdx < iri.length - 1) return iri.slice(hashIdx + 1);
  const slashIdx = iri.lastIndexOf('/');
  if (slashIdx !== -1 && slashIdx < iri.length - 1) return iri.slice(slashIdx + 1);
  return iri;
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function buildInconsistencySection(
  justifications: DiagnosticsData['justifications'],
  laconic?: DiagnosticsData['laconicJustifications'],
): string {
  const lines: string[] = ['1. INCONSISTENCY (most severe)'];

  if (justifications.length > 1) {
    lines.push(
      `   The ontology has ${justifications.length} independent contradictions; each must be resolved.`,
    );
  }

  justifications.forEach((axiomSet, idx) => {
    lines.push(`   Justification ${idx + 1}:`);
    for (const ax of axiomSet) {
      lines.push(
        `     - ${localName(ax.subject)} ${localName(ax.predicate)} ${localName(ax.object)}`,
      );
    }

    // LACONIC sharpening (Horridge et al. ISWC 2008): when the laconic
    // refinement of THIS justification dropped a superfluous axiom part, surface
    // the precise culprit PART and the axiom it came from, so the agent removes/
    // weakens the minimal thing rather than the whole conjunction.
    const lac = laconic?.[idx];
    if (lac && lac.sharpened && lac.parts.length > 0) {
      lines.push('   Precise culprit (laconic — superfluous parts removed):');
      for (const part of lac.parts) {
        const partText = `${localName(part.subject)} ${localName(part.predicate)} ${localName(part.object)}`;
        if (
          part.isPartOf &&
          (part.sourceSubject !== part.subject ||
            part.sourcePredicate !== part.predicate ||
            part.sourceObject !== part.object)
        ) {
          const srcText = `${localName(part.sourceSubject)} ${localName(part.sourcePredicate)} ${localName(part.sourceObject)}`;
          lines.push(`     • ${partText} (part of ${srcText})`);
        } else {
          lines.push(`     • ${partText}`);
        }
      }
    }

    lines.push(
      '   To resolve, remove or revise at least one axiom in this set.',
    );
  });

  return lines.join('\n');
}

function buildProfileSection(
  profile: DiagnosticsData['profile'],
  num: number,
): string {
  const lines: string[] = [`${num}. OWL 2 DL PROFILE VIOLATIONS`];
  for (const v of profile.violations) {
    lines.push(`   - Axiom: ${localName(v.axiom)}`);
    lines.push(`     Reason: ${v.reason}`);
  }
  if (profile.mostRestrictive) {
    lines.push(
      `   Tightest fitting OWL 2 profile: ${profile.mostRestrictive}` +
        ` (EL=${profile.el?.valid ? 'in' : 'out'},` +
        ` QL=${profile.ql?.valid ? 'in' : 'out'},` +
        ` RL=${profile.rl?.valid ? 'in' : 'out'}).`,
    );
  }
  return lines.join('\n');
}

function buildShaclSection(
  violations: DiagnosticsData['shaclViolations'],
  num: number,
): string {
  // Group by severity
  const bySeverity = new Map<string, DiagnosticsData['shaclViolations']>();
  for (const v of violations) {
    const sev = v.severity ?? 'Unknown';
    if (!bySeverity.has(sev)) bySeverity.set(sev, []);
    bySeverity.get(sev)!.push(v);
  }

  const lines: string[] = [`${num}. SHACL VIOLATIONS`];
  for (const [severity, group] of bySeverity.entries()) {
    lines.push(`   [${severity}]`);
    for (const v of group) {
      const focus = v.focusNode ? localName(v.focusNode) : '(unknown)';
      const path = v.path ? localName(v.path) : '(no path)';
      const msg = v.message ?? '(no message)';
      lines.push(`   - Focus: ${focus} | Path: ${path}`);
      lines.push(`     Message: ${msg}`);
    }
  }
  lines.push(
    '   Add or correct the data to satisfy the shape.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Suggested-repairs section (R1)
// ---------------------------------------------------------------------------

/** Minimal shape of a repair suggestion this brief needs (kept local to avoid a cycle). */
export interface BriefRepair {
  id: string;
  issue: string;
  action: {
    tool: string;
    args: {
      subjectIri?: string;
      predicateIri?: string;
      objectIri?: string;
      // C1 + H2: source graph + object term metadata threaded from the MIPS so
      // the apply path hits the right graph and reconstructs the exact literal.
      graph?: string;
      objectTermType?: string;
      objectDatatype?: string;
      objectLanguage?: string;
    };
  };
  rationale: string;
  verifiedConsistent?: boolean;
  verifiedSet?: boolean;
  needsValue?: boolean;
  needsManualReview?: boolean;
  /** 'weaken' for axiom-weakening alternatives; absent/'delete' for deletions. */
  kind?: string;
  /** For weakenings: the deletion repair id this is an alternative to. */
  alternativeTo?: string;
  /** For weakenings: "A ⊑ D" — the original, stronger axiom. */
  weakerThan?: string;
  /** For weakenings: true when the weakening is symbolically verified. */
  weakeningVerified?: boolean;
}

/** Extra verification context surfaced alongside the ranked repair list. */
export interface RepairBriefOptions {
  /**
   * Result of removing the FULL hitting set at once. true ⇒ applying ALL the
   * suggested inconsistency repairs together restores consistency; false ⇒ it
   * does not (manual review needed); null/undefined ⇒ not verified.
   */
  repairSetVerifiedConsistent?: boolean | null;
  /** Warning when some repair axioms matched no triple during verification. */
  repairSetMatchWarning?: string;
}

function buildSuggestedRepairsSection(
  repairs: BriefRepair[],
  options: RepairBriefOptions = {},
): string {
  const lines: string[] = ['SUGGESTED REPAIRS (ranked):'];

  const hasMultiple =
    repairs.filter((r) => r.issue === 'inconsistency' && !r.needsManualReview).length > 1;

  const hasWeakenings = repairs.some((r) => r.kind === 'weaken');

  repairs.forEach((r) => {
    if (r.needsManualReview) {
      lines.push(`   ${r.id}. [manual review] — ${r.rationale}`);
      return;
    }
    // Axiom-weakening alternatives (Troquard et al. 2018; Li & Lambrix 2024):
    // a LESS-destructive replacement of the culprit `A ⊑ D` with a weaker
    // `A ⊑ D′` — preserves more knowledge than deletion. Rendered distinctly.
    if (r.kind === 'weaken') {
      const wv =
        r.weakeningVerified === true
          ? ' [verified: removal restores consistency; weaker axiom is entailed by it]'
          : '';
      const alt = r.alternativeTo ? ` (alternative to deletion ${r.alternativeTo})` : '';
      lines.push(`   ${r.id}. [weaken]${alt} — ${r.rationale}${wv}`);
      return;
    }
    // A per-axiom `false` does NOT mean the repair is wrong: with multiple
    // independent contradictions no single removal restores consistency on its
    // own. Render it as "not alone" and point to the full set.
    const verify =
      r.verifiedConsistent === true
        ? ' [verified: removing this alone restores consistency]'
        : r.verifiedConsistent === false
          ? hasMultiple
            ? ' [verified: does NOT restore consistency ALONE — apply the full repair set below]'
            : ' [verified: does NOT alone restore consistency]'
          : '';
    const value = r.needsValue ? ' [you must supply a value]' : '';
    const kindTag = hasWeakenings ? ' [delete]' : '';
    lines.push(`   ${r.id}. ${r.action.tool}${kindTag} — ${r.rationale}${verify}${value}`);
  });

  if (hasWeakenings) {
    lines.push(
      '   ⇒ NOTE: [weaken] repairs replace a culprit A ⊑ D with a logically weaker ' +
        'A ⊑ D′ (D′ ⊒ D) — they PRESERVE MORE KNOWLEDGE than the [delete] alternative. ' +
        'Prefer the most-specific weakening that restores consistency; fall back to ' +
        'deletion only when no weakening suffices (Troquard et al. 2018; Li & Lambrix 2024).',
    );
  }

  // Full-set verdict (M2): the union of the suggested repairs is the actual fix.
  if (options.repairSetVerifiedConsistent === true) {
    lines.push(
      '   ⇒ Applying ALL of the above inconsistency repairs together is verified to restore consistency.',
    );
  } else if (options.repairSetVerifiedConsistent === false) {
    lines.push(
      '   ⇒ NOTE: applying all of the above together was NOT verified to restore consistency — manual review may be required.',
    );
  }
  if (options.repairSetMatchWarning) {
    lines.push(`   ⇒ WARNING: ${options.repairSetMatchWarning}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function buildRepairBrief(
  d: DiagnosticsData,
  repairs: BriefRepair[] = [],
  options: RepairBriefOptions = {},
): string {
  const hasInconsistency = d.isConsistent === false;
  const hasUnsatisfiable = d.unsatisfiableClasses.length > 0;
  const hasProfileViolations = d.profile?.owl2dl === false && (d.profile?.violations.length ?? 0) > 0;
  const hasShaclViolations = d.shaclViolations.length > 0;
  const hasProfileFlag = d.profile?.owl2dl === false;

  const anyIssue =
    hasInconsistency ||
    hasUnsatisfiable ||
    hasProfileFlag ||
    hasShaclViolations;

  if (!anyIssue) {
    return 'No issues detected.';
  }

  const sections: string[] = [];
  let num = 1;

  if (hasInconsistency) {
    sections.push(buildInconsistencySection(d.justifications, d.laconicJustifications));
    num++;
  }

  if (hasUnsatisfiable) {
    const lines: string[] = [`${num}. UNSATISFIABLE CLASSES`];
    for (const cls of d.unsatisfiableClasses) {
      lines.push(
        `   - ${localName(cls)}: This class can never have instances — relax its definition` +
          ' (e.g. remove a disjointness or an over-constraining restriction).',
      );
    }
    sections.push(lines.join('\n'));
    num++;
  }

  if (hasProfileFlag && d.profile) {
    sections.push(buildProfileSection(d.profile, num));
    num++;
  }

  if (hasShaclViolations) {
    sections.push(buildShaclSection(d.shaclViolations, num));
    num++;
  }

  if (repairs.length > 0) {
    sections.push(buildSuggestedRepairsSection(repairs, options));
  }

  return sections.join('\n\n');
}
