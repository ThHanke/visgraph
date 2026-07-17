import { Readable } from "readable-stream";
import { Buffer } from "buffer";
import rdfParsePkg from "rdf-parse";
import * as N3 from "n3";
import { Reasoner as N3ReasonerExplicit } from "n3";
import type { Quad } from "@rdfjs/types";
import { assertRdfWorkerInbound } from "../utils/rdfManager.workerProtocol.ts";
import type {
  RDFWorkerCommand,
  RDFWorkerCommandPayloads,
  RDFWorkerRunReasoningMessage,
  ExportGraphPayload,
  ImportSerializedPayload,
  PurgeNamespacePayload,
  RenameNamespaceUriPayload,
  RemoveQuadsByNamespacePayload,
  WorkerReconcileSubjectSnapshotPayload,
} from "../utils/rdfManager.workerProtocol.ts";
import type { ReasoningResult } from "../utils/reasoningTypes.ts";
import { deserializeQuad, deserializeTerm, serializeQuad } from "../utils/rdfSerialization.ts";
import type { WorkerQuad } from "../utils/rdfSerialization.ts";
import { quadMatchesRemoval, type MatchQuad } from "./verifyRepairMatch.ts";
import { WELL_KNOWN } from "../utils/wellKnownOntologies.ts";
import { ensureDefaultNamespaceMap } from "../constants/namespaces.ts";
import { RDF_TYPE, RDFS_LABEL, SHACL } from "../constants/vocabularies.ts";
import { OWL_SCHEMA_AXIOMS } from "../constants/owlSchemaData.ts";
import { mipsToReasoningError, shaclViolationToEntry } from "./reasoningDiagnostics.ts";
// TODO(rdf-reasoner-konclude): entailmentProbe will be an internal module of
// the reasoner once explainEntailment() lands (plan-050, Unit 2-3).
import { buildEntailmentProbe } from "./entailmentProbe.ts";

import { QueryEngine } from "@comunica/query-sparql-rdfjs";
// TODO(rdf-reasoner-konclude): laconic justification will move to reasoner
// once explainInconsistencyLaconic() lands (plan-050, Unit 4-5).
// LACONIC JUSTIFICATIONS (Horridge, Parsia, Sattler, ISWC 2008). IMPORT ONLY —
// the pure module is never edited here. `splitAxiom` is the structural weakening
// (OPlus) closure of one axiom; `axiomKey` is its stable de-dup key. We do NOT
// use the module's synchronous `computeLaconic` because our entailment oracle
// (`_checkInconsistencyDirect`) is asynchronous (it round-trips the Konclude
// worker). Instead `computeLaconicAsync` below replays the SAME two-step Horridge
// algorithm — split every axiom, sanity-check the candidate set still entails η,
// then contract superfluous parts — awaiting the async oracle at each step, while
// reusing the pure `splitAxiom`/`axiomKey` so the weakening rules stay in one place.
import {
  splitAxiom,
  axiomKey as laconicAxiomKey,
  type LaconicAxiom,
  type LaconicTriple,
} from "./laconicJustification.ts";
const KONCLUDE_INFERRED_GRAPH_IRI = "urn:vg:inferred";

// ───────────────────────────────────────────────────────────────────────────
// LACONIC post-processing of inconsistency justifications
// ───────────────────────────────────────────────────────────────────────────
//
// The worker's MIPS search (`explainInconsistency`) returns each justification as
// a FLAT list of RDF quads, minimal at the granularity of WHOLE axioms. A laconic
// justification (Horridge et al. ISWC 2008) is sharper: it strips superfluous
// PARTS, so `A ⊑ B ⊓ C` is reported as just its `A ⊑ B` part when only that part
// drives the clash. We post-process each MIPS J → its laconic form by:
//   1. grouping J's flat quads into logical AXIOMS (a principal triple + its
//      transitive blank-node closure, the shape `splitAxiom` consumes);
//   2. running `splitAxiom` on each axiom to get its weaker parts;
//   3. contracting the parts via the Konclude consistency oracle (async).
//
// COST CAP (bounds the extra oracle/WASM round-trips so laconic can never blow the
// 3-minute worker timeout). Laconic adds one oracle call per split part during the
// sanity check + one per part during contraction — O(parts) calls per justification.
// We therefore:
//   • SKIP laconic entirely for a justification with more than
//     LACONIC_MAX_AXIOMS axioms (a large MIPS would explode the oracle budget);
//   • SKIP laconic for a justification whose total candidate-part count exceeds
//     LACONIC_MAX_PARTS (after splitting), for the same reason.
// A skipped justification falls back to laconic == original (documented, lossless:
// the agent still gets the regular justification, just not the sharpened parts).
const LACONIC_MAX_AXIOMS = 12;
const LACONIC_MAX_PARTS = 24;

/** Convert a runtime N3 quad to the laconic module's plain-triple shape. */
function quadToLaconicTriple(q: N3.Quad): LaconicTriple {
  return {
    subject: q.subject.value,
    predicate: q.predicate.value,
    object: q.object.value,
    objectIsLiteral: q.object.termType === "Literal",
  };
}

/** A blank-node-ish term value (N3 blank label, `_:b`, or N3 `bN`). */
function isLaconicBlank(value: string): boolean {
  return value.startsWith("_:") || /^b\d+$/.test(value) || value.startsWith("n3-");
}

/**
 * Materialise a laconic part (plain triples) into runtime N3 quads so the async
 * oracle can hand them to Konclude. Blank-node terms become real N3 blank nodes;
 * everything else is a NamedNode (or a Literal when objectIsLiteral). The graph is
 * the default graph — `_checkInconsistencyDirect` only reads s/p/o.
 */
export function laconicAxiomToQuads(axiom: LaconicAxiom): N3.Quad[] {
  const term = (value: string, isLiteral: boolean): N3.Quad_Subject | N3.Quad_Object => {
    if (isLiteral) return N3.DataFactory.literal(value) as unknown as N3.Quad_Object;
    if (isLaconicBlank(value)) return N3.DataFactory.blankNode(value.replace(/^_:/, ""));
    return N3.DataFactory.namedNode(value);
  };
  return axiom.map((t) =>
    N3.DataFactory.quad(
      term(t.subject, false) as N3.Quad_Subject,
      N3.DataFactory.namedNode(t.predicate),
      term(t.object, !!t.objectIsLiteral) as N3.Quad_Object,
    ),
  );
}

/**
 * Group a flat MIPS justification (N3 quads) into logical AXIOMS — each a
 * principal triple plus its transitive blank-node closure — in the
 * `LaconicAxiom` shape `splitAxiom` consumes. The principal triple is placed
 * FIRST (splitAxiom treats `axiom[0]` as principal).
 *
 * A quad with a NAMED subject is a principal; its blank-node object closure is
 * pulled from the SAME justification's quads (the MIPS keeps the class-expression
 * triples it needs). Closure quads (blank-subject) consumed by a principal are
 * not re-emitted standalone. Any blank-subject quad NOT reached by a principal is
 * grouped on its own (kept whole — sound, merely coarser).
 *
 * Returns the axioms plus, for each axiom (by its laconic key), the ORIGINAL N3
 * quads that composed it, so the laconic result can map a part back to the exact
 * source quads (graph + typed-literal term) the repair path must target.
 */
export function groupQuadsIntoLaconicAxioms(
  justification: N3.Quad[],
  closureSource?: N3.Quad[],
): { axioms: LaconicAxiom[]; sourceQuads: Map<string, N3.Quad[]> } {
  // Blank-node closures are resolved from `closureSource` (the FULL reasoning
  // base) when provided, NOT from the justification alone. This matters because
  // the QUAD-level MIPS minimiser may prune individual list cells of an
  // intersection (e.g. it keeps `_:int first ex:B` but drops the `ex:C` cell when
  // C is superfluous), leaving a dangling rdf:List. Reconstructing the COMPLETE
  // class expression from the full base lets splitAxiom see `A ⊑ B ⊓ C` in full
  // so the laconic contraction can genuinely drop the superfluous `A ⊑ C` part.
  const closureBase = closureSource && closureSource.length > 0 ? closureSource : justification;
  const bySubject = new Map<string, N3.Quad[]>();
  for (const q of closureBase) {
    const arr = bySubject.get(q.subject.value);
    if (arr) arr.push(q);
    else bySubject.set(q.subject.value, [q]);
  }

  const consumed = new Set<N3.Quad>();
  const closure = (start: string, accT: LaconicTriple[], accQ: N3.Quad[], seen: Set<string>): void => {
    if (seen.has(start)) return;
    seen.add(start);
    const arr = bySubject.get(start);
    if (!arr) return;
    for (const q of arr) {
      consumed.add(q);
      accT.push(quadToLaconicTriple(q));
      accQ.push(q);
      if (q.object.termType !== "Literal" && isLaconicBlank(q.object.value)) {
        closure(q.object.value, accT, accQ, seen);
      }
    }
  };

  const axioms: LaconicAxiom[] = [];
  const sourceQuads = new Map<string, N3.Quad[]>();
  const register = (triples: LaconicTriple[], quads: N3.Quad[]): void => {
    if (triples.length === 0) return;
    const key = laconicAxiomKey(triples);
    if (sourceQuads.has(key)) return;
    axioms.push(triples);
    sourceQuads.set(key, quads);
  };

  // Principals first: NAMED-subject quads. Each pulls its blank object closure.
  for (const q of justification) {
    if (isLaconicBlank(q.subject.value)) continue; // closure handled below
    const triples: LaconicTriple[] = [quadToLaconicTriple(q)];
    const quads: N3.Quad[] = [q];
    consumed.add(q);
    if (q.object.termType !== "Literal" && isLaconicBlank(q.object.value)) {
      closure(q.object.value, triples, quads, new Set<string>());
    }
    register(triples, quads);
  }

  // Any remaining blank-subject quad not reached by a principal: keep whole.
  for (const q of justification) {
    if (consumed.has(q)) continue;
    const triples: LaconicTriple[] = [quadToLaconicTriple(q)];
    const quads: N3.Quad[] = [q];
    consumed.add(q);
    if (q.object.termType !== "Literal" && isLaconicBlank(q.object.value)) {
      closure(q.object.value, triples, quads, new Set<string>());
    }
    register(triples, quads);
  }

  return { axioms, sourceQuads };
}

/**
 * Async port of laconicJustification.computeLaconic — same Horridge two-step
 * shape (split → sanity → contract) but awaiting an ASYNC entailment oracle (the
 * Konclude consistency check). Reuses the pure `splitAxiom`/`axiomKey` so the
 * weakening rules live in exactly one place.
 *
 * `entails(axioms)` must resolve true iff the union of the given axioms entails η
 * (here: is INCONSISTENT). Returns the laconic axioms plus a part-key → source
 * axiom map (the source is the ORIGINAL axiom the part was split from).
 */
export async function computeLaconicAsync(
  justification: LaconicAxiom[],
  entails: (axioms: LaconicAxiom[]) => Promise<boolean>,
): Promise<{ laconic: LaconicAxiom[]; sources: Map<LaconicAxiom, LaconicAxiom> }> {
  // Step 1 — split + dedupe, tracking provenance.
  const candidates: LaconicAxiom[] = [];
  const candidateKeys = new Set<string>();
  const sources = new Map<LaconicAxiom, LaconicAxiom>();
  for (const original of justification) {
    for (const part of splitAxiom(original)) {
      const k = laconicAxiomKey(part);
      if (candidateKeys.has(k)) continue;
      candidateKeys.add(k);
      candidates.push(part);
      sources.set(part, original);
    }
  }

  // Step 2 — sanity: the split candidate set must still entail η. If not (an
  // oracle that does not accept the weaker parts), fall back to the ORIGINAL
  // justification verbatim so the result is never weaker than the input.
  if (!(await entails(candidates))) {
    const fallback = new Map<LaconicAxiom, LaconicAxiom>();
    for (const a of justification) fallback.set(a, a);
    return { laconic: [...justification], sources: fallback };
  }

  // Step 3 — contract: drop every superfluous part (single stable pass).
  let current = [...candidates];
  for (const part of candidates) {
    const without = current.filter((c) => c !== part);
    if (await entails(without)) current = without;
  }

  const laconicSources = new Map<LaconicAxiom, LaconicAxiom>();
  for (const part of current) {
    const src = sources.get(part);
    if (src) laconicSources.set(part, src);
  }
  return { laconic: current, sources: laconicSources };
}

/**
 * One laconic justification, serialised for the worker→main boundary. `parts` are
 * the laconic axiom PARTS (the precise culprits); each part carries its principal
 * triple plus the ORIGINAL source axiom's principal triple (so the UI can say
 * "the `A ⊑ B` part of axiom `A ⊑ B ⊓ C` is the culprit"). `sharpened` is true
 * when laconic actually dropped something (parts differ from the original axioms);
 * `skipped` is true when the cost cap suppressed laconic for this justification.
 */
type SerializedLaconicPart = {
  subject: string;
  predicate: string;
  object: string;
  objectIsLiteral?: boolean;
  /** The principal triple of the original axiom this part was split from. */
  sourceSubject: string;
  sourcePredicate: string;
  sourceObject: string;
  /** True when this part is strictly smaller/weaker than its source axiom. */
  isPartOf: boolean;
};

type SerializedLaconicJustification = {
  parts: SerializedLaconicPart[];
  sharpened: boolean;
  skipped: boolean;
};

// ───────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH — reasoning-base graph exclusions (Finding 1)
// ───────────────────────────────────────────────────────────────────────────
// Every Konclude/locality entry point that builds the "base axioms" the reasoner
// sees must filter the shared store down to the SAME graphs. Previously each call
// site hand-rolled its own inline Set, and the copies were NOT identical — a
// latent soundness risk, because the incremental-classify base and the full-
// classify base were kept in sync only by manual coincidence. These named
// constants are the ONE definition; every former inline copy now reads from here,
// so the incremental and full reasoning bases provably share a source.
//
// Graph roles: urn:vg:data (asserted ABox/TBox) and urn:vg:ontologies (loaded
// schema) are the reasoning INPUT; urn:vg:inferred holds derived triples (never
// fed back as input); urn:vg:shapes is SHACL; urn:vg:workflows and
// urn:vg:provenance are application metadata. None of the latter four are OWL DL
// input to the reasoner.

/**
 * The canonical reasoning-base exclusion: drop inferred/shapes/workflows/
 * provenance so the base is exactly the asserted TBox/ABox + loaded ontologies.
 * Used by every consistency / unsat / justification
 * path that reads the CURRENT store (the reasoner must never re-consume its own
 * inferred output, hence urn:vg:inferred is excluded here).
 */
const EXCLUDED_FROM_REASONING: ReadonlySet<string> = new Set([
  "urn:vg:workflows",
  "urn:vg:inferred",
  "urn:vg:shapes",
  "urn:vg:provenance",
]);

/**
 * Variant for reason(): identical to EXCLUDED_FROM_REASONING but WITHOUT
 * urn:vg:inferred, because reason() explicitly REMOVES the inferred graph from
 * the store FIRST (it is about to overwrite it) and then filters the remainder.
 * Excluding inferred here too would be harmless but redundant; the intentional
 * difference is documented so it is not mistaken for drift. Defined relative to
 * the canonical set so the two can never silently diverge on the other graphs.
 */
const EXCLUDED_FROM_REASONING_KEEP_INFERRED: ReadonlySet<string> = new Set(
  [...EXCLUDED_FROM_REASONING].filter((g) => g !== "urn:vg:inferred"),
);

/**
 * Variant for constructing the full-run WORKING COPY of the shared store: drop
 * only workflows/provenance, KEEPING inferred AND shapes. This is deliberately
 * broader (keeps more) than EXCLUDED_FROM_REASONING because the working copy is
 * then handed to reason(), which performs the FINAL reasoning-base filtering
 * (clears inferred, drops shapes) itself. Pre-dropping shapes/inferred here would
 * be redundant; pre-keeping them lets reason() own the canonical filter. Defined
 * as the subset of EXCLUDED_FROM_REASONING that is NOT reason()-handled, so it
 * stays anchored to the same definition.
 */
const EXCLUDED_FROM_REASONING_WORKING_COPY: ReadonlySet<string> = new Set(
  ["urn:vg:workflows", "urn:vg:provenance"].filter((g) =>
    EXCLUDED_FROM_REASONING.has(g),
  ),
);


// ---------------------------------------------------------------------------
// Binary codec — verbatim from rdf-reasoner-konclude v0.3.0 ts/intern.ts.
// Not exported from the package public API; inlined here to avoid importing
// private dist paths. Coupled to the worker.js in public/rdf-reasoner-konclude/
// — both come from the same package version. Pin: 0.3.0
// ---------------------------------------------------------------------------

const _enc = new TextEncoder();
const _dec = new TextDecoder();

class InternTable {
  private readonly namedNodes = new Map<string, number>();
  private readonly blankNodes = new Map<string, number>();
  private readonly literals = new Map<string, number>();
  private readonly entries: Uint8Array[] = [];

  private addEntry(bytes: Uint8Array, type: 0 | 1 | 2): number {
    const id = (this.entries.length & 0x3fffffff) | (type << 30);
    this.entries.push(bytes);
    return id;
  }

  encodeTerm(term: N3.Term): number {
    switch (term.termType) {
      case "NamedNode": {
        let id = this.namedNodes.get(term.value);
        if (id === undefined) {
          id = this.addEntry(_enc.encode(term.value), 0);
          this.namedNodes.set(term.value, id);
        }
        return id;
      }
      case "BlankNode": {
        let id = this.blankNodes.get(term.value);
        if (id === undefined) {
          id = this.addEntry(_enc.encode(term.value), 1);
          this.blankNodes.set(term.value, id);
        }
        return id;
      }
      case "Literal": {
        const dt = term.datatype?.value ?? "";
        const lang = term.language ?? "";
        const raw = `${term.value}\0${dt}\0${lang}`;
        let id = this.literals.get(raw);
        if (id === undefined) {
          id = this.addEntry(_enc.encode(raw), 2);
          this.literals.set(raw, id);
        }
        return id;
      }
      default: {
        let id = this.namedNodes.get("");
        if (id === undefined) {
          id = this.addEntry(_enc.encode(""), 0);
          this.namedNodes.set("", id);
        }
        return id;
      }
    }
  }

  buildStrTableBuffer(): ArrayBuffer {
    const count = this.entries.length;
    const headerBytes = 4 + 4 * count;
    let dataBytes = 0;
    for (const e of this.entries) dataBytes += e.byteLength;
    const buf = new ArrayBuffer(headerBytes + dataBytes);
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    dv.setUint32(0, count, true);
    let offset = 0;
    let dataPos = headerBytes;
    for (let i = 0; i < count; i++) {
      dv.setUint32(4 + 4 * i, offset, true);
      const entry = this.entries[i];
      u8.set(entry, dataPos);
      offset += entry.byteLength;
      dataPos += entry.byteLength;
    }
    return buf;
  }
}

function _encodeToBuffers(quads: Iterable<N3.Quad>): { tripleBuffer: ArrayBuffer; strTableBuffer: ArrayBuffer } {
  const table = new InternTable();
  const ids: number[] = [];
  for (const quad of quads) {
    ids.push(table.encodeTerm(quad.subject), table.encodeTerm(quad.predicate), table.encodeTerm(quad.object));
  }
  return { tripleBuffer: new Uint32Array(ids).buffer, strTableBuffer: table.buildStrTableBuffer() };
}

function _decodeTerm(id: number, rawStrings: string[]): N3.NamedNode | N3.BlankNode | N3.Literal {
  const type = id >>> 30;
  const idx = id & 0x3fffffff;
  const raw = rawStrings[idx] ?? "";
  switch (type) {
    case 1: return N3.DataFactory.blankNode(raw);
    case 2: {
      const nul1 = raw.indexOf("\0");
      const value = nul1 >= 0 ? raw.slice(0, nul1) : raw;
      const rest = nul1 >= 0 ? raw.slice(nul1 + 1) : "";
      const nul2 = rest.indexOf("\0");
      const datatype = nul2 >= 0 ? rest.slice(0, nul2) : rest;
      const language = nul2 >= 0 ? rest.slice(nul2 + 1) : "";
      if (language) return N3.DataFactory.literal(value, language);
      if (datatype) return N3.DataFactory.literal(value, N3.DataFactory.namedNode(datatype));
      return N3.DataFactory.literal(value);
    }
    default: return N3.DataFactory.namedNode(raw);
  }
}

function _decodeBuffers(combined: ArrayBuffer): N3.Quad[] {
  if (combined.byteLength < 4) return [];
  const dv = new DataView(combined);
  const strTableLen = dv.getUint32(0, true);
  const strTableStart = 4;
  const tripleStart = 4 + strTableLen;
  if (strTableLen < 4) return [];
  const strDv = new DataView(combined, strTableStart, strTableLen);
  const termCount = strDv.getUint32(0, true);
  const headerBytes = 4 + 4 * termCount;
  const strDataLen = strTableLen - headerBytes;
  const strBytes = new Uint8Array(combined, strTableStart + headerBytes, strDataLen);
  const rawStrings: string[] = new Array(termCount);
  for (let i = 0; i < termCount; i++) {
    const start = strDv.getUint32(4 + 4 * i, true);
    const end = i + 1 < termCount ? strDv.getUint32(4 + 4 * (i + 1), true) : strDataLen;
    rawStrings[i] = _dec.decode(strBytes.slice(start, end));
  }
  const tripleBytes = combined.byteLength - tripleStart;
  const tripleCount = Math.floor(tripleBytes / 12);
  if (tripleCount === 0) return [];
  const tripDv = new DataView(combined, tripleStart, tripleCount * 12);
  const quads: N3.Quad[] = new Array(tripleCount);
  for (let i = 0; i < tripleCount; i++) {
    const sId = tripDv.getUint32(i * 12, true);
    const pId = tripDv.getUint32(i * 12 + 4, true);
    const oId = tripDv.getUint32(i * 12 + 8, true);
    quads[i] = N3.DataFactory.quad(
      _decodeTerm(sId, rawStrings) as N3.NamedNode,
      _decodeTerm(pId, rawStrings) as N3.NamedNode,
      _decodeTerm(oId, rawStrings),
      N3.DataFactory.defaultGraph(),
    );
  }
  return quads;
}

// ---------------------------------------------------------------------------
// KoncludeReasoner — adapted from RdfReasoner in rdf-reasoner-konclude v0.3.0.
// Identical to upstream except the worker URL uses an absolute public path
// instead of new URL("./worker.js", import.meta.url), which resolves
// incorrectly inside Vite worker bundles.
// ---------------------------------------------------------------------------

// M1: monotonic, deterministic counter giving each explainEntailment call a
// unique probeId. Module-scoped so probe blank-node labels (vg_neg_*/vg_wit_*)
// are unique per call and cannot collide with a real ontology bnode that
// happens to carry the constant default label. Deterministic (not Math.random)
// so probe construction stays reproducible.
let _entailmentProbeCounter = 0;

class KoncludeReasoner {
  readonly ready: Promise<void>;
  private readonly worker: Worker;
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
  private _queue: Promise<void> = Promise.resolve();

  constructor() {
    // Absolute public URL — required because new URL("./worker.js", import.meta.url)
    // resolves to the bundle URL inside a Vite worker, not the package directory.
    // BASE_URL is "/" in dev and "/ontosphere/" on GitHub Pages.
    // Increment v= when upgrading rdf-reasoner-konclude.
    this.worker = new Worker(`${import.meta.env.BASE_URL}rdf-reasoner-konclude/worker.js?v=20`, { type: "module" });

    let readyReject!: (reason: Error) => void;
    let readySettled = false;

    this.ready = new Promise<void>((resolve, reject) => {
      readyReject = reject;
      const onInit = (event: MessageEvent) => {
        const msg = event.data;
        if ("type" in msg) {
          if (msg.type === "ready") {
            this.worker.removeEventListener("message", onInit);
            readySettled = true;
            resolve();
          } else if (msg.type === "error") {
            this.worker.removeEventListener("message", onInit);
            readySettled = true;
            reject(new Error(msg.error));
          }
        }
      };
      this.worker.addEventListener("message", onInit);
    });

    this.worker.addEventListener("message", (event: MessageEvent) => {
      const msg = event.data;
      if ("type" in msg) {
        if (msg.type === "log" && typeof msg.msg === "string") {
          if (workerDebugEnabled) console.error("[Konclude]", msg.msg);
        }
        return;
      }
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error !== undefined) entry.reject(new Error(msg.error));
      else entry.resolve(msg.result);
    });

    this.worker.addEventListener("error", (event: ErrorEvent) => {
      event.preventDefault();
      const err = new Error(event.message ?? "Worker error");
      if (!readySettled) { readySettled = true; readyReject(err); }
      for (const e of this.pending.values()) e.reject(err);
      this.pending.clear();
    });
  }

  private static readonly CALL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

  private _call(method: string, args: unknown[], transfer?: Transferable[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this._handleTimeout(method);
        reject(new Error(
          `Konclude OWL DL reasoning timed out after ${KoncludeReasoner.CALL_TIMEOUT_MS / 1000}s during "${method}". ` +
          `A likely cause is an OWL 2 DL profile violation (for example a datatype/literal value used where an ` +
          `object property is expected) that prevents the reasoner from terminating; run explainDiagnostics or ` +
          `check recently added axioms. The reasoner worker has been recycled.`
        ));
      }, KoncludeReasoner.CALL_TIMEOUT_MS);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const request = { id, method, args };
      if (transfer && transfer.length > 0) {
        this.worker.postMessage(request, transfer);
      } else {
        this.worker.postMessage(request);
      }
    });
  }

  private _handleTimeout(method: string): void {
    console.error(`[Konclude] WASM call "${method}" timed out — terminating worker`);
    this.terminate();
    _koncludeReasoner = null;
  }

  /**
   * De-skolemize a candidate quad set: urn:vg:bnode:* NamedNodes → real blank
   * nodes so Konclude sees anonymous OWL class expressions. Factored out of
   * reason / _checkInconsistencyDirect / _getUnsatisfiableClassesDirect
   * so every Konclude entry point applies the IDENTICAL boundary
   * transform (a divergence here would silently change what the reasoner sees).
   */
  private static _deskolemize(candidates: N3.Quad[]): N3.Quad[] {
    const BNODE_PREFIX = "urn:vg:bnode:";
    return candidates.map((q) => {
      const subj = q.subject.termType === "NamedNode" && q.subject.value.startsWith(BNODE_PREFIX)
        ? N3.DataFactory.blankNode(q.subject.value.slice(BNODE_PREFIX.length))
        : q.subject;
      const obj = q.object.termType === "NamedNode" && q.object.value.startsWith(BNODE_PREFIX)
        ? N3.DataFactory.blankNode(q.object.value.slice(BNODE_PREFIX.length))
        : q.object;
      if (subj === q.subject && obj === q.object) return q;
      return N3.DataFactory.quad(subj, q.predicate, obj, q.graph);
    });
  }

  reason(store: N3.Store): Promise<void> {
    const result = this._queue.then(async () => {
      const inferredGraphNode = N3.DataFactory.namedNode(KONCLUDE_INFERRED_GRAPH_IRI);
      store.removeQuads(store.getQuads(null, null, null, inferredGraphNode));

      // reason() clears urn:vg:inferred above, so it uses the KEEP_INFERRED
      // variant (single source of truth — Finding 1).
      const allQuads: N3.Quad[] = store.getQuads(null, null, null, null);
      const sourceQuads = allQuads.filter((q) => {
        const g = q.graph.termType === "DefaultGraph" ? "" : q.graph.value;
        return !EXCLUDED_FROM_REASONING_KEEP_INFERRED.has(g);
      });

      const inferredQuads = await this._classifyDirect(sourceQuads);

      for (const q of inferredQuads) {
        store.addQuad(N3.DataFactory.quad(q.subject, q.predicate, q.object, inferredGraphNode));
      }

      debugLog("[VG_REASONING_WORKER] Konclude inferred quads:", inferredQuads.length);
    });
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Run Konclude TBox classification + ABox realization over a candidate quad set
   * and return the NEWLY inferred quads (those not already present in the source).
   * De-skolemizes at the boundary. Runs INSIDE an existing _queue slot (like
   * _checkInconsistencyDirect), so callers that already hold a _queue slot (reason)
   * reuse it without re-acquiring (which would deadlock). The
   * returned quads carry a DefaultGraph term; the caller assigns the target graph.
   */
  private async _classifyDirect(candidates: N3.Quad[]): Promise<N3.Quad[]> {
    const sourceKeys = new Set(
      candidates.map((q) => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`),
    );
    const deskolemized = KoncludeReasoner._deskolemize(candidates);
    const { tripleBuffer, strTableBuffer } = _encodeToBuffers(deskolemized);
    // realization runs TBox classification + ABox individual typing in one pass.
    // Calling classification separately then realization drains the result buffer mid-sequence,
    // leaving realization with no output — hence the single-pass approach mirrors materialize().
    // forRealization=true (3rd arg, added in 0.3.0) configures Konclude for ABox realization.
    await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer, true], [tripleBuffer, strTableBuffer]);
    await this._call("realization", []);
    const resultBuf = (await this._call("getInferredTripleBuffer", [])) as ArrayBuffer;
    const inferredQuads = _decodeBuffers(resultBuf);
    return inferredQuads.filter(
      (q) => !sourceKeys.has(`${q.subject.value}\0${q.predicate.value}\0${q.object.value}`),
    );
  }

  private async _checkInconsistencyDirect(candidates: N3.Quad[]): Promise<boolean> {
    const deskolemized = KoncludeReasoner._deskolemize(candidates);
    const { tripleBuffer, strTableBuffer } = _encodeToBuffers(deskolemized);
    await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer, false], [tripleBuffer, strTableBuffer]);
    await this._call("classification", []);
    const consistent = (await this._call("consistency", [])) as boolean;
    return !consistent;
  }

  /**
   * Direct (non-queued) variant of getUnsatisfiableClasses: classify a candidate
   * quad set and return the IRIs of classes entailed equivalent to owl:Nothing.
   * Mirrors getUnsatisfiableClasses' de-skolemisation but takes pre-filtered
   * quads and runs INSIDE an existing _queue slot (like _checkInconsistencyDirect)
   * so callers such as explainEntailment can use it without re-acquiring _queue
   * (which would deadlock). Used for C2 vacuous-truth detection.
   */
  private async _getUnsatisfiableClassesDirect(candidates: N3.Quad[]): Promise<string[]> {
    const deskolemized = KoncludeReasoner._deskolemize(candidates);
    const { tripleBuffer, strTableBuffer } = _encodeToBuffers(deskolemized);
    await this._call("loadTripleBuffer", [tripleBuffer, strTableBuffer, false], [tripleBuffer, strTableBuffer]);
    await this._call("classification", []);
    const raw = (await this._call("getUnsatisfiableClassBuffer", [])) as string;
    return typeof raw === "string" ? raw.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  }

  checkConsistency(store: N3.Store): Promise<boolean> {
    const result = this._queue.then(async () => {
      const candidates: N3.Quad[] = (store.getQuads(null, null, null, null) as N3.Quad[]).filter((q) => {
        const g = q.graph.termType === "DefaultGraph" ? "" : q.graph.value;
        return !EXCLUDED_FROM_REASONING.has(g);
      });
      return !(await this._checkInconsistencyDirect(candidates));
    });
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Return the IRIs of classes that are unsatisfiable (entailed equivalent to
   * owl:Nothing) over the base graphs. Mirrors checkConsistency's graph filtering
   * and blank-node de-skolemisation, then asks the Konclude worker for the
   * unsatisfiable-class buffer (a newline-separated IRI list).
   */
  getUnsatisfiableClasses(store: N3.Store): Promise<string[]> {
    const result = this._queue.then(async () => {
      const candidates: N3.Quad[] = (store.getQuads(null, null, null, null) as N3.Quad[]).filter((q) => {
        const g = q.graph.termType === "DefaultGraph" ? "" : q.graph.value;
        return !EXCLUDED_FROM_REASONING.has(g);
      });
      return this._getUnsatisfiableClassesDirect(candidates);
    });
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  explainInconsistency(store: N3.Store, maxJustifications = 1): Promise<N3.Quad[][]> {
    const result = this._queue.then(() =>
      this._explainInconsistencyJustifications(store, maxJustifications),
    );
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Compute the MIPS justifications WITHOUT acquiring a _queue slot — the caller
   * must already hold one (like _checkInconsistencyDirect). Factored out of
   * explainInconsistency so BOTH the plain path and the laconic path
   * (explainInconsistencyLaconic) share the identical search and the SAME
   * consistency oracle, instead of duplicating the binary-expand / single-axiom-
   * prune / hitting-set enumeration.
   */
  private async _explainInconsistencyJustifications(
    store: N3.Store,
    maxJustifications = 1,
  ): Promise<N3.Quad[][]> {
    {
      const allBase: N3.Quad[] = (store.getQuads(null, null, null, null) as N3.Quad[]).filter((q) => {
        const g = q.graph.termType === "DefaultGraph" ? "" : q.graph.value;
        return !EXCLUDED_FROM_REASONING.has(g);
      });

      if (!(await this._checkInconsistencyDirect(allBase))) return [];
      if (maxJustifications === 0) return [];

      // Filter out pure declaration and annotation triples that cannot be the
      // cause of a logical inconsistency on their own.  This shrinks the O(N)
      // oracle search substantially for ontologies with many labels/comments.
      const ANNOTATION_PREDICATES = new Set([
        "http://www.w3.org/2000/01/rdf-schema#label",
        "http://www.w3.org/2000/01/rdf-schema#comment",
        "http://www.w3.org/2000/01/rdf-schema#seeAlso",
        "http://www.w3.org/2000/01/rdf-schema#isDefinedBy",
        // skos
        "http://www.w3.org/2004/02/skos/core#prefLabel",
        "http://www.w3.org/2004/02/skos/core#altLabel",
        "http://www.w3.org/2004/02/skos/core#hiddenLabel",
        "http://www.w3.org/2004/02/skos/core#note",
        "http://www.w3.org/2004/02/skos/core#definition",
        "http://www.w3.org/2004/02/skos/core#example",
        "http://www.w3.org/2004/02/skos/core#scopeNote",
        "http://www.w3.org/2004/02/skos/core#editorialNote",
        "http://www.w3.org/2004/02/skos/core#changeNote",
        "http://www.w3.org/2004/02/skos/core#historyNote",
        // dc / dcterms
        "http://purl.org/dc/elements/1.1/title",
        "http://purl.org/dc/elements/1.1/description",
        "http://purl.org/dc/elements/1.1/creator",
        "http://purl.org/dc/elements/1.1/date",
        "http://purl.org/dc/terms/title",
        "http://purl.org/dc/terms/description",
        "http://purl.org/dc/terms/creator",
        "http://purl.org/dc/terms/date",
        "http://purl.org/dc/terms/created",
        "http://purl.org/dc/terms/modified",
      ]);
      const OWL_DECLARATION_OBJECTS = new Set([
        "http://www.w3.org/2002/07/owl#Class",
        "http://www.w3.org/2002/07/owl#ObjectProperty",
        "http://www.w3.org/2002/07/owl#DatatypeProperty",
        "http://www.w3.org/2002/07/owl#AnnotationProperty",
        "http://www.w3.org/2002/07/owl#NamedIndividual",
        "http://www.w3.org/2002/07/owl#Ontology",
      ]);
      const RDF_TYPE_URI = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
      const isNonLogical = (q: N3.Quad): boolean => {
        const pred = q.predicate.value;
        if (ANNOTATION_PREDICATES.has(pred)) return true;
        // rdf:type declarations to OWL meta-vocabulary objects are non-logical
        if (pred === RDF_TYPE_URI && OWL_DECLARATION_OBJECTS.has(q.object.value)) return true;
        return false;
      };
      const allCandidates = allBase.filter((q) => !isNonLogical(q));

      const justifications: N3.Quad[][] = [];

      const findOneJustification = async (candidates: N3.Quad[]): Promise<N3.Quad[] | null> => {
        let working = [...candidates];
        let changed = true;
        while (changed && working.length > 1) {
          changed = false;
          const mid = Math.floor(working.length / 2);
          const firstHalf = working.slice(0, mid);
          const secondHalf = working.slice(mid);
          if (await this._checkInconsistencyDirect(firstHalf)) {
            working = firstHalf; changed = true; continue;
          }
          if (await this._checkInconsistencyDirect(secondHalf)) {
            working = secondHalf; changed = true; continue;
          }
          break;
        }
        let i = 0;
        while (i < working.length) {
          if (working.length === 1) break;
          const without = [...working.slice(0, i), ...working.slice(i + 1)];
          if (await this._checkInconsistencyDirect(without)) {
            working = without;
          } else {
            i++;
          }
        }
        return working;
      };

      const j1 = await findOneJustification(allCandidates);
      if (!j1 || j1.length === 0) return [];
      justifications.push(j1);

      if (maxJustifications > 1) {
        const hsQueue: Array<{ excluded: Set<string>; justification: N3.Quad[] }> = [
          { excluded: new Set(), justification: j1 },
        ];
        const exploredExclusions = new Set<string>();
        while (hsQueue.length > 0 && justifications.length < maxJustifications) {
          const { excluded, justification: currentJ } = hsQueue.shift()!;
          const excludedKey = [...excluded].sort().join("|");
          if (exploredExclusions.has(excludedKey)) continue;
          exploredExclusions.add(excludedKey);
          for (const axiomInJ of currentJ) {
            const newExcluded = new Set(excluded);
            const axKey = `${axiomInJ.subject.value}\0${axiomInJ.predicate.value}\0${axiomInJ.object.value}`;
            newExcluded.add(axKey);
            const newExcludedKey = [...newExcluded].sort().join("|");
            if (exploredExclusions.has(newExcludedKey)) continue;
            const reduced = allCandidates.filter(q => !newExcluded.has(`${q.subject.value}\0${q.predicate.value}\0${q.object.value}`));
            if (!(await this._checkInconsistencyDirect(reduced))) continue;
            const jNew = await findOneJustification(reduced);
            if (!jNew || jNew.length === 0) continue;
            const jKey = jNew.map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`).sort().join("|");
            const alreadyFound = justifications.some(j => j.map(q => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`).sort().join("|") === jKey);
            if (!alreadyFound) {
              justifications.push(jNew);
              if (justifications.length >= maxJustifications) break;
              hsQueue.push({ excluded: newExcluded, justification: jNew });
            }
          }
        }
      }

      return justifications;
    }
  }

  /**
   * LACONIC inconsistency explanation (Horridge et al. ISWC 2008). Computes the
   * SAME MIPS justifications as explainInconsistency, then POST-PROCESSES each to
   * its laconic form — stripping superfluous axiom PARTS so a culprit like
   * `A ⊑ B ⊓ C` is reported as just its `A ⊑ B` part when only that part drives
   * the clash. The laconic contraction reuses THIS reasoner's consistency oracle
   * (`_checkInconsistencyDirect`): a subset of parts "entails η" iff, conjoined
   * with the other justification axioms, it is INCONSISTENT.
   *
   * Returns, per justification: the original MIPS quads, the laconic axiom parts
   * (each with its source axiom), and whether laconic was sharpened or skipped by
   * the cost cap (LACONIC_MAX_AXIOMS / LACONIC_MAX_PARTS — see the constants).
   *
   * Runs in ONE _queue slot for the whole computation (search + all oracle calls)
   * so it cannot interleave with another caller's reasoning.
   */
  explainInconsistencyLaconic(
    store: N3.Store,
    maxJustifications = 1,
  ): Promise<
    Array<{
      justification: N3.Quad[];
      laconic: SerializedLaconicJustification;
    }>
  > {
    const result = this._queue.then(async () => {
      const justifications = await this._explainInconsistencyJustifications(store, maxJustifications);
      // Full reasoning base — used to reconstruct COMPLETE class expressions
      // (blank-node closures) the quad-level MIPS minimiser may have pruned, so
      // laconic can split & contract the whole intersection.
      const fullBase: N3.Quad[] = (store.getQuads(null, null, null, null) as N3.Quad[]).filter((q) => {
        const g = q.graph.termType === "DefaultGraph" ? "" : q.graph.value;
        return !EXCLUDED_FROM_REASONING.has(g);
      });
      const out: Array<{ justification: N3.Quad[]; laconic: SerializedLaconicJustification }> = [];

      for (const j of justifications) {
        out.push({
          justification: j,
          laconic: await this._laconicForJustification(j, fullBase),
        });
      }
      return out;
    });
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  /**
   * Post-process ONE MIPS justification (flat quads) into its laconic form. Must
   * run inside an existing _queue slot (uses _checkInconsistencyDirect). Applies
   * the cost cap; on skip / fallback returns the original axioms verbatim.
   */
  private async _laconicForJustification(
    justification: N3.Quad[],
    fullBase?: N3.Quad[],
  ): Promise<SerializedLaconicJustification> {
    const { axioms, sourceQuads } = groupQuadsIntoLaconicAxioms(justification, fullBase);

    // COST CAP — skip laconic for justifications too large to bound the oracle
    // budget (each extra part ⇒ extra Konclude round-trips). On skip we return
    // the regular axioms verbatim (lossless: the agent still gets the MIPS).
    const totalParts = axioms.reduce((n, ax) => n + splitAxiom(ax).length, 0);
    const skip = axioms.length > LACONIC_MAX_AXIOMS || totalParts > LACONIC_MAX_PARTS;
    if (skip) {
      return this._serializeLaconicFromAxioms(axioms, axioms, sourceQuads, false, true);
    }

    // The async oracle: a set of laconic parts "entails η" iff it is INCONSISTENT.
    const entails = async (parts: LaconicAxiom[]): Promise<boolean> => {
      const quads: N3.Quad[] = [];
      for (const p of parts) {
        const src = sourceQuads.get(laconicAxiomKey(p));
        // Reuse the ORIGINAL quads when this part IS an un-split source axiom
        // (preserves the exact graph/typed-literal terms the reasoner saw);
        // otherwise materialise the split part's plain triples into fresh quads.
        quads.push(...(src ?? laconicAxiomToQuads(p)));
      }
      return this._checkInconsistencyDirect(quads);
    };

    const { laconic, sources } = await computeLaconicAsync(axioms, entails);
    const sharpened = laconic.length !== axioms.length
      || laconic.some((p) => !sourceQuads.has(laconicAxiomKey(p)));
    return this._serializeLaconicFromComputed(laconic, sources, sourceQuads, sharpened);
  }

  /** Serialise laconic parts (computed) into the boundary shape. */
  private _serializeLaconicFromComputed(
    laconic: LaconicAxiom[],
    sources: Map<LaconicAxiom, LaconicAxiom>,
    sourceQuads: Map<string, N3.Quad[]>,
    sharpened: boolean,
  ): SerializedLaconicJustification {
    const parts: SerializedLaconicPart[] = laconic.map((part) => {
      const principal = part[0];
      const source = sources.get(part) ?? part;
      const srcPrincipal = source[0];
      const srcQuads = sourceQuads.get(laconicAxiomKey(part));
      // Prefer the ORIGINAL quad's term for the principal when this part is an
      // un-split source axiom (carries the exact graph/typed object); else the
      // split part's plain triple. `isPartOf` = strictly smaller than its source.
      const principalQuad = srcQuads?.[0];
      return {
        subject: principalQuad?.subject.value ?? principal.subject,
        predicate: principalQuad?.predicate.value ?? principal.predicate,
        object: principalQuad?.object.value ?? principal.object,
        ...(principal.objectIsLiteral ? { objectIsLiteral: true } : {}),
        sourceSubject: srcPrincipal.subject,
        sourcePredicate: srcPrincipal.predicate,
        sourceObject: srcPrincipal.object,
        isPartOf: laconicAxiomKey(part) !== laconicAxiomKey(source),
      };
    });
    return { parts, sharpened, skipped: false };
  }

  /** Serialise un-processed axioms (skip path) into the boundary shape. */
  private _serializeLaconicFromAxioms(
    laconic: LaconicAxiom[],
    sourceAxioms: LaconicAxiom[],
    sourceQuads: Map<string, N3.Quad[]>,
    sharpened: boolean,
    skipped: boolean,
  ): SerializedLaconicJustification {
    void sourceAxioms;
    const parts: SerializedLaconicPart[] = laconic.map((part) => {
      const principal = part[0];
      const srcQuads = sourceQuads.get(laconicAxiomKey(part));
      const principalQuad = srcQuads?.[0];
      return {
        subject: principalQuad?.subject.value ?? principal.subject,
        predicate: principalQuad?.predicate.value ?? principal.predicate,
        object: principalQuad?.object.value ?? principal.object,
        ...(principal.objectIsLiteral ? { objectIsLiteral: true } : {}),
        sourceSubject: principal.subject,
        sourcePredicate: principal.predicate,
        sourceObject: principal.object,
        isPartOf: false,
      };
    });
    return { parts, sharpened, skipped };
  }

  /**
   * BlackBox minimisation: given a candidate quad set that is KNOWN to be
   * inconsistent, shrink it to ONE minimal inconsistent subset using the
   * consistency oracle. Same algorithm as the inner closure in
   * explainInconsistency (binary expand + single-axiom prune). Must run inside a
   * _queue slot (uses _checkInconsistencyDirect).
   */
  private async _findOneInconsistentJustification(candidates: N3.Quad[]): Promise<N3.Quad[] | null> {
    let working = [...candidates];
    let changed = true;
    while (changed && working.length > 1) {
      changed = false;
      const mid = Math.floor(working.length / 2);
      const firstHalf = working.slice(0, mid);
      const secondHalf = working.slice(mid);
      if (await this._checkInconsistencyDirect(firstHalf)) {
        working = firstHalf; changed = true; continue;
      }
      if (await this._checkInconsistencyDirect(secondHalf)) {
        working = secondHalf; changed = true; continue;
      }
      break;
    }
    let i = 0;
    while (i < working.length) {
      if (working.length === 1) break;
      const without = [...working.slice(0, i), ...working.slice(i + 1)];
      if (await this._checkInconsistencyDirect(without)) {
        working = without;
      } else {
        i++;
      }
    }
    return working.length > 0 ? working : null;
  }

  /**
   * Explain why an axiom (subjectIri predicateIri objectIri) is ENTAILED by the
   * ontology — a Horridge-style justification for an arbitrary entailed axiom,
   * not just for inconsistency.
   *
   * Path B (entailment-as-unsatisfiability): α is entailed ⇔ O ∪ ¬α is
   * inconsistent. We add a small PROBE set encoding ¬α to the ontology's
   * candidate axioms, run the SAME BlackBox justification search used for
   * inconsistency, then strip the probe triples out of each justification. What
   * remains is a minimal subset of the ONTOLOGY's own axioms entailing α.
   *
   * Supported shapes (object must be an IRI): rdfs:subClassOf and rdf:type.
   * Other predicates / literal objects fall back to a pure asserted-triple
   * check: isEntailed reflects asserted presence, justifications stay empty.
   *
   * READ-ONLY — operates on a filtered copy of the store's base quads; never
   * mutates urn:vg:data.
   */
  explainEntailment(
    store: N3.Store,
    subjectIri: string,
    predicateIri: string,
    objectIri: string,
    objectIsClassLike: boolean,
    maxJustifications = 1,
  ): Promise<{
    isEntailed: boolean | null;
    justifications: N3.Quad[][];
    ontologyInconsistent?: boolean;
    vacuous?: boolean;
    reason?: string;
  }> {
    const result = this._queue.then(async () => {
      const allBase: N3.Quad[] = (store.getQuads(null, null, null, null) as N3.Quad[]).filter((q) => {
        const g = q.graph.termType === "DefaultGraph" ? "" : q.graph.value;
        return !EXCLUDED_FROM_REASONING.has(g);
      });

      // C1 (SOUNDNESS): the reduction α entailed ⇔ (O ∪ ¬α) inconsistent is only
      // VALID when O itself is consistent. If O is ALREADY inconsistent then
      // O ∪ ¬α is inconsistent for EVERY α, so the reduction would report
      // isEntailed:true for arbitrary non-entailed axioms, with a "justification"
      // that is the pre-existing contradiction — not α's support. Guard exactly
      // like explainInconsistency: bail out before running the reduction.
      if (await this._checkInconsistencyDirect(allBase)) {
        return {
          isEntailed: null as boolean | null,
          justifications: [] as N3.Quad[][],
          ontologyInconsistent: true,
          reason:
            "Ontology is already inconsistent; entailment is vacuous (everything is entailed by a contradiction). " +
            "Run explainDiagnostics and fix consistency first.",
        };
      }

      // Asserted-triple short circuit: if the exact axiom is already asserted it
      // is trivially "entailed" but there is nothing to explain beyond itself
      // (per spec: empty justifications for asserted-only).
      const assertedAxiom = allBase.some(
        (q) =>
          q.subject.value === subjectIri &&
          q.predicate.value === predicateIri &&
          q.object.value === objectIri,
      );

      // M1: a unique, deterministic probeId per call so the injected blank-node
      // labels (vg_neg_*/vg_wit_*) can never collide with a real ontology bnode
      // that happens to carry the constant default label. A monotonic counter is
      // deterministic (reproducible) and collision-proof — Math.random is not.
      const probeId = `probe_${++_entailmentProbeCounter}`;
      const probe = buildEntailmentProbe<N3.Quad>(
        N3.DataFactory as unknown as Parameters<typeof buildEntailmentProbe>[0],
        subjectIri,
        predicateIri,
        objectIri,
        objectIsClassLike,
        probeId,
      );

      if (probe.kind === "unsupported") {
        // No reduction available — report asserted presence with no derivation.
        return { isEntailed: assertedAxiom, justifications: [] as N3.Quad[][], ontologyInconsistent: false };
      }

      // O ∪ ¬α. The probe blank nodes are fresh, so they cannot collide with
      // ontology terms; _checkInconsistencyDirect de-skolemises urn:vg:bnode:*
      // IRIs but leaves real blank nodes (the probe terms) untouched.
      const withProbe = [...allBase, ...probe.probeQuads];
      const entailed = await this._checkInconsistencyDirect(withProbe);
      if (!entailed) {
        return { isEntailed: false, justifications: [] as N3.Quad[][] };
      }

      // C2 (SOUNDNESS): vacuous-truth detection. For the subClassOf shape the
      // probe asserts A ⊑ ¬B plus a witness `_w a A`. If class A is UNSATISFIABLE
      // in O alone (A ⊑ ⊥), the witness forces O inconsistent REGARDLESS of B, so
      // A ⊑ (anything) reports entailed. That is logically true (the empty class
      // is a subclass of everything) but the "derivation" is misleading — the
      // real cause is A's unsatisfiability, not any path A→B. Flag it explicitly.
      //
      // rdf:type shape: the analogous vacuous case is the subject individual being
      // forced into an unsatisfiable class by O alone — but since we already
      // verified O is consistent (C1 guard), a concrete individual that is part of
      // a consistent O cannot be independently unsatisfiable in the same sense
      // without contradicting that guard. There is therefore no clean reasoner
      // signal to surface for rdf:type here, so this vacuous detection is
      // intentionally limited to the subClassOf shape. (Documented limitation.)
      if (probe.kind === "subClassOf") {
        const unsat = await this._getUnsatisfiableClassesDirect(allBase);
        if (unsat.includes(subjectIri)) {
          return {
            isEntailed: true as boolean | null,
            justifications: [] as N3.Quad[][],
            vacuous: true,
            reason:
              `Subject class is unsatisfiable in the ontology, so it is a subclass of ` +
              `anything (vacuous truth). The entailment does not reflect a genuine ` +
              `derivation path to the requested superclass; fix the unsatisfiable ` +
              `class first (see explainDiagnostics / unsatisfiableClasses).`,
          };
        }
      }

      if (maxJustifications === 0) {
        return { isEntailed: true, justifications: [] as N3.Quad[][] };
      }

      // Filter the ONTOLOGY candidates the same way explainInconsistency does
      // (drop pure declarations / annotations that cannot drive entailment), but
      // ALWAYS keep the probe quads in the search set.
      const ANNOTATION_PREDICATES = new Set([
        "http://www.w3.org/2000/01/rdf-schema#label",
        "http://www.w3.org/2000/01/rdf-schema#comment",
        "http://www.w3.org/2000/01/rdf-schema#seeAlso",
        "http://www.w3.org/2000/01/rdf-schema#isDefinedBy",
      ]);
      const OWL_DECLARATION_OBJECTS = new Set([
        "http://www.w3.org/2002/07/owl#Class",
        "http://www.w3.org/2002/07/owl#ObjectProperty",
        "http://www.w3.org/2002/07/owl#DatatypeProperty",
        "http://www.w3.org/2002/07/owl#AnnotationProperty",
        "http://www.w3.org/2002/07/owl#NamedIndividual",
        "http://www.w3.org/2002/07/owl#Ontology",
      ]);
      const RDF_TYPE_URI = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
      const isNonLogical = (q: N3.Quad): boolean => {
        const pred = q.predicate.value;
        if (ANNOTATION_PREDICATES.has(pred)) return true;
        if (pred === RDF_TYPE_URI && OWL_DECLARATION_OBJECTS.has(q.object.value)) return true;
        return false;
      };
      const ontologyCandidates = allBase.filter((q) => !isNonLogical(q));
      const allCandidates = [...ontologyCandidates, ...probe.probeQuads];

      const stripProbe = (j: N3.Quad[]): N3.Quad[] =>
        j.filter((q) => !probe.probeKeys.has(`${q.subject.value}\0${q.predicate.value}\0${q.object.value}`));

      const justifications: N3.Quad[][] = [];

      const j1Raw = await this._findOneInconsistentJustification(allCandidates);
      if (!j1Raw || j1Raw.length === 0) {
        // Entailed but no minimal subset found (should not happen) — report
        // entailment without a derivation rather than a false negative.
        return { isEntailed: true, justifications: [] as N3.Quad[][] };
      }
      justifications.push(stripProbe(j1Raw));

      if (maxJustifications > 1) {
        // Hitting-set enumeration over the ONTOLOGY axioms only; probe quads are
        // never excluded (they encode the fixed query ¬α).
        const probeSet = probe.probeQuads;
        const hsQueue: Array<{ excluded: Set<string>; justification: N3.Quad[] }> = [
          { excluded: new Set(), justification: j1Raw },
        ];
        const exploredExclusions = new Set<string>();
        const keyOf = (q: N3.Quad) => `${q.subject.value}\0${q.predicate.value}\0${q.object.value}`;
        const jKeyOf = (j: N3.Quad[]) => j.map(keyOf).sort().join("|");
        while (hsQueue.length > 0 && justifications.length < maxJustifications) {
          const { excluded, justification: currentJ } = hsQueue.shift()!;
          const excludedKey = [...excluded].sort().join("|");
          if (exploredExclusions.has(excludedKey)) continue;
          exploredExclusions.add(excludedKey);
          for (const axiomInJ of currentJ) {
            // Never exclude probe axioms — only the ontology's own axioms.
            if (probe.probeKeys.has(keyOf(axiomInJ))) continue;
            const newExcluded = new Set(excluded);
            newExcluded.add(keyOf(axiomInJ));
            const newExcludedKey = [...newExcluded].sort().join("|");
            if (exploredExclusions.has(newExcludedKey)) continue;
            const reduced = [
              ...ontologyCandidates.filter((q) => !newExcluded.has(keyOf(q))),
              ...probeSet,
            ];
            if (!(await this._checkInconsistencyDirect(reduced))) continue;
            const jNew = await this._findOneInconsistentJustification(reduced);
            if (!jNew || jNew.length === 0) continue;
            const jKey = jKeyOf(jNew);
            const already = justifications.some(
              (j) => jKeyOf([...j, ...probeSet.filter((p) => jNew.some((x) => keyOf(x) === keyOf(p)))]) === jKey,
            ) || justifications.some((j) => jKeyOf(j) === jKeyOf(stripProbe(jNew)));
            if (!already) {
              justifications.push(stripProbe(jNew));
              if (justifications.length >= maxJustifications) break;
              hsQueue.push({ excluded: newExcluded, justification: jNew });
            }
          }
        }
      }

      return { isEntailed: true, justifications };
    });
    this._queue = result.then(() => {}, () => {});
    return result;
  }

  terminate(): void {
    this.worker.terminate();
    const err = new Error("Worker terminated");
    for (const e of this.pending.values()) e.reject(err);
    this.pending.clear();
  }
}

const RDF_TYPE_IRI = RDF_TYPE;
const RDFS_LABEL_IRI = RDFS_LABEL;

let _cachedQueryEngine: QueryEngine | null = null;

/**
 * TODO(rdf-reasoner-konclude): once workerUrl constructor option lands (plan-050,
 * Unit 1), replace this hand-rolled interface with the package's RdfReasoner
 * directly. The entailment/laconic/BlackBox methods here will be replaced by
 * reasoner API calls (explainEntailment, explainInconsistencyLaconic).
 *
 * The subset of KoncludeReasoner the worker runtime depends on. Declared as an
 * interface (not the concrete class) so a TEST can inject a node-compatible
 * adapter — the production KoncludeReasoner spawns a Web Worker (unavailable in
 * the node/jsdom test environments), so without this seam the incremental and
 * full Konclude paths could not be exercised end-to-end under vitest. The
 * production factory still returns the real KoncludeReasoner.
 */
export interface KoncludeReasonerLike {
  readonly ready: Promise<void>;
  reason(store: N3.Store): Promise<void>;
  checkConsistency(store: N3.Store): Promise<boolean>;
  getUnsatisfiableClasses(store: N3.Store): Promise<string[]>;
  explainInconsistency(store: N3.Store, maxJustifications?: number): Promise<N3.Quad[][]>;
  /**
   * LACONIC inconsistency explanation (Horridge et al. ISWC 2008). OPTIONAL —
   * the production KoncludeReasoner implements it; the test node adapter may omit
   * it (the worker handler guards on its presence and falls back to the plain
   * MIPS-only result). Returns, per justification, the original MIPS quads plus
   * the laconic axiom parts (superfluous-part-free) and their source mapping.
   */
  explainInconsistencyLaconic?(
    store: N3.Store,
    maxJustifications?: number,
  ): Promise<
    Array<{
      justification: N3.Quad[];
      laconic: SerializedLaconicJustification;
    }>
  >;
  explainEntailment(
    store: N3.Store,
    subjectIri: string,
    predicateIri: string,
    objectIri: string,
    objectIsClassLike: boolean,
    maxJustifications?: number,
  ): Promise<{
    isEntailed: boolean | null;
    justifications: N3.Quad[][];
    ontologyInconsistent?: boolean;
    vacuous?: boolean;
    reason?: string;
  }>;
  terminate(): void;
}

let _koncludeReasoner: KoncludeReasonerLike | null = null;
let _koncludeReasonerFactory: (() => KoncludeReasonerLike) | null = null;

/**
 * TEST-ONLY: override the Konclude reasoner factory so a node-compatible adapter
 * (e.g. one wrapping the package `RdfReasoner`) can drive the REAL worker
 * full-run paths under vitest. Pass `null` to restore
 * the production factory. Clears any cached instance so the override takes effect
 * on the next `getKoncludeReasoner()`.
 */
export function setKoncludeReasonerFactoryForTest(
  factory: (() => KoncludeReasonerLike) | null,
): void {
  if (_koncludeReasoner) {
    try { _koncludeReasoner.terminate(); } catch { /* ignore */ }
    _koncludeReasoner = null;
  }
  _koncludeReasonerFactory = factory;
}

function getKoncludeReasoner(): KoncludeReasonerLike {
  if (!_koncludeReasoner) {
    _koncludeReasoner = _koncludeReasonerFactory
      ? _koncludeReasonerFactory()
      : new KoncludeReasoner();
  }
  return _koncludeReasoner;
}

function resetKoncludeReasoner(): void {
  if (_koncludeReasoner) {
    _koncludeReasoner.terminate();
    _koncludeReasoner = null;
  }
}

/**
 * Create a graph term from a graph name string.
 * Returns defaultGraph() for "default" or null/undefined, otherwise creates a namedNode.
 */
function createGraphTerm(graphName: string | null | undefined, DataFactory: any): any {
  return graphName && graphName !== "default"
    ? DataFactory.namedNode(String(graphName))
    : DataFactory.defaultGraph();
}

type SubjectQuadMap = Record<string, WorkerQuad[]>;

type ReasoningStageMessage = {
  type: "reasoningStage";
  id: string;
  stage: string;
  meta?: Record<string, unknown>;
};

type ReasoningWarning = {
  nodeId?: string;
  edgeId?: string;
  message: string;
  rule: string;
  severity?: "critical" | "warning" | "info";
};

type ReasoningError = {
  nodeId?: string;
  edgeId?: string;
  message: string;
  rule: string;
  severity: "critical" | "error";
  sourceShape?: string;
  justification?: { subject: string; predicate: string; object: string }[];
};

type ReasoningInference = {
  type: "property" | "class" | "relationship";
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
};

type ReasoningResultMessage = {
  type: "reasoningResult";
  id: string;
  durationMs: number;
  startedAt: number;
  added?: WorkerQuad[];
  addedCount: number;
  warnings: ReasoningWarning[];
  errors: ReasoningError[];
  inferences: ReasoningInference[];
  usedReasoner: boolean;
  workerDurationMs?: number;
  ruleQuadCount?: number;
  isConsistent?: boolean | null;
};

type ReasoningErrorMessage = {
  type: "reasoningError";
  id: string;
  message: string;
  stack?: string;
};

type RunReasoningOptions = {
  mutateSharedStore?: boolean;
  includeAdded?: boolean;
  emitSubjects?: boolean;
  emitChange?: boolean;
  emitResultEvent?: boolean;
};

export interface RdfWorkerRuntime {
  handleEvent: (message: unknown) => void;
  terminate: () => void;
}

let workerDebugEnabled = false;

function debugLog(...args: unknown[]): void {
  if (workerDebugEnabled) console.debug(...args);
}

export function createRdfWorkerRuntime(postMessage: (message: unknown) => void): RdfWorkerRuntime {
  (globalThis as any).Buffer = Buffer;

  let sharedStore: any | null = null;
  let workerNamespaces: Record<string, string> = {};
  let workerBlacklistPrefixes: Set<string> = new Set(["owl", "rdf", "rdfs", "xml", "xsd"]);
  let workerBlacklistUris: string[] = [
    "http://www.w3.org/2002/07/owl",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "http://www.w3.org/2000/01/rdf-schema#",
    "http://www.w3.org/XML/1998/namespace",
    "http://www.w3.org/2001/XMLSchema#",
  ];
  let workerChangeCounter = 0;

  // ── Per-named-graph triple counters ────────────────────────────────────────
  //
  // getGraphCounts is called frequently (every reasoning report refresh, UI
  // panel update). Full-scanning the store with getQuads(null,null,null,null)
  // on every call is O(store size). Instead we maintain a Map<graphIri,count>
  // that is kept in lock-step with the shared store by wrapping its mutation
  // methods (addQuad / removeQuad / removeQuads) at store-creation time. Because
  // EVERY mutation of the shared store funnels through those methods, this single
  // wrapping point covers all mutation sites — import, syncBatch, clearInferred,
  // namespace rename, graph purge, the Konclude reasoner's inferred-quad writes,
  // etc. — without touching any of those (protected) regions.
  //
  // The map key matches collectGraphCountsFromStore's bucketing exactly:
  // a non-empty graph IRI uses that IRI; the default graph maps to
  // "urn:vg:default".
  let graphCounts: Map<string, number> = new Map();
  // True once the counters are known to mirror the live store. Any store reset
  // re-installs the wrappers and recomputes, flipping this back to true. A false
  // value forces a one-time full recompute in getGraphCounts (the fallback).
  let graphCountsReady = false;

  const DEFAULT_GRAPH_KEY = "urn:vg:default";

  function graphKeyOf(graphTerm: any): string {
    const v = graphTerm?.value;
    return typeof v === "string" && v.length > 0 ? v : DEFAULT_GRAPH_KEY;
  }

  function incGraphCount(graphTerm: any, delta: number): void {
    const key = graphKeyOf(graphTerm);
    const next = (graphCounts.get(key) || 0) + delta;
    if (next > 0) graphCounts.set(key, next);
    else graphCounts.delete(key);
  }

  /** Recompute the counter map from scratch by scanning the store once. */
  function recomputeGraphCounts(store: any): void {
    graphCounts = new Map();
    try {
      const quads = store.getQuads(null, null, null, null) || [];
      for (const q of quads) incGraphCount(q?.graph, 1);
    } catch (err) {
      debugLog("[VG_REASONING_WORKER] recomputeGraphCounts failed", err);
    }
    graphCountsReady = true;
  }

  /**
   * Wrap addQuad / removeQuad / removeQuads on a store so that every mutation
   * adjusts the incremental graph counters. N3 Store.addQuad/removeQuad return a
   * boolean indicating whether the store actually changed (dedup-aware), so the
   * counter delta is exact. removeQuads returns no delta, so we route it through
   * the wrapped removeQuad to stay precise.
   */
  function installGraphCountTracking(store: any): void {
    if (!store || store.__vgCountTracked) return;
    const origAddQuad = store.addQuad.bind(store);
    const origRemoveQuad = store.removeQuad.bind(store);
    const origAddQuads = typeof store.addQuads === "function" ? store.addQuads.bind(store) : null;

    store.addQuad = (...args: any[]) => {
      const changed = origAddQuad(...args);
      if (changed) {
        const q = args[0];
        // addQuad(quad) or addQuad(s, p, o, g)
        const graphTerm = args.length >= 4 ? args[3] : q?.graph;
        incGraphCount(graphTerm, 1);
      }
      return changed;
    };

    store.removeQuad = (...args: any[]) => {
      const changed = origRemoveQuad(...args);
      if (changed) {
        const q = args[0];
        const graphTerm = args.length >= 4 ? args[3] : q?.graph;
        incGraphCount(graphTerm, -1);
      }
      return changed;
    };

    // removeQuads(quads) — iterate through wrapped removeQuad for exact deltas.
    store.removeQuads = (quads: any) => {
      const list = Array.isArray(quads) ? quads : Array.from(quads || []);
      for (const q of list) store.removeQuad(q);
    };

    if (origAddQuads) {
      store.addQuads = (quads: any) => {
        const list = Array.isArray(quads) ? quads : Array.from(quads || []);
        for (const q of list) store.addQuad(q);
      };
    }

    Object.defineProperty(store, "__vgCountTracked", {
      value: true,
      enumerable: false,
      configurable: true,
    });
  }

  /**
   * Seed the store with OWL/RDFS/RDF meta-ontology domain/range axioms into the
   * ontology named graph (`urn:vg:ontologies`).  This is the same graph that
   * buildFatMap reads, so the fat-map reconciliation automatically picks up these
   * predicates and their domain/range values — producing correct ObjectProperty
   * entries that the mapper uses for data-driven TBox structural classification.
   *
   * These subjects are blacklisted from diagram emission (owl/rdf/rdfs prefixes),
   * so they never appear as canvas nodes. They exist solely to inform classification.
   */
  function loadSchemaOntology(store: any, DataFactory: any): void {
    try {
      const ontologiesGraph = DataFactory.namedNode("urn:vg:ontologies");
      const RDFS_DOMAIN = DataFactory.namedNode("http://www.w3.org/2000/01/rdf-schema#domain");
      const RDFS_RANGE  = DataFactory.namedNode("http://www.w3.org/2000/01/rdf-schema#range");
      for (const axiom of OWL_SCHEMA_AXIOMS) {
        const subject = DataFactory.namedNode(axiom.predicate);
        if (axiom.domain) {
          store.addQuad(subject, RDFS_DOMAIN, DataFactory.namedNode(axiom.domain), ontologiesGraph);
        }
        if (axiom.range) {
          store.addQuad(subject, RDFS_RANGE, DataFactory.namedNode(axiom.range), ontologiesGraph);
        }
      }
    } catch (err) {
      console.error("[rdfManager.worker] loadSchemaOntology failed", err);
    }
  }

  function fnv1a32(str: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }

  // Skolemize: replace blank-node subjects/objects with stable urn:vg:bnode:{hash} IRIs.
  // Hash is derived from the blank node's label (value) only — not its predicate-object
  // pairs — so the same label always maps to the same IRI regardless of batch size.
  // This enables building blank-node restrictions via individual addTriple calls:
  // every call that references "_:b0" produces the same urn:vg:bnode: IRI.
  // Callers are responsible for using distinct labels for distinct blank nodes.
  function skolemizeQuads(quads: Quad[], DataFactory: any): Quad[] {
    const hasBnodes = quads.some(
      (q) => q.subject.termType === "BlankNode" || q.object.termType === "BlankNode"
    );
    if (!hasBnodes) return quads;

    const cache = new Map<string, string>();
    const toIri = (id: string): string => {
      if (!cache.has(id)) cache.set(id, `urn:vg:bnode:${fnv1a32(id)}`);
      return cache.get(id)!;
    };

    return quads.map((q) => {
      const subj = q.subject.termType === "BlankNode"
        ? DataFactory.namedNode(toIri(q.subject.value))
        : q.subject;
      const obj = q.object.termType === "BlankNode"
        ? DataFactory.namedNode(toIri((q.object as any).value))
        : q.object;
      if (subj === q.subject && obj === q.object) return q;
      return DataFactory.quad(subj, q.predicate, obj, q.graph);
    });
  }

  function resetSharedStore(options?: { restore?: boolean }) {
    const { StoreCls, DataFactory } = resolveN3();
    if (!StoreCls) throw new Error("n3-store-unavailable");
    sharedStore = new (StoreCls as any)();
    workerChangeCounter = 0;
    graphCounts = new Map();
    graphCountsReady = true;
    installGraphCountTracking(sharedStore);
    // Non-negotiable: always seed the store with OWL/RDFS/RDF meta-ontology axioms
    if (DataFactory) loadSchemaOntology(sharedStore, DataFactory);
    return sharedStore;
  }

  function getSharedStore() {
    if (sharedStore) return sharedStore;
    return resetSharedStore({ restore: true });
  }

  function handleInbound(incoming: unknown) {
    if (!incoming) return;

    try {
      assertRdfWorkerInbound(incoming);
    } catch (err) {
      console.error("[rdfManager.worker] received malformed message", err);
      return;
    }

    switch (incoming.type) {
      case "command":
        void handleCommand(incoming);
        return;
      case "runReasoning": {
        const hasExternalQuads = Array.isArray(incoming.quads) && incoming.quads.length > 0;
        handleRunReasoning(incoming, {
          mutateSharedStore: !hasExternalQuads,
          includeAdded: hasExternalQuads,
          emitSubjects: !hasExternalQuads,
          emitChange: !hasExternalQuads,
          emitResultEvent: false,
        })
          .then((result) => {
            post(result);
          })
          .catch((err) => {
            const errorMessage: ReasoningErrorMessage = {
              type: "reasoningError",
              id: incoming.id,
              message: String((err as Error).message || err),
              stack: err instanceof Error && err.stack ? err.stack : undefined,
            };
            post(errorMessage);
          });
        return;
      }
      case "subscribe":
      case "unsubscribe":
        // Subscriptions are managed on the main thread; worker broadcasts to all listeners.
        return;
      default:
        console.warn("[rdfManager.worker] Unhandled message type", incoming);
    }
  }

  function post(message: any) {
    postMessage(message);
  }

  function reasoningStage(message: ReasoningStageMessage) {
    try {
      post(message);
    } catch (err) {
      debugLog("[rdfManager.worker] reasoningStage emission skipped", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Streaming liveness signal during a large importSerialized. Uses the same
  // {type:"event"} envelope that emitChange/emitSubjects use, so clients can
  // subscribe via worker.on("importProgress", cb).
  function emitImportProgress(
    id: string,
    loaded: number,
    graphName?: string,
    total?: number,
  ) {
    try {
      post({
        type: "event",
        event: "importProgress",
        payload: {
          id,
          loaded,
          ...(typeof total === "number" ? { total } : {}),
          ...(graphName ? { graphName } : {}),
        },
      });
    } catch (err) {
      debugLog("[rdfManager.worker] importProgress emission skipped", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  let lastChangeMeta: Record<string, unknown> | null = null;

  function emitChange(meta?: Record<string, unknown> | null) {
    try {
      lastChangeMeta = meta ? { ...meta } : null;
      workerChangeCounter += 1;
      post({
        type: "event",
        event: "change",
        payload: { changeCount: workerChangeCounter, meta: meta || null },
      });
    } catch (err) {
      console.error("[rdfManager.worker] emitChange failed", err);
    }
  }

  function emitSubjects(
    subjects: string[],
    quadsBySubject?: SubjectQuadMap,
    snapshot?: WorkerReconcileSubjectSnapshotPayload[],
    meta?: Record<string, unknown> | null,
  ) {
    const effectiveMeta =
      typeof meta === "undefined" ? lastChangeMeta : meta;
    lastChangeMeta = null;
    const serialisedMeta =
      effectiveMeta && typeof effectiveMeta === "object"
        ? { ...effectiveMeta }
        : effectiveMeta ?? null;
    try {
      post({
        type: "event",
        event: "subjects",
        payload: {
          subjects,
          quads:
            quadsBySubject && Object.keys(quadsBySubject).length > 0
              ? quadsBySubject
              : undefined,
          snapshot:
            snapshot && snapshot.length > 0
              ? snapshot
              : undefined,
          meta: serialisedMeta,
        },
      });
    } catch (err) {
      console.error("[rdfManager.worker] emitSubjects failed", err);
    }
  }

  function resolveN3() {
    const mod: any = N3;
    const root = mod && mod.default ? mod.default : mod;
    const DataFactory = (root && root.DataFactory) ? root.DataFactory : null;
    const StoreCls = (root && root.Store) ? root.Store : null;
    const ParserCls = (root && root.Parser) ? root.Parser : null;
    const ReasonerCls =
      (root && root.Reasoner) ||
      (root && root.N3Reasoner) ||
      (root && root.default && (root.default.Reasoner || root.default.N3Reasoner)) ||
      N3ReasonerExplicit ||
      null;
    return { DataFactory, StoreCls, ParserCls, ReasonerCls };
  }

  function quadKeyFromTerms(q: any): string {
    try {
      const s = q.subject && q.subject.value ? String(q.subject.value) : "";
      const p = q.predicate && q.predicate.value ? String(q.predicate.value) : "";
      const o = q.object && q.object.value ? String(q.object.value) : "";
      const g = q.graph && q.graph.value ? String(q.graph.value) : "";
      return `${s}|${p}|${o}|${g}`;
    } catch (_) {
      return Math.random().toString(36).slice(2);
    }
  }

  function subjectTermToString(term: any, fallback?: string): string {
    try {
      if (!term) return fallback || "";
      const value = term.value ?? "";
      if (term.termType === "BlankNode") {
        return `_:${String(value)}`;
      }
      return String(value || "");
    } catch (_) {
      return fallback || "";
    }
  }

  const VG_LOADED_FROM = "urn:vg:loadedFrom";

  function collectWorkerQuadsForSubject(subject: string, store: any, DataFactory: any): WorkerQuad[] {
    try {
      const term =
        /^_:/i.test(String(subject))
          ? DataFactory.blankNode(String(subject).replace(/^_:/, ""))
          : DataFactory.namedNode(String(subject));
      const quads = store.getQuads(term, null, null, null) || [];
      const out: WorkerQuad[] = [];
      for (const q of quads) {
        try {
          if (q.predicate?.value === VG_LOADED_FROM) continue;
          out.push(serializeQuad(q));
        } catch (err) {
          console.error("[rdfManager.worker] collectWorkerQuadsForSubject serialize failed", err);
        }
      }
      return out;
    } catch (err) {
      console.error("[rdfManager.worker] collectWorkerQuadsForSubject failed", err);
      return [];
    }
  }

  function snapshotEntryFromQuads(
    subject: string,
    quads: WorkerQuad[] | undefined,
  ): WorkerReconcileSubjectSnapshotPayload | null {
    const iri = String(subject || "").trim();
    if (!iri) return null;
    const types = new Set<string>();
    let label: string | undefined;
    for (const quad of quads || []) {
      if (!quad || !quad.predicate) continue;
      const predicate = String(quad.predicate.value || "");
      if (!predicate) continue;
      if (predicate === RDF_TYPE_IRI && quad.object) {
        const objectValue = String((quad.object as any).value || "");
        if (objectValue) types.add(objectValue);
        continue;
      }
      if (!label && predicate === RDFS_LABEL_IRI && quad.object) {
        const term = quad.object as any;
        if (typeof term.value === "string" && term.value.trim().length > 0) {
          label = term.value;
        }
      }
    }
    return {
      iri,
      types: Array.from(types),
      ...(label ? { label } : {}),
    };
  }

  function termToString(term: any): string {
    try {
      if (!term) return "";
      if (term.termType === "BlankNode") {
        return `_:${String(term.value || "")}`;
      }
      if (term.termType === "Literal") {
        return String(term.value || "");
      }
      if (term.termType === "NamedNode") {
        return String(term.value || "");
      }
      if (typeof term === "object" && term.value) {
        return String(term.value);
      }
      return String(term);
    } catch (_) {
      return "";
    }
  }

  type ReasonerInsertion = {
    subject: string | undefined;
    predicate: string | undefined;
    object: string | undefined;
  };

  /**
   * Convert a value from the N3.js _entities map to an RDF Term.
   *
   * The N3.js Store's `_entities` object maps numeric IDs to string representations:
   *   - Named nodes: plain IRI string (e.g. "http://example.org/alice")
   *   - Default graph: empty string ""
   *   - Blank nodes: "_:localname"
   *   - Literals: '"value"', '"value"@lang', '"value"^^datatype'
   */
  function termFromReasonerValue(DataFactory: any, value: unknown): any {
    if (value === null || value === undefined) return null;
    const str = String(value);
    if (str === "") return DataFactory.defaultGraph();
    // Blank node
    if (str.startsWith("_:")) return DataFactory.blankNode(str.slice(2));
    // N3.js literal formats (all start with '"')
    if (str.startsWith('"')) {
      const langMatch = /^"(.*)"@([a-zA-Z-]+)$/.exec(str);
      if (langMatch) return DataFactory.literal(langMatch[1], langMatch[2]);
      const typedMatch = /^"(.*)"\^\^(.+)$/.exec(str);
      if (typedMatch) return DataFactory.literal(typedMatch[1], DataFactory.namedNode(typedMatch[2]));
      const plainMatch = /^"(.*)"$/.exec(str);
      if (plainMatch) return DataFactory.literal(plainMatch[1]);
      return DataFactory.literal(str);
    }
    // Absolute IRI
    if (/^[a-zA-Z][a-zA-Z0-9+\-.]*:[^\s]/.test(str)) return DataFactory.namedNode(str);
    return DataFactory.literal(str);
  }

  function attachReasonerAddInterceptor(reasoner: any, store: any) {
    if (!reasoner || typeof reasoner._add !== "function") {
      return () => [] as ReasonerInsertion[];
    }
    const originalAdd = reasoner._add.bind(reasoner);
    const insertions: ReasonerInsertion[] = [];
    const seen = new Set<string>();
    // N3.js Store._entities maps numeric entity IDs → N3.js term string representations
    const entities: Record<string | number, string> = store._entities ?? {};

    const resolveId = (id: any): string | undefined => {
      if (id === null || id === undefined) return undefined;
      return entities[id] ?? entities[String(id)];
    };

    reasoner._add = (subject: unknown, predicate: unknown, object: unknown, graphItem: any, cb: () => void) => {
      originalAdd(subject, predicate, object, graphItem, () => {
        try {
          const sStr = resolveId(subject);
          const pStr = resolveId(predicate);
          const oStr = resolveId(object);
          if (sStr !== undefined && pStr !== undefined && oStr !== undefined) {
            const dedupeKey = `${sStr}|${pStr}|${oStr}`;
            if (!seen.has(dedupeKey)) {
              seen.add(dedupeKey);
              insertions.push({ subject: sStr, predicate: pStr, object: oStr });
            }
          }
        } catch (_) {
          /* ignore capture failures */
        }
        if (typeof cb === "function") cb();
      });
    };

    return () => insertions;
  }

  function isBlacklistedIri(iri: string): boolean {
    try {
      const value = String(iri || "").trim();
      if (!value) return false;
      if (value.startsWith("_:")) return false;

      if (!/^https?:\/\//i.test(value) && value.includes(":")) {
        const prefix = value.split(":", 1)[0];
        if (workerBlacklistPrefixes.has(prefix)) return true;
      }

      const candidates = new Set<string>();
      for (const uri of workerBlacklistUris) {
        if (uri) candidates.add(String(uri));
      }

      for (const prefix of Array.from(workerBlacklistPrefixes)) {
        const namespace = workerNamespaces[prefix];
        if (namespace) candidates.add(String(namespace));

        const wkPrefix = WELL_KNOWN?.prefixes?.[prefix];
        if (wkPrefix) candidates.add(String(wkPrefix));

        const ontologies = WELL_KNOWN?.ontologies ?? {};
        for (const [ontUrl, meta] of Object.entries(ontologies)) {
          const data = meta as { namespaces?: Record<string, string>; aliases?: string[] } | undefined;
          if (!data?.namespaces?.[prefix]) continue;
          candidates.add(String(ontUrl));
          if (Array.isArray(data.aliases)) {
            for (const alias of data.aliases) {
              if (alias) candidates.add(String(alias));
            }
          }
        }
      }

      const normalized = new Set<string>();
      for (const candidate of candidates) {
        const trimmed = String(candidate || "").trim();
        if (!trimmed) continue;
        normalized.add(trimmed);
        if (trimmed.endsWith("#")) normalized.add(trimmed.slice(0, -1));
        else normalized.add(`${trimmed}#`);
        if (trimmed.endsWith("/")) normalized.add(trimmed.slice(0, -1));
        else normalized.add(`${trimmed}/`);
      }

      for (const candidate of normalized) {
        if (candidate && value.startsWith(candidate)) return true;
      }
    } catch (err) {
      console.error("[rdfManager.worker] isBlacklistedIri failed", err);
    }
    return false;
  }

  function prepareSubjectEmissionFromSet(
    subjectSet: Set<string>,
    store: any,
    DataFactory: any,
  ): {
    subjects: string[];
    quadsBySubject: SubjectQuadMap;
    snapshot: WorkerReconcileSubjectSnapshotPayload[];
  } {
    const RDF_REST_IRI = "http://www.w3.org/1999/02/22-rdf-syntax-ns#rest";

    const subjects: string[] = [];
    const quadsBySubject: SubjectQuadMap = {};
    const snapshot: WorkerReconcileSubjectSnapshotPayload[] = [];

    // Use a queue so rdf:rest chains are followed inline.
    // When any subject has a rdf:rest → BlankNode triple, that blank node is
    // enqueued as an additional subject so its own quads (including rdf:first →
    // member) are also emitted — without requiring a separate round-trip query.
    const queue: string[] = Array.from(subjectSet);
    const processed = new Set<string>();

    while (queue.length > 0) {
      const raw = queue.shift()!;
      try {
        const subject = String(raw || "").trim();
        if (!subject || processed.has(subject)) continue;
        processed.add(subject);

        if (isBlacklistedIri(subject)) continue;
        subjects.push(subject);
        const quads = collectWorkerQuadsForSubject(subject, store, DataFactory);
        quadsBySubject[subject] = quads;
        const entry = snapshotEntryFromQuads(subject, quads);
        if (entry) snapshot.push(entry);

        // Follow rdf:rest → BlankNode chains so every cons-cell in the list is
        // emitted together with its quads (including rdf:first → member triples).
        for (const q of quads) {
          if (q.predicate?.value !== RDF_REST_IRI) continue;
          if (q.object?.termType !== "BlankNode") continue;
          const bnSubject = `_:${String(q.object.value)}`;
          if (!processed.has(bnSubject)) {
            queue.push(bnSubject);
          }
        }
      } catch (err) {
        console.error("[rdfManager.worker] prepareSubjectEmissionFromSet item failed", err);
      }
    }
    return { subjects, quadsBySubject, snapshot };
  }

  function collectShaclResults(all: Quad[]): { warnings: ReasoningWarning[]; errors: ReasoningError[] } {
    // Use imported constants from vocabularies.ts
    const SH_RESULT = SHACL.ValidationResult;
    const SH_FOCUS = SHACL.focusNode;
    const SH_MESSAGE = SHACL.resultMessage;
    const SH_SEVERITY = SHACL.resultSeverity;
    const SEVERITY_VIOLATION = SHACL.Violation;

    const bySubject = new Map<string, Quad[]>();
    for (const q of all) {
      const graphIri =
        q.graph && q.graph.termType !== "DefaultGraph" ? String(q.graph.value) : "";
      const key = `${graphIri}|${String(q.subject.value)}`;
      const existing = bySubject.get(key) || [];
      existing.push(q);
      bySubject.set(key, existing);
    }

    const warnings: ReasoningWarning[] = [];
    const errors: ReasoningError[] = [];

    for (const q of all) {
      if (q.predicate.value !== RDF_TYPE) continue;
      if (q.object.termType !== "NamedNode" || q.object.value !== SH_RESULT) continue;
      const graphIri =
        q.graph && q.graph.termType !== "DefaultGraph" ? String(q.graph.value) : "";
      const key = `${graphIri}|${String(q.subject.value)}`;
      const subjectQuads = bySubject.get(key) || [];
      
      // Find ALL focus nodes (N3 reasoner may create multiple sh:focusNode triples)
      const focusNodes = subjectQuads
        .filter((sq) => sq.predicate.value === SH_FOCUS)
        .map((sq) => termToString(sq.object))
        .filter(Boolean);
      
      const message = subjectQuads.find((sq) => sq.predicate.value === SH_MESSAGE);
      const severityQuad = subjectQuads.find((sq) => sq.predicate.value === SH_SEVERITY);

      const messageText = message ? termToString(message.object) || "Validation issue" : "Validation issue";
      const severityUri = severityQuad ? termToString(severityQuad.object) : "";
      const severity =
        severityUri && severityUri.includes("Violation") ? "critical" : "warning";
      
      // Create separate error/warning for each focus node
      for (const nodeId of focusNodes) {
        if (severity === "critical") {
          errors.push({
            nodeId,
            message: messageText,
            rule: "sh:ValidationResult",
            severity: "critical",
          });
        } else {
          warnings.push({
            nodeId,
            message: messageText,
            rule: "sh:ValidationResult",
            severity: severity === "warning" ? "warning" : "info",
          });
        }
      }
    }

    return { warnings, errors };
  }

  interface ShaclViolation {
    focusNode: string | null;
    path: string | null;
    severity: string | null;
    message: string | null;
    sourceShape: string | null;
    constraint: string | null;
    source: "shacl";
  }

  interface ShaclValidationResult {
    conforms: boolean;
    violations: ShaclViolation[];
    shapeCount: number;
  }

  async function runShaclValidation(): Promise<ShaclValidationResult> {
    const { DataFactory } = resolveN3();
    if (!DataFactory) throw new Error("n3-datafactory-unavailable");
    const store = getSharedStore();

    const shapesGraph = DataFactory.namedNode("urn:vg:shapes");
    const shapesQuads = store.getQuads(null, null, null, shapesGraph) || [];
    if (shapesQuads.length === 0) {
      return { conforms: true, violations: [], shapeCount: 0 };
    }

    const dataGraph = DataFactory.namedNode("urn:vg:data");
    const inferredGraph = DataFactory.namedNode("urn:vg:inferred");
    const dataQuads = [
      ...(store.getQuads(null, null, null, dataGraph) || []),
      ...(store.getQuads(null, null, null, inferredGraph) || []),
    ];

    const [shaclMod, sparqlMod, dataModelMod, datasetMod] = await Promise.all([
      import("shacl-engine") as Promise<any>,
      import("shacl-engine/sparql.js") as Promise<any>,
      import("@rdfjs/data-model") as Promise<any>,
      import("@rdfjs/dataset") as Promise<any>,
    ]);
    const { Validator } = shaclMod;
    const { targetResolvers } = sparqlMod;
    const factory = dataModelMod.default ?? dataModelMod;
    const dataset = datasetMod.default?.dataset ?? datasetMod.dataset;

    function convertTerm(term: any) {
      if (term.termType === "BlankNode") return factory.blankNode(term.value);
      if (term.termType === "Literal")
        return factory.literal(term.value, term.language || (term.datatype ? factory.namedNode(term.datatype.value) : undefined));
      return factory.namedNode(term.value);
    }

    const shapesDs = dataset();
    for (const q of shapesQuads) {
      shapesDs.add(factory.quad(convertTerm(q.subject), factory.namedNode(q.predicate.value), convertTerm(q.object)));
    }

    const dataDs = dataset();
    for (const q of dataQuads) {
      dataDs.add(factory.quad(convertTerm(q.subject), factory.namedNode(q.predicate.value), convertTerm(q.object)));
    }

    const SH_NODESHAPE = "http://www.w3.org/ns/shacl#NodeShape";

    const shapeCount = [...shapesDs].filter(
      (q: any) => q.predicate.value === RDF_TYPE && q.object.value === SH_NODESHAPE,
    ).length;

    const validator = new Validator(shapesDs, { factory, targetResolvers });
    let report: any;
    try {
      report = await validator.validate({ dataset: dataDs });
    } catch (valErr: any) {
      const msg = valErr?.message ?? String(valErr);
      return {
        conforms: false,
        violations: [{
          focusNode: null, path: null, severity: "sh:Violation",
          message: `Validation engine error: ${msg}`,
          sourceShape: null, constraint: null, source: "shacl" as const,
        }],
        shapeCount,
      };
    }

    // Build reverse map: property shape (blank node) → parent NodeShape IRI
    const SH_PROPERTY = "http://www.w3.org/ns/shacl#property";
    const propShapeToNodeShape = new Map<string, string>();
    for (const q of [...shapesDs] as any[]) {
      if (q.predicate.value === SH_PROPERTY && q.subject.termType === "NamedNode") {
        propShapeToNodeShape.set(q.object.value, q.subject.value);
      }
    }

    // Collect subjects present in user data so we can exclude ontology classes
    // that reasoning materialized into the inferred graph.
    const dataSubjects = new Set<string>();
    for (const q of store.getQuads(null, null, null, dataGraph) || []) {
      if (q.subject?.value) dataSubjects.add(q.subject.value);
    }

    const violations: ShaclViolation[] = (report.results ?? []).map((r: any) => {
      let shapeVal = r.shape?.ptr?.term?.value ?? null;
      if (shapeVal && propShapeToNodeShape.has(shapeVal)) {
        shapeVal = propShapeToNodeShape.get(shapeVal)!;
      }
      const pathVal = Array.isArray(r.path) ? (r.path[0]?.predicates?.[0]?.value ?? null) : (r.path?.value ?? null);
      const msgVal = Array.isArray(r.message)
        ? r.message.map((m: any) => m.value).join("; ")
        : (typeof r.message === "string" ? r.message : (r.message?.value ?? null));
      return {
        focusNode: r.focusNode?.value ?? null,
        path: pathVal,
        severity: r.severity?.value?.replace("http://www.w3.org/ns/shacl#", "sh:") ?? null,
        message: msgVal,
        sourceShape: shapeVal,
        constraint: r.constraintComponent?.value ?? null,
        source: "shacl" as const,
      };
    }).filter((v: ShaclViolation) => !v.focusNode || dataSubjects.has(v.focusNode));

    return { conforms: report.conforms, violations, shapeCount };
  }

  function collectGraphCountsFromStore(store: any): Record<string, number> {
    // Fast path: for the live shared store, serve from the maintained counters
    // (O(graphs)) instead of scanning every quad. The counters are kept in
    // lock-step via the wrapped mutation methods installed in resetSharedStore.
    // Fallback: if the counters were never initialised for this store (e.g. a
    // store created before tracking was installed), recompute once and cache.
    if (store && store === sharedStore) {
      if (!graphCountsReady || !store.__vgCountTracked) {
        recomputeGraphCounts(store);
      }
      const out: Record<string, number> = {};
      for (const [k, v] of graphCounts) out[k] = v;
      return out;
    }

    // Transient / non-shared store (e.g. reasoning working copies): full scan.
    const counts: Record<string, number> = {};
    try {
      const quads = store.getQuads(null, null, null, null) || [];
      for (const q of quads) {
        const graphValue = q?.graph?.value;
        const graphName =
          typeof graphValue === "string" && graphValue.length > 0 ? graphValue : "urn:vg:default";
        counts[graphName] = (counts[graphName] || 0) + 1;
      }
    } catch (err) {
      debugLog("[VG_REASONING_WORKER] collectGraphCountsFromStore failed", err);
    }
    return counts;
  }

  function collectOntologyStats(store: any): Record<string, unknown> {
    const DATA_GRAPH_IRI = "urn:vg:data";
    const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
    const OWL_CLASS = "http://www.w3.org/2002/07/owl#Class";
    const RDFS_CLASS = "http://www.w3.org/2000/01/rdf-schema#Class";
    const OWL_OBJECT_PROPERTY = "http://www.w3.org/2002/07/owl#ObjectProperty";
    const OWL_DATATYPE_PROPERTY = "http://www.w3.org/2002/07/owl#DatatypeProperty";
    const OWL_NAMED_INDIVIDUAL = "http://www.w3.org/2002/07/owl#NamedIndividual";
    const RDFS_LABEL = "http://www.w3.org/2000/01/rdf-schema#label";

    try {
      const toSet = (quads: any[]): Set<string> => {
        const s = new Set<string>();
        for (const q of quads) {
          const v = q?.subject?.value;
          if (typeof v === "string" && v.length > 0) s.add(v);
        }
        return s;
      };

      const owlClasses = toSet(store.getQuads(null, RDF_TYPE, OWL_CLASS, DATA_GRAPH_IRI));
      const rdfsClasses = toSet(store.getQuads(null, RDF_TYPE, RDFS_CLASS, DATA_GRAPH_IRI));
      const classSubjects = new Set([...owlClasses, ...rdfsClasses]);

      const objectPropertyCount = toSet(store.getQuads(null, RDF_TYPE, OWL_OBJECT_PROPERTY, DATA_GRAPH_IRI)).size;
      const datatypePropertyCount = toSet(store.getQuads(null, RDF_TYPE, OWL_DATATYPE_PROPERTY, DATA_GRAPH_IRI)).size;
      const namedIndividualCount = toSet(store.getQuads(null, RDF_TYPE, OWL_NAMED_INDIVIDUAL, DATA_GRAPH_IRI)).size;

      const allQuads = store.getQuads(null, null, null, DATA_GRAPH_IRI);
      const allSubjects = new Set<string>();
      for (const q of allQuads) {
        const v = q?.subject?.value;
        if (typeof v === "string" && v.length > 0) allSubjects.add(v);
      }

      const labeledSubjects = toSet(store.getQuads(null, RDFS_LABEL, null, DATA_GRAPH_IRI));
      let labeledClassCount = 0;
      for (const cls of classSubjects) {
        if (labeledSubjects.has(cls)) labeledClassCount++;
      }

      const gc = collectGraphCountsFromStore(store);
      const assertedTriples = gc[DATA_GRAPH_IRI] || 0;
      const inferredTriples = gc["urn:vg:inferred"] || 0;
      const totalTriples = assertedTriples;

      const namespacePrefixes = Object.entries(workerNamespaces);
      const nsBuckets = new Map<string, { prefix: string; uri: string; subjects: number }>();
      for (const subj of allSubjects) {
        for (const [prefix, uri] of namespacePrefixes) {
          if (subj.startsWith(uri)) {
            const existing = nsBuckets.get(uri);
            if (existing) {
              existing.subjects++;
            } else {
              nsBuckets.set(uri, { prefix, uri, subjects: 1 });
            }
            break;
          }
        }
      }
      const namespaceBreakdown = Array.from(nsBuckets.values())
        .filter((r) => r.subjects > 0)
        .sort((a, b) => b.subjects - a.subjects);

      return {
        totalTriples,
        classCount: classSubjects.size,
        objectPropertyCount,
        datatypePropertyCount,
        namedIndividualCount,
        subjectCount: allSubjects.size,
        labeledClassCount,
        assertedTriples,
        inferredTriples,
        namespaceBreakdown,
      };
    } catch (err) {
      debugLog("[VG_REASONING_WORKER] collectOntologyStats failed", err);
      return {
        totalTriples: 0,
        classCount: 0,
        objectPropertyCount: 0,
        datatypePropertyCount: 0,
        namedIndividualCount: 0,
        subjectCount: 0,
        labeledClassCount: 0,
        assertedTriples: 0,
        inferredTriples: 0,
        namespaceBreakdown: [],
      };
    }
  }

  // ── searchTerms (grounding / retrieval) ───────────────────────────────────
  //
  // Pure store query: find existing ontology terms by label or IRI local-name
  // across ALL graphs (especially urn:vg:ontologies) so agents reuse existing
  // IRIs instead of minting new ones. No reasoner involved.

  type SearchKind = "class" | "objectProperty" | "datatypeProperty" | "property" | "individual";

  type SearchTermResult = {
    iri: string;
    label: string;
    kind: SearchKind;
    prefix?: string;
    score: number;
  };

  const SKOS_PREF_LABEL = "http://www.w3.org/2004/02/skos/core#prefLabel";
  const SKOS_ALT_LABEL = "http://www.w3.org/2004/02/skos/core#altLabel";
  // rdf:type object IRI → the search kind it implies.
  const TYPE_IRI_TO_KIND: Record<string, SearchKind> = {
    "http://www.w3.org/2002/07/owl#Class": "class",
    "http://www.w3.org/2000/01/rdf-schema#Class": "class",
    "http://www.w3.org/2002/07/owl#ObjectProperty": "objectProperty",
    "http://www.w3.org/2002/07/owl#DatatypeProperty": "datatypeProperty",
    "http://www.w3.org/2002/07/owl#AnnotationProperty": "property",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#Property": "property",
    "http://www.w3.org/2002/07/owl#NamedIndividual": "individual",
  };
  // A requested kind matches a candidate's kind set. "property" is an umbrella
  // that also accepts object/datatype/annotation properties.
  function kindMatchesRequest(requested: Set<SearchKind>, candidateKinds: Set<SearchKind>): boolean {
    for (const k of candidateKinds) {
      if (requested.has(k)) return true;
      if (requested.has("property") && (k === "objectProperty" || k === "datatypeProperty")) {
        return true;
      }
    }
    return false;
  }

  function localNameOf(iri: string): string {
    const hash = iri.lastIndexOf("#");
    if (hash >= 0) return iri.slice(hash + 1);
    const slash = iri.lastIndexOf("/");
    if (slash >= 0) return iri.slice(slash + 1);
    const colon = iri.lastIndexOf(":");
    if (colon >= 0) return iri.slice(colon + 1);
    return iri;
  }

  // Resolve the prefix for an IRI: prefer the worker's live namespace map, then
  // fall back to the well-known registry, using longest-namespace-wins so more
  // specific namespaces (e.g. pmdco) beat broad ones.
  function resolvePrefixForIri(iri: string): string | undefined {
    let best: { prefix: string; len: number } | undefined;
    const consider = (prefix: string, ns: string) => {
      if (!ns || !prefix) return;
      if (!iri.startsWith(ns)) return;
      if (!best || ns.length > best.len) best = { prefix, len: ns.length };
    };
    for (const [prefix, ns] of Object.entries(workerNamespaces)) consider(prefix, String(ns));
    const wk = WELL_KNOWN?.prefixes ?? {};
    for (const [prefix, ns] of Object.entries(wk)) consider(prefix, String(ns));
    return best?.prefix;
  }

  /**
   * Ranking (higher = better match):
   *   100  exact label match
   *    80  label startsWith query
   *    60  label substring contains query
   *    50  exact local-name match
   *    40  local-name startsWith query
   *    30  local-name substring contains query
   * A small +5 bonus is added when the term has any label at all (prefer
   * documented terms). The best (highest) score across all of a term's labels
   * and its local name is kept.
   */
  function scoreMatch(query: string, labels: string[], localName: string): number {
    const q = query.trim().toLowerCase();
    if (!q) return 0;
    let best = 0;
    for (const raw of labels) {
      const label = String(raw || "").toLowerCase();
      if (!label) continue;
      if (label === q) best = Math.max(best, 100);
      else if (label.startsWith(q)) best = Math.max(best, 80);
      else if (label.includes(q)) best = Math.max(best, 60);
    }
    const ln = localName.toLowerCase();
    if (ln === q) best = Math.max(best, 50);
    else if (ln.startsWith(q)) best = Math.max(best, 40);
    else if (ln.includes(q)) best = Math.max(best, 30);
    if (best > 0 && labels.some((l) => String(l || "").trim().length > 0)) best += 5;
    return best;
  }

  function searchTermsInStore(
    store: any,
    payload: RDFWorkerCommandPayloads["searchTerms"],
  ): { results: SearchTermResult[] } {
    const query = String(payload?.query ?? "").trim();
    const limit =
      typeof payload?.limit === "number" && payload.limit > 0 ? Math.floor(payload.limit) : 25;
    const requestedKinds = new Set<SearchKind>(
      payload?.kinds && payload.kinds.length > 0
        ? payload.kinds
        : (["class", "objectProperty", "datatypeProperty", "property"] as SearchKind[]),
    );
    if (!query) return { results: [] };

    // Accumulate per-subject metadata across ALL graphs in one store pass.
    const meta = new Map<string, { kinds: Set<SearchKind>; labels: string[] }>();
    const ensure = (iri: string) => {
      let entry = meta.get(iri);
      if (!entry) {
        entry = { kinds: new Set<SearchKind>(), labels: [] };
        meta.set(iri, entry);
      }
      return entry;
    };

    const allQuads = store.getQuads(null, null, null, null) || [];
    for (const q of allQuads) {
      const subj = q?.subject;
      if (!subj || subj.termType !== "NamedNode") continue; // skip blank nodes / literals
      const subjIri = String(subj.value || "");
      if (!subjIri) continue;
      const pred = String(q?.predicate?.value || "");
      const obj = q?.object;

      if (pred === RDF_TYPE_IRI && obj?.termType === "NamedNode") {
        const kind = TYPE_IRI_TO_KIND[String(obj.value)];
        if (kind) ensure(subjIri).kinds.add(kind);
        continue;
      }
      if (
        (pred === RDFS_LABEL_IRI || pred === SKOS_PREF_LABEL || pred === SKOS_ALT_LABEL) &&
        obj?.termType === "Literal"
      ) {
        const text = String(obj.value || "").trim();
        if (text) ensure(subjIri).labels.push(text);
      }
    }

    const results: SearchTermResult[] = [];
    for (const [iri, entry] of meta) {
      // Only terms whose declared kind set intersects the requested kinds.
      if (entry.kinds.size === 0) continue;
      if (!kindMatchesRequest(requestedKinds, entry.kinds)) continue;

      const localName = localNameOf(iri);
      const score = scoreMatch(query, entry.labels, localName);
      if (score <= 0) continue;

      // Pick the representative kind: prefer one the caller actually asked for.
      let kind: SearchKind | undefined;
      for (const k of entry.kinds) {
        if (
          requestedKinds.has(k) ||
          (requestedKinds.has("property") && (k === "objectProperty" || k === "datatypeProperty"))
        ) {
          kind = k;
          break;
        }
      }
      if (!kind) kind = entry.kinds.values().next().value as SearchKind;

      results.push({
        iri,
        label: entry.labels[0] ?? "",
        kind,
        prefix: resolvePrefixForIri(iri),
        score,
      });
    }

    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Stable secondary ordering: labelled before unlabelled, then by IRI.
      const al = a.label ? 0 : 1;
      const bl = b.label ? 0 : 1;
      if (al !== bl) return al - bl;
      return a.iri.localeCompare(b.iri);
    });

    return { results: results.slice(0, limit) };
  }

  function resolveRdfParser(pkg: any) {
    if (!pkg) return null;
    if (typeof pkg.parse === "function") return pkg;
    if (pkg.rdfParser && typeof pkg.rdfParser.parse === "function") return pkg.rdfParser;
    if (pkg.default && typeof pkg.default.parse === "function") return pkg.default;
    return null;
  }

  function createReadableFromString(content: string) {
    try {
      const text = typeof content === "string" ? content : String(content ?? "");
      const BufferImpl = (globalThis as any).Buffer || Buffer;
      if (typeof (Readable as any).from === "function" && BufferImpl) {
        return (Readable as any).from([BufferImpl.from(text)]);
      }
      const stream = new Readable();
      stream.push(BufferImpl ? BufferImpl.from(text) : text);
      stream.push(null);
      return stream;
    } catch (err) {
      debugLog("[rdfManager.worker] createReadableFromString failed", err);
      return null;
    }
  }

  /**
   * Resolve an export format string into the writer format + media type, and crucially
   * whether the serialisation can REPRESENT named graphs.
   *
   * `dropGraph:true`  → single-graph formats (Turtle / JSON-LD / RDF-XML). These cannot
   *                     encode quads, so every quad must be remapped into the default
   *                     graph before writing. The multi-graph partition is flattened.
   * `dropGraph:false` → dataset formats (N-Quads / TriG). N3.js' Writer emits the graph
   *                     term for each quad, so the urn:vg:* partition round-trips intact.
   *
   * For dataset formats we also flag `dataset:true`, which the export handler uses to
   * decide it should collect quads from ALL urn:vg:* graphs rather than a single graph.
   */
  function normalizeExportFormat(format?: string) {
    const raw = typeof format === "string" ? format.toLowerCase().trim() : "";
    if (raw === "application/ld+json" || raw === "ld+json" || raw === "jsonld" || raw === "json-ld") {
      return { writerFormat: "application/ld+json", mediaType: "application/ld+json", dropGraph: true, dataset: false };
    }
    if (raw === "application/rdf+xml" || raw === "rdfxml" || raw === "rdf+xml" || raw === "rdf-xml") {
      return { writerFormat: "application/rdf+xml", mediaType: "application/rdf+xml", dropGraph: true, dataset: false };
    }
    if (raw === "application/n-quads" || raw === "nquads" || raw === "n-quads") {
      return { writerFormat: "application/n-quads", mediaType: "application/n-quads", dropGraph: false, dataset: true };
    }
    if (raw === "application/trig" || raw === "trig") {
      return { writerFormat: "application/trig", mediaType: "application/trig", dropGraph: false, dataset: true };
    }
    return { writerFormat: "text/turtle", mediaType: "text/turtle", dropGraph: true, dataset: false };
  }

  /**
   * The complete set of named graphs that make up a VocabGraph "dataset". Dataset-faithful
   * exports (N-Quads / TriG) collect quads from every one of these so the five-graph
   * partition round-trips. Order is deterministic for stable output.
   */
  const VG_DATASET_GRAPHS = [
    "urn:vg:data",
    "urn:vg:inferred",
    "urn:vg:shapes",
    "urn:vg:ontologies",
    "urn:vg:workflows",
  ] as const;



  async function handleCommand(msg: RDFWorkerCommand) {
    try {
      const payload = (msg as { payload?: unknown }).payload;
      let result: unknown;
      switch (msg.command) {
        case "ping":
          result = "pong";
          break;
        case "clear":
          resetSharedStore();
          workerNamespaces = {};
          workerBlacklistPrefixes = new Set(["owl", "rdf", "rdfs", "xml", "xsd"]);
          workerBlacklistUris = [
            "http://www.w3.org/2002/07/owl",
            "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
            "http://www.w3.org/2000/01/rdf-schema#",
            "http://www.w3.org/XML/1998/namespace",
            "http://www.w3.org/2001/XMLSchema#",
          ];
          emitChange({ reason: "clear" });
          emitSubjects([]);
          result = true;
          break;
        case "getGraphCounts":
          result = collectGraphCountsFromStore(getSharedStore());
          break;
        case "getOntologyStats":
          result = collectOntologyStats(getSharedStore());
          break;
        case "getNamespaces":
          result = { ...workerNamespaces };
          break;
        case "setNamespaces":
          if (payload && typeof payload === "object" && payload.namespaces && typeof payload.namespaces === "object") {
            const normalized = ensureDefaultNamespaceMap(payload.namespaces as Record<string, string>);
            if (payload.replace === true) {
              workerNamespaces = { ...normalized };
            } else {
              workerNamespaces = ensureDefaultNamespaceMap({ ...workerNamespaces, ...normalized });
            }
          }
          result = { ...workerNamespaces };
          break;
        case "getBlacklist":
          result = {
            prefixes: Array.from(workerBlacklistPrefixes),
            uris: workerBlacklistUris.slice(),
          };
          break;
        case "setBlacklist":
          if (payload && typeof payload === "object") {
            if (Array.isArray(payload.prefixes)) {
              workerBlacklistPrefixes = new Set(payload.prefixes.map((p: any) => String(p)));
            }
            if (Array.isArray(payload.uris)) {
              workerBlacklistUris = payload.uris.map((u: any) => String(u));
            }
          }
          result = {
            prefixes: Array.from(workerBlacklistPrefixes),
            uris: workerBlacklistUris.slice(),
          };
          break;
        case "setDebug":
          workerDebugEnabled = !!(payload && typeof payload === "object" && (payload as { enabled?: unknown }).enabled);
          result = { enabled: workerDebugEnabled };
          break;
        case "syncLoad": {

          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : "urn:vg:data";
          const graphTerm = createGraphTerm(graphName, DataFactory);
          const existing = store.getQuads(null, null, null, graphTerm) || [];
          const touchedSubjects = new Set<string>();
          let removed = 0;
          let added = 0;

          for (const q of existing) {
            try {
              store.removeQuad(q);
              removed += 1;
              touchedSubjects.add(subjectTermToString(q.subject));
            } catch (err) {
              console.error("[rdfManager.worker] syncLoad remove existing failed", err);
            }
          }

          if (payload && Array.isArray(payload.quads)) {
            const rawQuads = (payload.quads as any[]).map((pq) => deserializeQuad(pq, DataFactory));
            for (const quad of skolemizeQuads(rawQuads, DataFactory)) {
              try {
                store.addQuad(quad);
                added += 1;
                touchedSubjects.add(subjectTermToString(quad.subject));
              } catch (err) {
                console.error("[rdfManager.worker] syncLoad add failed", err);
              }
            }
          }

          if (
            payload &&
            payload.prefixes &&
            typeof payload.prefixes === "object" &&
            (graphName === "urn:vg:data" || graphName === "urn:vg:ontologies")
          ) {
            workerNamespaces = {
              ...workerNamespaces,
              ...(payload.prefixes as Record<string, string>),
            };
          }

          const emission = prepareSubjectEmissionFromSet(
            touchedSubjects,
            store,
            DataFactory,
          );

          emitChange({ reason: "syncLoad", graphName, added, removed });
          if (emission.subjects.length > 0) {
            emitSubjects(
              emission.subjects,
              emission.quadsBySubject,
              emission.snapshot,
              { reason: "syncLoad", graphName },
            );
          }

          result = { graphName, added, removed };
          break;
        }
        case "syncRemoveGraph": {

          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : "urn:vg:data";
          const graphTerm = createGraphTerm(graphName, DataFactory);
          const quads = store.getQuads(null, null, null, graphTerm) || [];
          const touchedSubjects = new Set<string>();
          let removed = 0;
          for (const q of quads) {
            try {
              store.removeQuad(q);
              removed += 1;
              touchedSubjects.add(subjectTermToString(q.subject));
            } catch (err) {
              console.error("[rdfManager.worker] syncRemoveGraph remove failed", err);
            }
          }
          if (removed > 0) {
            const emission = prepareSubjectEmissionFromSet(
              touchedSubjects,
              store,
              DataFactory,
            );
            emitChange({ reason: "removeGraph", graphName, removed });
            if (emission.subjects.length > 0) {
              emitSubjects(
                emission.subjects,
                emission.quadsBySubject,
                emission.snapshot,
                { reason: "removeGraph", graphName },
              );
            }
          }
          if (removed > 0) resetKoncludeReasoner();
          result = { graphName, removed };
          break;
        }
        case "syncRemoveAllQuadsForIri": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const iri =
            payload && typeof payload === "object" && typeof payload.iri === "string"
              ? payload.iri
              : "";
          if (!iri) {
            result = { removedSubjects: 0, removedObjects: 0 };
            break;
          }
          const graphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : "urn:vg:data";
          const graphTerm = createGraphTerm(graphName, DataFactory);
          const subjTerm = /^_:/i.test(String(iri))
            ? DataFactory.blankNode(String(iri).replace(/^_:/, ""))
            : DataFactory.namedNode(String(iri));
          const touchedSubjects = new Set<string>();
          let removedSubjects = 0;
          let removedObjects = 0;

          try {
            const subjectQuads = store.getQuads(subjTerm, null, null, graphTerm) || [];
            for (const q of subjectQuads) {
              try {
                store.removeQuad(q);
                removedSubjects += 1;
                touchedSubjects.add(subjectTermToString(q.subject));
              } catch (err) {
                console.error("[rdfManager.worker] syncRemoveAllQuadsForIri subject removal failed", err);
              }
            }
          } catch (err) {
            console.error("[rdfManager.worker] syncRemoveAllQuadsForIri subject scan failed", err);
          }

          try {
            const objectTerm = DataFactory.namedNode(String(iri));
            const objectQuads = store.getQuads(null, null, objectTerm, graphTerm) || [];
            for (const q of objectQuads) {
              try {
                store.removeQuad(q);
                removedObjects += 1;
                touchedSubjects.add(subjectTermToString(q.subject));
              } catch (err) {
                console.error("[rdfManager.worker] syncRemoveAllQuadsForIri object removal failed", err);
              }
            }
          } catch (err) {
            console.error("[rdfManager.worker] syncRemoveAllQuadsForIri object scan failed", err);
          }

          if (removedSubjects > 0 || removedObjects > 0) {
            const emission = prepareSubjectEmissionFromSet(
              touchedSubjects,
              store,
              DataFactory,
            );
            emitChange({
              reason: "removeAllQuadsForIri",
              iri,
              graphName,
              removedSubjects,
              removedObjects,
            });
            if (emission.subjects.length > 0) {
              emitSubjects(
                emission.subjects,
                emission.quadsBySubject,
                emission.snapshot,
                { reason: "removeAllQuadsForIri", graphName },
              );
            }
          }

          result = { removedSubjects, removedObjects };
          break;
        }
        case "importSerialized": {

          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          if (!payload || typeof payload !== "object" || typeof (payload as any).content !== "string") {
            result = { added: 0, prefixes: {}, graphName: "urn:vg:data", quads: [] };
            break;
          }
          const store = getSharedStore();
          const {
            content,
            graphName: requestedGraph,
            contentType,
            filename,
            baseIri,
            ontologyUrl,
          } = payload as ImportSerializedPayload;
          const graphName =
            typeof requestedGraph === "string" && requestedGraph.length > 0
              ? requestedGraph
              : "urn:vg:data";
          const targetGraph =
            graphName === "default"
              ? DataFactory.defaultGraph()
              : DataFactory.namedNode(String(graphName));

          let parserImpl = resolveRdfParser(rdfParsePkg);
          if (!parserImpl) {
            try {
              const dyn = await import("rdf-parse").catch(() => null);
              parserImpl = resolveRdfParser(dyn);
            } catch (_) {
              /* ignore */
            }
          }
          if (!parserImpl) throw new Error("rdf-parse-unavailable");

          const readable = createReadableFromString(content);
          if (!readable) throw new Error("importSerialized.readable-unavailable");

          const prefixes: Record<string, string> = {};
          const touchedSubjects = new Set<string>();
          const addedSerialized: WorkerQuad[] = [];
          let addedCount = 0;

          // Buffer raw parsed quads, then skolemize as a batch after the stream
          // ends — this ensures content-hash consistency across the whole parse.
          const parsedBuffer: Quad[] = [];

          await new Promise<void>((resolve, reject) => {
            const opts: Record<string, unknown> = {};
            if (contentType) opts.contentType = contentType;
            if (filename) opts.path = filename;
            if (baseIri) opts.baseIRI = baseIri;
            const quadStream = parserImpl.parse(readable, opts);

            quadStream.on("data", (incoming: Quad) => {
              try {
                const graphTerm =
                  (payload as any).forceGraph ||
                  !incoming.graph || !incoming.graph.termType || incoming.graph.termType === "DefaultGraph"
                    ? targetGraph
                    : incoming.graph;
                parsedBuffer.push(DataFactory.quad(
                  incoming.subject,
                  incoming.predicate,
                  incoming.object,
                  graphTerm,
                ));
              } catch (err) {
                debugLog("[rdfManager.worker] importSerialized.data failed", err);
              }
            });

            quadStream.on("prefix", (pfx: string, iri: any) => {
              const value =
                iri && typeof iri.value === "string"
                  ? iri.value
                  : typeof iri === "string"
                    ? iri
                    : undefined;
              if (typeof value === "string" && value.trim()) {
                prefixes[pfx] = value.trim();
              }
            });

            quadStream.on("error", (err: any) => {
              quadStream.removeAllListeners();
              reject(err);
            });

            quadStream.on("end", () => {
              quadStream.removeAllListeners();
              resolve();
            });
          });

          // Skolemize + insert in CHUNKS rather than buffering a second fully
          // materialised copy and then probing the store once per quad.
          //
          // Two perf wins vs. the previous implementation:
          //  1. No per-quad existence pre-check (the old store.countQuads /
          //     store.getQuads probe was O(1) amortised but allocated and ran
          //     for EVERY quad). N3 Store.addQuad already dedupes and returns a
          //     boolean telling us whether the store actually changed — so we
          //     count newly-added quads exactly without any pre-probe.
          //  2. Progress is emitted after each chunk so the client sees liveness
          //     instead of one silent freeze until the whole file is loaded.
          //
          // skolemizeQuads hashes each blank-node label independently, so
          // skolemizing per-chunk yields identical urn:vg:bnode:* IRIs as
          // skolemizing the whole batch — chunking is safe for content hashing.
          const IMPORT_CHUNK_SIZE = 5000;
          const total = parsedBuffer.length;
          let processed = 0;
          for (let start = 0; start < total; start += IMPORT_CHUNK_SIZE) {
            const slice = parsedBuffer.slice(start, start + IMPORT_CHUNK_SIZE);
            for (const normalized of skolemizeQuads(slice, DataFactory)) {
              try {
                const changed = store.addQuad(normalized);
                // N3 returns true only when the quad was not already present.
                // Use the same truthiness the counter wrapper uses so addedCount
                // and the incremental graph counter never diverge.
                if (changed) {
                  addedCount += 1;
                  touchedSubjects.add(subjectTermToString(normalized.subject));
                  addedSerialized.push(serializeQuad(normalized));
                }
              } catch (err) {
                debugLog("[rdfManager.worker] importSerialized.data failed", err);
              }
            }
            processed += slice.length;
            // Release the slice's source references eagerly to keep peak memory
            // closer to a single materialisation rather than buffer + store copy.
            for (let i = start; i < start + slice.length && i < total; i++) {
              (parsedBuffer as any)[i] = undefined;
            }
            emitImportProgress(msg.id, processed, graphName, total);
          }

          if (
            Object.keys(prefixes).length > 0 &&
            (graphName === "urn:vg:data" || graphName === "urn:vg:ontologies")
          ) {
            workerNamespaces = { ...workerNamespaces, ...prefixes };
          }

          if (ontologyUrl && touchedSubjects.size > 0) {
            const ontUrlNode = DataFactory.namedNode(ontologyUrl);
            const loadedFromNode = DataFactory.namedNode(VG_LOADED_FROM);
            const ontGraphTerm = DataFactory.namedNode("urn:vg:ontologies");
            for (const subj of touchedSubjects) {
              try {
                const subjNode = DataFactory.namedNode(subj);
                store.addQuad(DataFactory.quad(subjNode, loadedFromNode, ontUrlNode, ontGraphTerm));
              } catch (_) { /* ignore */ }
            }
          }

          if (addedCount > 0) {
            emitChange({ reason: "importSerialized", graphName, added: addedCount });
            const emission = prepareSubjectEmissionFromSet(
              touchedSubjects,
              store,
              DataFactory,
            );
            if (emission.subjects.length > 0) {
              emitSubjects(
                emission.subjects,
                emission.quadsBySubject,
                emission.snapshot,
                { reason: "importSerialized", graphName },
              );
            }
          }

          result = {
            graphName,
            added: addedCount,
            prefixes,
            quads: addedSerialized,
          };
          break;
        }
        case "syncRemoveBatchSubjectsFromGraph": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const batchGraphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : "urn:vg:ontologies";
          const batchIris: string[] =
            payload && typeof payload === "object" && Array.isArray(payload.subjects)
              ? payload.subjects.map(String).filter(Boolean)
              : [];
          const batchGraphTerm = createGraphTerm(batchGraphName, DataFactory);
          const batchTouched = new Set<string>();
          let batchRemoved = 0;
          for (const iri of batchIris) {
            try {
              const subjTerm = DataFactory.namedNode(iri);
              const subjectQuads = store.getQuads(subjTerm, null, null, batchGraphTerm) || [];
              for (const q of subjectQuads) {
                store.removeQuad(q);
                batchRemoved += 1;
                batchTouched.add(subjectTermToString(q.subject));
              }
            } catch (err) {
              console.error("[rdfManager.worker] syncRemoveBatchSubjectsFromGraph failed for", iri, err);
            }
          }
          if (batchRemoved > 0) {
            const emission = prepareSubjectEmissionFromSet(batchTouched, store, DataFactory);
            emitChange({ reason: "removeSubjectsFromGraph", graphName: batchGraphName, removed: batchRemoved });
            emitSubjects(emission.subjects, emission.quadsBySubject, emission.snapshot, { reason: "removeSubjectsFromGraph", graphName: batchGraphName, removedSubjects: Array.from(batchTouched) });
          }
          result = { graphName: batchGraphName, removed: batchRemoved };
          break;
        }
        case "unloadOntologySubjects": {

          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const unloadUrl =
            payload && typeof payload === "object" && typeof payload.ontologyUrl === "string"
              ? payload.ontologyUrl
              : "";
          if (!unloadUrl) { result = { removed: 0, removedSubjects: [] }; break; }

          const ontGraphTerm = DataFactory.namedNode("urn:vg:ontologies");
          const loadedFromNode = DataFactory.namedNode(VG_LOADED_FROM);
          const ontUrlNode = DataFactory.namedNode(unloadUrl);

          // Find all subjects annotated with this ontology URL
          const annotatedSubjects: string[] = [];
          try {
            const annQuads = store.getQuads(null, loadedFromNode, ontUrlNode, ontGraphTerm) || [];
            for (const q of annQuads) {
              const s = subjectTermToString(q.subject);
              if (s) annotatedSubjects.push(s);
            }
          } catch (_) { /* ignore */ }

          const removedSubjects: string[] = [];
          const touchedForEmit = new Set<string>();

          for (const subj of annotatedSubjects) {
            try {
              const subjNode = DataFactory.namedNode(subj);
              // Remove this ontology's loadedFrom annotation
              store.removeQuad(DataFactory.quad(subjNode, loadedFromNode, ontUrlNode, ontGraphTerm));
              // Check if any other loadedFrom annotation remains
              const remaining = store.getQuads(subjNode, loadedFromNode, null, ontGraphTerm) || [];
              if (remaining.length === 0) {
                // No other ontology claims this subject — remove all its quads from ontologies graph
                const subjQuads = store.getQuads(subjNode, null, null, ontGraphTerm) || [];
                for (const q of subjQuads) {
                  store.removeQuad(q);
                }
                removedSubjects.push(subj);
              }
              touchedForEmit.add(subj);
            } catch (err) {
              console.error("[rdfManager.worker] unloadOntologySubjects failed for", subj, err);
            }
          }

          if (touchedForEmit.size > 0) {
            const emission = prepareSubjectEmissionFromSet(touchedForEmit, store, DataFactory);
            emitChange({ reason: "unloadOntologySubjects", ontologyUrl: unloadUrl, removed: removedSubjects.length });
            emitSubjects(emission.subjects, emission.quadsBySubject, emission.snapshot, { reason: "unloadOntologySubjects", ontologyUrl: unloadUrl, removedSubjects });
          }
          if (removedSubjects.length > 0) resetKoncludeReasoner();
          result = { removed: removedSubjects.length, removedSubjects };
          break;
        }
        case "exportGraph": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof (payload as any).graphName === "string"
              ? (payload as ExportGraphPayload).graphName || "urn:vg:data"
              : "urn:vg:data";
          const formatInfo = normalizeExportFormat(
            payload && typeof payload === "object" ? (payload as ExportGraphPayload).format : undefined,
          );

          const OWL_SAME_AS = "http://www.w3.org/2002/07/owl#sameAs";

          // ----------------------------------------------------------------------------
          // Quad collection. Two strategies:
          //
          //  (A) DATASET-FAITHFUL (N-Quads / TriG, formatInfo.dataset === true):
          //      Collect quads from EVERY urn:vg:* graph and keep their graph terms intact
          //      so the five-graph partition (data / inferred / shapes / ontologies /
          //      workflows) round-trips. No data-grounded filtering or graph-flattening is
          //      applied — a dataset export is a faithful snapshot of the store.
          //
          //  (B) SINGLE-GRAPH (Turtle / JSON-LD / RDF-XML, the historical behaviour):
          //      Collect quads from the requested graph PLUS urn:vg:inferred, apply
          //      "data-grounded" filtering to the inferred quads (only keep inferred triples
          //      whose subject is a NamedNode present in the data graph — this strips
          //      OWL-vocabulary self-inferences, literal-as-subject noise, and reflexive
          //      owl:sameAs trivia), then flatten everything into the default graph below.
          // ----------------------------------------------------------------------------
          let mergedQuads: Quad[];

          if (formatInfo.dataset) {
            // (A) Faithful dataset export across all urn:vg:* graphs.
            const seenKeys = new Set<string>();
            mergedQuads = [];
            for (const g of VG_DATASET_GRAPHS) {
              const gTerm = DataFactory.namedNode(g);
              const rawGraphQuads: Quad[] = store.getQuads(null, null, null, gTerm) || [];
              // Skolemise blank nodes consistently with the single-graph path so output is
              // stable and re-parseable; they are de-skolemised back to bnodes below.
              for (const q of skolemizeQuads(rawGraphQuads, DataFactory)) {
                const k = quadKeyFromTerms(q);
                if (!seenKeys.has(k)) { seenKeys.add(k); mergedQuads.push(q); }
              }
            }
          } else {
            // (B) Single-graph export: requested graph + data-grounded inferred.
            const graphTerm = createGraphTerm(graphName, DataFactory);
            const inferredTerm = DataFactory.namedNode("urn:vg:inferred");
            const primaryQuads: Quad[] = store.getQuads(null, null, null, graphTerm) || [];

            // Build the set of data-graph subjects for inferred-triple filtering
            const dataSubjects = new Set<string>();
            for (const q of primaryQuads) {
              if (q.subject.termType === "NamedNode") dataSubjects.add(q.subject.value);
            }

            const rawInferred: Quad[] =
              graphName !== "urn:vg:inferred"
                ? (store.getQuads(null, null, null, inferredTerm) || [])
                : [];

            const skolemizedInferred = skolemizeQuads(rawInferred, DataFactory);
            const filteredInferred = skolemizedInferred.filter((q) => {
              // Must be grounded in data (subject is a NamedNode known from the data graph)
              if (q.subject.termType !== "NamedNode") return false;
              if (!dataSubjects.has(q.subject.value)) return false;
              // Drop reflexive owl:sameAs (X sameAs X)
              if (
                q.predicate.value === OWL_SAME_AS &&
                q.object.termType === "NamedNode" &&
                q.object.value === q.subject.value
              ) return false;
              return true;
            });

            // Merge, deduplicating by quad key
            const seenKeys = new Set<string>();
            mergedQuads = [];
            for (const q of [...primaryQuads, ...filteredInferred]) {
              const k = quadKeyFromTerms(q);
              if (!seenKeys.has(k)) { seenKeys.add(k); mergedQuads.push(q); }
            }
          }

          const deskolemized = mergedQuads.map((q) => {
            const subj = q.subject.termType === "NamedNode" && q.subject.value.startsWith("urn:vg:bnode:")
              ? DataFactory.blankNode(q.subject.value.slice("urn:vg:bnode:".length))
              : q.subject;
            const obj = q.object.termType === "NamedNode" && q.object.value.startsWith("urn:vg:bnode:")
              ? DataFactory.blankNode(q.object.value.slice("urn:vg:bnode:".length))
              : q.object;
            if (subj === q.subject && obj === q.object) return q;
            return DataFactory.quad(subj, q.predicate, obj, q.graph);
          });

          const toWrite: Quad[] = formatInfo.dropGraph
            ? deskolemized.map((q) =>
                DataFactory.quad(q.subject, q.predicate, q.object, DataFactory.defaultGraph()),
              )
            : deskolemized;

          // Filter prefixes to only those whose namespace URI appears in the quads.
          const usedNamespaces = new Set<string>();
          for (const q of toWrite) {
            for (const term of [q.subject, q.predicate, q.object]) {
              if (term.termType === "NamedNode") {
                const v = term.value;
                const cut = Math.max(v.lastIndexOf("#"), v.lastIndexOf("/"));
                if (cut > 0) usedNamespaces.add(v.slice(0, cut + 1));
              }
            }
          }
          const usedPrefixes: Record<string, string> = {};
          for (const [prefix, ns] of Object.entries(workerNamespaces)) {
            if (usedNamespaces.has(ns)) usedPrefixes[prefix] = ns;
          }

          let output: string;

          if (formatInfo.mediaType === "application/ld+json") {
            // N3.js Writer does not support JSON-LD — build expanded JSON-LD manually.
            const nodeMap = new Map<string, Record<string, any[]>>();
            for (const q of toWrite) {
              const subjId =
                q.subject.termType === "BlankNode"
                  ? `_:${q.subject.value}`
                  : q.subject.value;
              if (!nodeMap.has(subjId)) nodeMap.set(subjId, { "@id": subjId } as any);
              const node = nodeMap.get(subjId)!;
              const predId = q.predicate.value;
              if (!node[predId]) node[predId] = [];
              if (q.object.termType === "NamedNode") {
                node[predId].push({ "@id": q.object.value });
              } else if (q.object.termType === "BlankNode") {
                node[predId].push({ "@id": `_:${q.object.value}` });
              } else {
                const lit: Record<string, string> = { "@value": q.object.value };
                if ((q.object as any).language) {
                  lit["@language"] = (q.object as any).language;
                } else if (
                  (q.object as any).datatype &&
                  (q.object as any).datatype.value !== "http://www.w3.org/2001/XMLSchema#string"
                ) {
                  lit["@type"] = (q.object as any).datatype.value;
                }
                node[predId].push(lit);
              }
            }
            output = JSON.stringify(Array.from(nodeMap.values()), null, 2);
          } else if (formatInfo.mediaType === "application/rdf+xml") {
            // N3.js Writer does not support RDF/XML — build it manually.
            const xe = (s: string) =>
              s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
            // Build prefix → namespace map; auto-assign short prefixes for unknown namespaces.
            const ns: Record<string, string> = { rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#", ...usedPrefixes };
            const nsReverse = new Map<string, string>(Object.entries(ns).map(([p, u]) => [u, p]));
            let autoIdx = 0;
            const qname = (iri: string): string => {
              const hash = iri.lastIndexOf("#");
              const slash = iri.lastIndexOf("/");
              const cut = Math.max(hash, slash);
              if (cut <= 0) return null as any;
              const nsUri = iri.slice(0, cut + 1);
              const local = iri.slice(cut + 1);
              if (!local || /\s/.test(local)) return null as any;
              if (!nsReverse.has(nsUri)) {
                const p = `ns${autoIdx++}`;
                nsReverse.set(nsUri, p);
                ns[p] = nsUri;
              }
              return `${nsReverse.get(nsUri)}:${local}`;
            };
            // Pre-scan predicates to populate ns map before building header
            for (const q of toWrite) qname(q.predicate.value);
            const nsAttrs = Object.entries(ns)
              .map(([p, u]) => `xmlns:${p}="${xe(u)}"`)
              .join("\n      ");
            const lines: string[] = [
              '<?xml version="1.0" encoding="UTF-8"?>',
              `<rdf:RDF ${nsAttrs}>`,
            ];
            // Group by subject
            const subjectMap = new Map<string, Quad[]>();
            for (const q of toWrite) {
              const k = q.subject.termType === "BlankNode" ? `_:${q.subject.value}` : q.subject.value;
              if (!subjectMap.has(k)) subjectMap.set(k, []);
              subjectMap.get(k)!.push(q);
            }
            for (const [subjId, qs] of subjectMap) {
              const aboutAttr = subjId.startsWith("_:")
                ? `rdf:nodeID="${xe(subjId.slice(2))}"`
                : `rdf:about="${xe(subjId)}"`;
              lines.push(`  <rdf:Description ${aboutAttr}>`);
              for (const q of qs) {
                const pq = qname(q.predicate.value);
                const tag = pq || `rdf:predicate rdf:resource="${xe(q.predicate.value)}"`;
                if (q.object.termType === "NamedNode") {
                  lines.push(`    <${tag} rdf:resource="${xe(q.object.value)}"/>`);
                } else if (q.object.termType === "BlankNode") {
                  lines.push(`    <${tag} rdf:nodeID="${xe(q.object.value)}"/>`);
                } else {
                  let attrs = "";
                  if ((q.object as any).language) {
                    attrs = ` xml:lang="${xe((q.object as any).language)}"`;
                  } else if (
                    (q.object as any).datatype &&
                    (q.object as any).datatype.value !== "http://www.w3.org/2001/XMLSchema#string"
                  ) {
                    attrs = ` rdf:datatype="${xe((q.object as any).datatype.value)}"`;
                  }
                  lines.push(`    <${tag}${attrs}>${xe(q.object.value)}</${tag}>`);
                }
              }
              lines.push(`  </rdf:Description>`);
            }
            lines.push("</rdf:RDF>");
            output = lines.join("\n");
          } else {
            // Turtle (and any other N3.js-supported format)
            const writer = new (N3 as any).Writer({
              prefixes: { ...usedPrefixes },
              format: formatInfo.writerFormat,
            });
            writer.addQuads(toWrite);
            output = await new Promise((resolve, reject) => {
              writer.end((err: unknown, res: unknown) => {
                if (err) { reject(err); return; }
                resolve(typeof res === "string" ? res : String(res ?? ""));
              });
            });
          }

          result = {
            graphName,
            format: formatInfo.mediaType,
            content: output,
          };
          break;
        }
        case "removeQuadsByNamespace": {

          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof (payload as any).graphName === "string"
              ? (payload as RemoveQuadsByNamespacePayload).graphName
              : "urn:vg:data";
          const namespaces =
            payload && typeof payload === "object" && Array.isArray((payload as any).namespaceUris)
              ? (payload as RemoveQuadsByNamespacePayload).namespaceUris
                  .map((ns) => (typeof ns === "string" ? ns.trim() : ""))
                  .filter((ns) => ns.length > 0)
              : [];
          if (namespaces.length === 0) {
            result = { graphName, removed: 0 };
            break;
          }
          const graphTerm = createGraphTerm(graphName, DataFactory);
          const quads = store.getQuads(null, null, null, graphTerm) || [];
          const touchedSubjects = new Set<string>();
          let removed = 0;
          for (const q of quads) {
            try {
              const subj = q.subject && (q.subject as any).value ? String((q.subject as any).value) : "";
              const pred = q.predicate && (q.predicate as any).value ? String((q.predicate as any).value) : "";
              const obj =
                q.object && (q.object as any).value ? String((q.object as any).value) : String(q.object || "");
              const matches = namespaces.some(
                (ns) => (subj && subj.startsWith(ns)) || (pred && pred.startsWith(ns)) || (obj && obj.startsWith(ns)),
              );
              if (!matches) continue;
              store.removeQuad(q);
              removed += 1;
              touchedSubjects.add(subjectTermToString(q.subject));
            } catch (err) {
              debugLog("[rdfManager.worker] removeQuadsByNamespace remove failed", err);
            }
          }
          if (removed > 0) {
            emitChange({ reason: "removeQuadsByNamespace", graphName, removed });
            const emission = prepareSubjectEmissionFromSet(touchedSubjects, store, DataFactory);
            if (emission.subjects.length > 0) {
              emitSubjects(
                emission.subjects,
                emission.quadsBySubject,
                emission.snapshot,
              );
            }
          }
          result = { graphName, removed };
          break;
        }
        case "purgeNamespace": {

          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const prefixOrUri =
            payload && typeof payload === "object" && typeof (payload as any).prefixOrUri === "string"
              ? (payload as PurgeNamespacePayload).prefixOrUri
              : "";
          if (!prefixOrUri) {
            result = { removed: 0, namespaceUri: null, prefixRemoved: null };
            break;
          }
          let namespaceUri: string | null = null;
          let prefixRemoved: string | null = null;
          if (workerNamespaces[prefixOrUri]) {
            namespaceUri = workerNamespaces[prefixOrUri];
            prefixRemoved = prefixOrUri;
          } else {
            for (const [pfx, uri] of Object.entries(workerNamespaces)) {
              if (uri === prefixOrUri) {
                namespaceUri = uri;
                prefixRemoved = pfx;
                break;
              }
            }
            if (!namespaceUri && /^https?:\/\//i.test(prefixOrUri)) {
              namespaceUri = prefixOrUri;
            }
          }
          if (!namespaceUri) {
            result = { removed: 0, namespaceUri: null, prefixRemoved: null };
            break;
          }
          if (prefixRemoved) {
            const next = { ...workerNamespaces };
            delete next[prefixRemoved];
            workerNamespaces = next;
          }
          const quads = store.getQuads(null, null, null, null) || [];
          let removed = 0;
          const touchedSubjects = new Set<string>();
          for (const q of quads) {
            try {
              const subj = q.subject && (q.subject as any).value ? String((q.subject as any).value) : "";
              const pred = q.predicate && (q.predicate as any).value ? String((q.predicate as any).value) : "";
              const obj =
                q.object && (q.object as any).value ? String((q.object as any).value) : String(q.object || "");
              if (
                (subj && subj.startsWith(namespaceUri)) ||
                (pred && pred.startsWith(namespaceUri)) ||
                (obj && obj.startsWith(namespaceUri))
              ) {
                store.removeQuad(q);
                removed += 1;
                touchedSubjects.add(subjectTermToString(q.subject));
              }
            } catch (err) {
              debugLog("[rdfManager.worker] purgeNamespace removal failed", err);
            }
          }
          if (removed > 0) {
            emitChange({ reason: "purgeNamespace", namespaceUri, removed });
            const emission = prepareSubjectEmissionFromSet(touchedSubjects, store, DataFactory);
            if (emission.subjects.length > 0) {
              emitSubjects(
                emission.subjects,
                emission.quadsBySubject,
                emission.snapshot,
              );
            }
          }
          result = { removed, namespaceUri, prefixRemoved };
          break;
        }
        case "renameNamespaceUri": {

          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const { oldUri, newUri, allNamespaceUris } =
            payload as RenameNamespaceUriPayload;

          if (!oldUri || !newUri || oldUri === newUri) {
            result = { renamed: 0 };
            break;
          }

          // Sort all namespace URIs longest-first for prefix disambiguation.
          const baseUris = allNamespaceUris.includes(oldUri)
            ? allNamespaceUris
            : [...allNamespaceUris, oldUri];
          const sortedUris = [...baseUris].sort((a, b) => b.length - a.length);

          // Find the longest namespace URI that an IRI starts with.
          // Returns undefined if none match.
          const longestMatch = (iri: string): string | undefined =>
            sortedUris.find((u) => iri.startsWith(u));

          // Replace the oldUri prefix with newUri in a named-node IRI, if it matches.
          // Returns null if this IRI should not be renamed.
          const maybeRename = (iri: string): string | null => {
            if (!iri.startsWith(oldUri)) return null;
            if (longestMatch(iri) !== oldUri) return null;
            return newUri + iri.slice(oldUri.length);
          };

          const quads = store.getQuads(null, null, null, null) || [];
          let renamed = 0;
          const touchedSubjects = new Set<string>();

          for (const q of quads) {
            try {
              const sVal = q.subject?.value ?? "";
              const pVal = q.predicate?.value ?? "";
              const oIsNamed = q.object?.termType === "NamedNode";
              const oVal = oIsNamed ? (q.object?.value ?? "") : "";
              const gVal = q.graph?.termType === "NamedNode" ? (q.graph?.value ?? "") : "";

              const newS = maybeRename(sVal);
              const newP = maybeRename(pVal);
              const newO = oIsNamed ? maybeRename(oVal) : null;
              const newG = gVal ? maybeRename(gVal) : null;

              if (newS === null && newP === null && newO === null && newG === null) continue;

              store.removeQuad(q);

              const subj = DataFactory.namedNode(newS ?? sVal);
              const pred = DataFactory.namedNode(newP ?? pVal);
              let obj = q.object;
              if (newO !== null) obj = DataFactory.namedNode(newO);
              const graph =
                newG !== null
                  ? DataFactory.namedNode(newG)
                  : q.graph?.termType === "NamedNode"
                  ? DataFactory.namedNode(gVal)
                  : DataFactory.defaultGraph();

              store.addQuad(DataFactory.quad(subj, pred, obj, graph));
              renamed += 1;
              touchedSubjects.add(newS !== null ? newS : subjectTermToString(subj));
            } catch (err) {
              debugLog("[rdfManager.worker] renameNamespaceUri failed for quad", err);
            }
          }

          if (renamed > 0) {
            emitChange({ reason: "renameNamespaceUri", oldUri, newUri, renamed });
            const emission = prepareSubjectEmissionFromSet(touchedSubjects, store, DataFactory);
            if (emission.subjects.length > 0) {
              emitSubjects(
                emission.subjects,
                emission.quadsBySubject,
                emission.snapshot,
              );
            }
          }

          result = { renamed };
          break;
        }
        case "emitAllSubjects": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : "urn:vg:data";
          const graphTerm = createGraphTerm(graphName, DataFactory);
          // Collect the set of subjects from the requested graph, then re-fetch
          // complete quad sets (all graphs) for each subject so that inferred quads
          // from urn:vg:inferred are included in the emitted snapshot.
          const graphQuads = store.getQuads(null, null, null, graphTerm) || [];
          const subjectSet = new Set<string>();
          for (const q of graphQuads) {
            try {
              const s = subjectTermToString(q.subject);
              if (s && !isBlacklistedIri(s)) subjectSet.add(s);
            } catch (_) { /* ignore */ }
          }
          const emission = prepareSubjectEmissionFromSet(subjectSet, store, DataFactory);
          // Diagnostic: log total quad count across all subjects so we can verify inferred quads are included
          const totalQuadCount = Object.values(emission.quadsBySubject).reduce((s, qs) => s + qs.length, 0);
          debugLog("[emitAllSubjects] subjects:", emission.subjects.length, "totalQuads:", totalQuadCount, "graph:", graphName);
          if (emission.subjects.length > 0) {
            emitSubjects(
              emission.subjects,
              emission.quadsBySubject,
              emission.snapshot,
              { reason: "emitAllSubjects", graphName },
            );
          }
          result = { subjects: emission.subjects.length };
          break;
        }
        case "triggerSubjects": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const subjectInput =
            payload && typeof payload === "object" && Array.isArray((payload as any).subjects)
              ? (payload as any).subjects
              : [];
          const subjectSet = new Set<string>();
          for (const item of subjectInput) {
            const value = typeof item === "string" ? item.trim() : String(item ?? "").trim();
            if (!value) continue;
            subjectSet.add(value);
          }
          const emission = prepareSubjectEmissionFromSet(
            subjectSet,
            store,
            DataFactory,
          );
          if (emission.subjects.length > 0) {
            emitSubjects(
              emission.subjects,
              emission.quadsBySubject,
              emission.snapshot,
              { reason: "triggerSubjects" },
            );
          }
          result = { subjects: emission.subjects.length };
          break;
        }
        case "fetchQuadsPage": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : "urn:vg:data";
          const graphTerm = createGraphTerm(graphName, DataFactory);
          const all = store.getQuads(null, null, null, graphTerm) || [];
          const filter =
            payload && typeof payload === "object" && payload.filter ? payload.filter : undefined;
          const filtered = !filter
            ? all
            : all.filter((q: any) => {
                try {
                  if (filter.subject && subjectTermToString(q.subject) !== String(filter.subject)) {
                    return false;
                  }
                  if (filter.predicate) {
                    const pred = termToString(q.predicate);
                    if (pred !== String(filter.predicate)) return false;
                  }
                  if (filter.object) {
                    const obj = termToString(q.object);
                    if (obj !== String(filter.object)) return false;
                  }
                  return true;
                } catch (_) {
                  return false;
                }
              });
          const total = filtered.length;
          const offset =
            payload && typeof (payload as any).offset === "number"
              ? Math.max(0, (payload as any).offset)
              : 0;
          const limit =
            payload && typeof (payload as any).limit === "number"
              ? Math.max(0, (payload as any).limit)
              : 0;
          const slice =
            limit > 0 ? filtered.slice(offset, offset + limit) : filtered.slice(offset);
          const shouldSerialize = !payload || (payload as any).serialize !== false;
          const items = shouldSerialize
            ? slice.map((q: any) => ({
                subject: subjectTermToString(q.subject),
                predicate: termToString(q.predicate),
                object: termToString(q.object),
                graph: q.graph && q.graph.value ? String(q.graph.value) : "default",
              }))
            : slice.map((q: Quad) => serializeQuad(q));
          result = { total, offset, limit, items, serialize: shouldSerialize };
          break;
        }
        case "getQuads": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : null;
          const graphTerm = graphName === null ? null : createGraphTerm(graphName, DataFactory);
          const subjectTerm =
            payload && typeof payload === "object" && typeof payload.subject === "string"
              ? payload.subject.startsWith("_:")
                ? DataFactory.blankNode(payload.subject.slice(2))
                : DataFactory.namedNode(String(payload.subject))
              : null;
          const predicateTerm =
            payload && typeof payload === "object" && typeof payload.predicate === "string"
              ? DataFactory.namedNode(String(payload.predicate))
              : null;
          const objectTerm =
            payload && typeof payload === "object" && payload.object
              ? deserializeTerm(payload.object, DataFactory)
              : null;
          const quads = store.getQuads(subjectTerm, predicateTerm, objectTerm, graphTerm) || [];
          result = quads.map((q: Quad) => serializeQuad(q));
          break;
        }
        case "syncBatch": {
          const { DataFactory } = resolveN3();
          if (!DataFactory) throw new Error("n3-datafactory-unavailable");
          const store = getSharedStore();
          const graphName =
            payload && typeof payload === "object" && typeof payload.graphName === "string"
              ? payload.graphName
              : "urn:vg:data";
          const graphTerm = createGraphTerm(graphName, DataFactory);
          const touchedSubjects = new Set<string>();
          // C2: accumulate the FULL signature (subject + predicate + non-literal
          // object, de-skolemized) of every
          // ADDED and REMOVED quad — captured BEFORE removal for retractions. This
          // is Σ_Δ's seed: it MUST carry the changed triple's PREDICATE and OBJECT,
          // not just its subject, so a predicate/object-position edit (e.g.
          // retracting `p rdfs:subPropertyOf q`) pulls p (and q) into the module and
          // the splice can purge the now-stale inferred triples those axioms backed.
          const changedSignatureSet = new Set<string>();
          const SB_BNODE_PREFIX = "urn:vg:bnode:";
          const sigTermOf = (term: any): string | null => {
            if (!term) return null;
            if (term.termType === "Literal") return null;
            if (term.termType === "BlankNode") return `_:${term.value}`;
            const v = String(term.value ?? "");
            if (!v) return null;
            return v.startsWith(SB_BNODE_PREFIX) ? `_:${v.slice(SB_BNODE_PREFIX.length)}` : v;
          };
          const recordChangedSignature = (q: any): void => {
            const s = sigTermOf(q?.subject);
            if (s) changedSignatureSet.add(s);
            const p = sigTermOf(q?.predicate);
            if (p) changedSignatureSet.add(p);
            const o = sigTermOf(q?.object);
            if (o) changedSignatureSet.add(o);
          };
          let added = 0;
          let removed = 0;

          if (payload && Array.isArray(payload.removes)) {
            for (const rem of payload.removes) {
              if (!rem) continue;
              try {
                const subject = deserializeTerm(rem.subject, DataFactory);
                const predicate = deserializeTerm(rem.predicate, DataFactory);
                const graphOverride =
                  rem.graph && rem.graph.termType !== "DefaultGraph"
                    ? deserializeTerm(rem.graph, DataFactory)
                    : graphTerm;
                if (!rem.object) {
                  const matches = store.getQuads(subject, predicate, null, graphOverride) || [];
                  for (const q of matches) {
                    recordChangedSignature(q); // capture BEFORE removal
                    store.removeQuad(q);
                    removed += 1;
                    touchedSubjects.add(subjectTermToString(q.subject));
                  }
                  continue;
                }

                const object = deserializeTerm(rem.object, DataFactory);
                const matches = store.getQuads(subject, predicate, object, graphOverride) || [];
                let handled = false;
                for (const q of matches) {
                  recordChangedSignature(q); // capture BEFORE removal
                  store.removeQuad(q);
                  removed += 1;
                  handled = true;
                  touchedSubjects.add(subjectTermToString(q.subject));
                }
                // BUG D (alignment with verifyRepairMatch): the lexical fallback
                // removes a literal by lexical value when the exact-term match found
                // nothing. It MUST only fire for a PLAIN literal removal (no datatype,
                // no language). When the removal specifies a datatype/language, apply
                // must match EXACTLY (s,p,o,datatype,language,graph) — the exact match
                // above already enforces that — and must NOT fall back to removing a
                // same-lexical literal of a DIFFERENT datatype/language. Otherwise
                // apply would remove a triple verifyRepairMatch (which checks
                // datatype/language exactly) would NOT consider the repaired axiom,
                // and the two would disagree.
                const remObjHasType =
                  !!(rem.object as { datatype?: unknown }).datatype ||
                  !!(rem.object as { language?: unknown }).language;
                if (!handled && rem.object.termType === "Literal" && !remObjHasType) {
                  const lexical = rem.object.value || "";
                  const allForPredicate = store.getQuads(subject, predicate, null, graphOverride) || [];
                  for (const q of allForPredicate) {
                    const objTerm = q.object;
                    if (
                      objTerm &&
                      objTerm.termType === "Literal" &&
                      String(objTerm.value || "") === lexical
                    ) {
                      recordChangedSignature(q); // capture BEFORE removal
                      store.removeQuad(q);
                      removed += 1;
                      touchedSubjects.add(subjectTermToString(q.subject));
                    }
                  }
                }
              } catch (err) {
                console.error("[rdfManager.worker] syncBatch remove failed", err);
              }
            }
          }

          if (payload && Array.isArray(payload.adds)) {
            const rawAdds = (payload.adds as any[]).filter(Boolean).map((a) => deserializeQuad(a, DataFactory));
            for (const quad of skolemizeQuads(rawAdds, DataFactory)) {
              try {
                // BUG C: only count an add when store.addQuad actually changed the
                // store (it returns false for a no-op re-add of an existing quad),
                // mirroring importSerialized's `if (changed)` guard. N3's addQuad
                // returns a boolean; guard for stores that return void by treating
                // a non-false result as "changed". This makes applyBatch's `added`
                // reflect the ACTUAL store delta so revert reporting is honest.
                const changed = store.addQuad(quad);
                if (changed !== false) {
                  added += 1;
                  touchedSubjects.add(subjectTermToString(quad.subject));
                  recordChangedSignature(quad);
                }
              } catch (err) {
                console.error("[rdfManager.worker] syncBatch add failed", err);
              }
            }
          }

          const shouldEmitSubjects =
            !payload?.options || payload.options.suppressSubjects !== true;
          let emissionSubjects: string[] = [];
          let emissionQuads: SubjectQuadMap = {};
          let emissionSnapshot: WorkerReconcileSubjectSnapshotPayload[] = [];
          if (shouldEmitSubjects) {
            const emission = prepareSubjectEmissionFromSet(
              touchedSubjects,
              store,
              DataFactory,
            );
            emissionSubjects = emission.subjects;
            emissionQuads = emission.quadsBySubject;
            emissionSnapshot = emission.snapshot;
          }

          if (added > 0 || removed > 0) {
            // C2: forward the full changed signature in the emission meta.
            const changedSignature = Array.from(changedSignatureSet);
            emitChange({ reason: "syncBatch", graphName, added, removed, changedSignature });
            if (shouldEmitSubjects && emissionSubjects.length > 0) {
              emitSubjects(emissionSubjects, emissionQuads, emissionSnapshot, {
                reason: "syncBatch",
                graphName,
                changedSignature,
              });
            }
          }

          result = { added, removed };
          break;
        }
        case "sparqlQuery": {
          const payload = msg.payload as RDFWorkerCommandPayloads["sparqlQuery"];
          const sparql = payload?.sparql;
          if (!sparql) throw new Error("sparqlQuery: sparql string required");
          const limit = typeof payload?.limit === "number" ? payload.limit : 200;

          if (!_cachedQueryEngine) {
            _cachedQueryEngine = new QueryEngine();
          }
          const store = getSharedStore();
          // unionDefaultGraph: true makes plain BGP patterns match quads from all named graphs
          // (urn:vg:data, urn:vg:inferred, etc.) not just the empty default graph.
          const queryResult = await _cachedQueryEngine.query(sparql, { sources: [store], unionDefaultGraph: true });

          if (queryResult.resultType === "bindings") {
            const bindingsStream = await queryResult.execute();
            const rows: Array<Record<string, string>> = [];
            for await (const binding of bindingsStream) {
              if (rows.length >= limit) break;
              const row: Record<string, string> = {};
              for (const [variable, term] of binding) {
                row[variable.value] = term.value;
              }
              rows.push(row);
            }
            result = { type: "select", rows };
          } else if (queryResult.resultType === "quads") {
            const quadStream = await queryResult.execute();
            const triples: Array<{ s: string; p: string; o: string }> = [];
            for await (const quad of quadStream) {
              if (triples.length >= limit) break;
              triples.push({ s: quad.subject.value, p: quad.predicate.value, o: quad.object.value });
            }
            result = { type: "construct", triples };
          } else if (queryResult.resultType === "void") {
            await queryResult.execute();
            // Trigger the normal subject-emission pipeline so the canvas refreshes
            const { DataFactory } = resolveN3();
            if (DataFactory) {
              const graphTerm = createGraphTerm("urn:vg:data", DataFactory);
              const graphQuads = store.getQuads(null, null, null, graphTerm) || [];
              const subjectSet = new Set<string>();
              for (const q of graphQuads) {
                try { const s = subjectTermToString(q.subject); if (s && !isBlacklistedIri(s)) subjectSet.add(s); } catch (_) { /* ignore */ }
              }
              const emission = prepareSubjectEmissionFromSet(subjectSet, store, DataFactory);
              if (emission.subjects.length > 0) {
                emitSubjects(emission.subjects, emission.quadsBySubject, emission.snapshot, { reason: "sparqlUpdate" });
              }
            }
            result = { type: "update" };
          } else if (queryResult.resultType === "boolean") {
            const answer = await queryResult.execute();
            result = { type: "ask", boolean: answer };
          } else {
            throw new Error(`Unsupported result type: ${(queryResult as { resultType?: string }).resultType ?? "unknown"}`);
          }
          break;
        }
        case "runReasoning": {
          const payload = msg.payload as RDFWorkerCommandPayloads["runReasoning"];
          const reasoningId = payload.reasoningId;
          const reasoningRequest: RDFWorkerRunReasoningMessage = {
            type: "runReasoning",
            id: reasoningId,
            quads: payload.quads,
            rulesets: payload.rulesets,
            baseUrl: payload.baseUrl,
            emitSubjects: payload.emitSubjects,
            reasonerBackend: payload.reasonerBackend,
            shaclEnabled: payload.shaclEnabled,
          };
          const outcome = await handleRunReasoning(reasoningRequest, {
            mutateSharedStore: true,
            includeAdded: false,
            emitSubjects: payload.emitSubjects !== false,
            emitChange: true,
            emitResultEvent: true,
          });
          result = {
            id: outcome.id,
            durationMs: outcome.durationMs,
            startedAt: outcome.startedAt,
            warnings: outcome.warnings,
            errors: outcome.errors,
            inferences: outcome.inferences,
            usedReasoner: outcome.usedReasoner,
            addedCount: outcome.addedCount,
            workerDurationMs: outcome.workerDurationMs,
            ruleQuadCount: outcome.ruleQuadCount,
            isConsistent: outcome.isConsistent,
          };
          break;
        }
        case "runShaclValidation": {
          result = await runShaclValidation();
          break;
        }
        case "explainInconsistency": {
          const p = (msg.payload ?? {}) as { maxJustifications?: number };
          const n = typeof p.maxJustifications === "number" ? p.maxJustifications : 1;
          const konclude = getKoncludeReasoner();
          await konclude.ready;
          const store = getSharedStore();

          // C1 + H2: preserve the SOURCE GRAPH and the full OBJECT TERM
          // (termType + datatype/language) so the apply path can target the exact
          // graph the axiom physically lives in (urn:vg:data OR urn:vg:ontologies)
          // and reconstruct a precise typed/lang literal instead of a lossy
          // lexical-only fallback. All new fields are OPTIONAL — subject/predicate/
          // object keep their existing string shape for back-compat.
          const serializeQuadAxiom = (q: N3.Quad) => {
            const obj = q.object as Quad["object"];
            const out: {
              subject: string;
              predicate: string;
              object: string;
              objectTermType?: string;
              objectDatatype?: string;
              objectLanguage?: string;
              graph?: string;
            } = {
              subject: q.subject.value,
              predicate: q.predicate.value,
              object: obj.value,
              objectTermType: obj.termType,
            };
            if (obj.termType === "Literal") {
              const lit = obj as { datatype?: { value?: string }; language?: string };
              if (lit.datatype?.value) out.objectDatatype = lit.datatype.value;
              if (lit.language) out.objectLanguage = lit.language;
            }
            const g = q.graph?.termType === "DefaultGraph" ? "" : q.graph?.value;
            if (g) out.graph = g;
            return out;
          };

          // Prefer the LACONIC path (Horridge et al. ISWC 2008): it returns the
          // SAME MIPS plus the superfluous-part-free laconic axiom PARTS and their
          // source mapping. The test node adapter may not implement it — fall back
          // to the plain MIPS-only result (laconicJustifications stays absent).
          if (typeof konclude.explainInconsistencyLaconic === "function") {
            const enriched = await konclude.explainInconsistencyLaconic(store, n);
            result = {
              count: enriched.length,
              mips: enriched.map((e) => e.justification.map(serializeQuadAxiom)),
              // NON-BREAKING: the laconic field is aligned by index with `mips`.
              // Each entry has `parts` (the precise culprit axiom parts, each with
              // its source axiom principal triple), `sharpened` (laconic dropped a
              // superfluous part), and `skipped` (the cost cap suppressed laconic).
              laconicJustifications: enriched.map((e) => e.laconic),
            };
          } else {
            const mips = await konclude.explainInconsistency(store, n);
            result = {
              count: mips.length,
              mips: mips.map((m) => m.map(serializeQuadAxiom)),
            };
          }
          break;
        }
        case "getUnsatisfiableClasses": {
          const konclude = getKoncludeReasoner();
          await konclude.ready;
          // The wrapper filters base graphs (excludes inferred/shapes/workflows) internally.
          const unsatisfiable = await konclude.getUnsatisfiableClasses(getSharedStore());
          result = { unsatisfiable: Array.isArray(unsatisfiable) ? unsatisfiable : [] };
          break;
        }
        case "verifyRepair": {
          // R1 — symbolic verification of a repair candidate.
          //
          // Build a working store COPY of the shared store with the candidate's
          // axioms removed, then run the SAME Konclude consistency oracle that
          // explainInconsistency() / checkConsistency() use (the wrapper filters
          // base graphs and de-skolemises internally). The shared urn:vg:data
          // store is never mutated.
          //
          // verifyRepair accepts an ARRAY of removals: callers verify a single
          // axiom (per-repair check) OR the full hitting set at once (the union
          // is the valid fix even when no single removal restores consistency).
          const p = (msg.payload ?? { removals: [] }) as {
            removals: {
              subject: string;
              predicate: string;
              object: string;
              objectTermType?: string;
              objectDatatype?: string;
              objectLanguage?: string;
              graph?: string;
            }[];
          };
          const { StoreCls } = resolveN3();
          if (!StoreCls) throw new Error("n3-store-unavailable");
          const konclude = getKoncludeReasoner();
          await konclude.ready;
          const source = getSharedStore();
          const removals = p.removals ?? [];

          // BUG B: VERIFY must exclude the IDENTICAL triple that APPLY removes.
          // When a removal carries object-term metadata (objectTermType +
          // datatype/language) and/or a source graph, those must MATCH the quad —
          // so a same-lexical "42" string in a different graph or with a different
          // datatype is NOT treated as the repaired axiom (which would yield a
          // false `verifiedConsistent`). Absent metadata ⇒ legacy bare-lexical,
          // all-graph match (back-compat). The predicate is the SHARED, pure
          // `quadMatchesRemoval` so the apply and verify notions of "same triple"
          // cannot drift apart.

          // Track which requested removals actually matched a quad so the caller
          // can distinguish "removed but still inconsistent" from "nothing
          // matched" (L2). A removal that matches zero quads (e.g. a serialization
          // or graph mismatch) would otherwise leave the store unchanged and
          // report verifiedConsistent:false as if the repair had failed.
          const matchedIdx = new Set<number>();
          const copy = new (StoreCls as any)();
          const allQuads: Quad[] = source.getQuads(null, null, null, null);
          for (const q of allQuads) {
            let drop = false;
            for (let i = 0; i < removals.length; i++) {
              if (quadMatchesRemoval(q as unknown as MatchQuad, removals[i])) {
                matchedIdx.add(i);
                drop = true;
                break;
              }
            }
            if (drop) continue;
            copy.addQuad(q);
          }
          const removedCount = allQuads.length - copy.size;
          const verifiedConsistent = await konclude.checkConsistency(copy);
          result = {
            verifiedConsistent,
            removedCount,
            requestedCount: removals.length,
            matchedCount: matchedIdx.size,
          };
          break;
        }
        case "searchTerms": {
          // Grounding / retrieval — pure store query (no reasoner). Find existing
          // ontology terms (classes / properties / individuals) by label or IRI
          // local-name across ALL graphs (esp. urn:vg:ontologies) so agents
          // REUSE an existing IRI instead of minting a new ex: one.
          const p = (msg.payload ?? { query: "" }) as RDFWorkerCommandPayloads["searchTerms"];
          result = searchTermsInStore(getSharedStore(), p);
          break;
        }
        case "explainEntailment": {
          // Entailment explanation channel — "why is A subClassOf B?" /
          // "why is x of type C?". Reduces entailment to (in)consistency using
          // the EXISTING Konclude consistency oracle (Path B), then strips the
          // injected probe axioms from each justification. READ-ONLY: operates on
          // the shared store's base quads; never mutates urn:vg:data.
          const p = (msg.payload ?? {
            subjectIri: "",
            predicateIri: "",
            objectIri: "",
          }) as RDFWorkerCommandPayloads["explainEntailment"];
          const n = typeof p.maxJustifications === "number" ? p.maxJustifications : 1;
          const konclude = getKoncludeReasoner();
          await konclude.ready;
          // Objects are treated as class-like (IRI) unless explicitly flagged as
          // a literal. The MCP/public API only passes IRIs, so default true.
          const objectIsClassLike = p.objectIsLiteral !== true;
          const { isEntailed, justifications, ontologyInconsistent, vacuous, reason } =
            await konclude.explainEntailment(
              getSharedStore(),
              p.subjectIri,
              p.predicateIri,
              p.objectIri,
              objectIsClassLike,
              n,
            );
          result = {
            isEntailed,
            justifications: justifications.map((j) =>
              j.map((q) => ({ subject: q.subject.value, predicate: q.predicate.value, object: q.object.value })),
            ),
            // C1/C2: surface the soundness flags so the agent sees a clear message
            // instead of a bogus "entailed". Only include when set.
            ...(ontologyInconsistent ? { ontologyInconsistent: true } : {}),
            ...(vacuous ? { vacuous: true } : {}),
            ...(reason ? { reason } : {}),
          };
          break;
        }
        default:
          throw new Error(`Unsupported command: ${String(msg.command)}`);
      }
      post({ type: "response", id: msg.id, ok: true, result });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorStack = err instanceof Error && err.stack ? err.stack : undefined;
      post({
        type: "response",
        id: msg.id,
        ok: false,
        error: errorMessage,
        stack: errorStack,
      });
    }
  }

  // mipsToReasoningError is imported from ./reasoningDiagnostics — it now attaches
  // the full justification axiom set (see reasoningDiagnostics.ts) rather than
  // truncating to three axioms.

  async function handleRunReasoning(
    msg: RDFWorkerRunReasoningMessage,
    options: RunReasoningOptions = {},
  ): Promise<ReasoningResultMessage> {
    const startedAt = Date.now();
    reasoningStage({ type: "reasoningStage", id: msg.id, stage: "start" });

    const { DataFactory, StoreCls, ParserCls, ReasonerCls } = resolveN3();
    if (!DataFactory || !StoreCls) {
      reasoningStage({ type: "reasoningStage", id: msg.id, stage: "n3-unavailable" });
      throw new Error("n3-api-unavailable");
    }

    const mutateSharedStore =
      options.mutateSharedStore ?? !(Array.isArray(msg.quads) && msg.quads.length > 0);
    const includeAdded = options.includeAdded ?? !mutateSharedStore;
    const emitSubjectsFlag = options.emitSubjects ?? mutateSharedStore;
    const emitChangeFlag = options.emitChange ?? mutateSharedStore;
    const emitResultEvent = options.emitResultEvent ?? true;

    // ── KONCLUDE PATH ──────────────────────────────────────────────────────────
    if ((msg.reasonerBackend ?? 'konclude') !== 'n3') {
      let kSharedStoreRef: any | null = null;
      let kWorkingStore: any;

      if (mutateSharedStore) {
        kSharedStoreRef = getSharedStore();
        kWorkingStore = new (StoreCls as any)();
        try {
          // Working-copy pre-filter (Finding 1): keep inferred AND shapes here;
          // reason() does the FINAL reasoning-base filtering on this copy. Single
          // source of truth — EXCLUDED_FROM_REASONING_WORKING_COPY.
          const allQuads: Quad[] = kSharedStoreRef.getQuads(null, null, null, null);
          const filteredQuads = allQuads.filter((q: Quad) => {
            const g = q.graph.termType === "DefaultGraph" ? "" : q.graph.value;
            return !EXCLUDED_FROM_REASONING_WORKING_COPY.has(g);
          });
          kWorkingStore.addQuads(filteredQuads);
        } catch (_) {
          kWorkingStore = kSharedStoreRef;
        }
      } else {
        kWorkingStore = new (StoreCls as any)();
        for (const pq of msg.quads || []) {
          try { kWorkingStore.addQuad(deserializeQuad(pq, DataFactory)); } catch (_) { /* ignore */ }
        }
      }

      let kUsedReasoner = false;
      let kReasonerDuration = 0;
      let kIsConsistent: boolean | null = null;
      let kMipsErrors: ReasoningError[] = [];
      const kInferredGraphTerm = DataFactory.namedNode("urn:vg:inferred");

      try {
        const sabAvailable = typeof SharedArrayBuffer !== 'undefined';
        debugLog("[VG_REASONING_WORKER] Konclude init", { sabAvailable, crossOriginIsolated: (globalThis as any).crossOriginIsolated });
        if (!sabAvailable) {
          throw new Error("SharedArrayBuffer unavailable — page needs HTTPS + COOP/COEP headers (or localhost). Use reasonerBackend='n3' as fallback.");
        }
        const konclude = getKoncludeReasoner();
        await konclude.ready;
        const kQuadCount = kWorkingStore.size ?? kWorkingStore.countQuads?.(null,null,null,null) ?? 0;
        debugLog("[VG_REASONING_WORKER] Konclude input quads:", kQuadCount);
        reasoningStage({ type: "reasoningStage", id: msg.id, stage: "consistency-check", meta: { backend: 'konclude' } });
        const kStart = Date.now();
        // Phase 1: consistency check — populates cache in the Konclude instance so
        // the subsequent explainInconsistency() call skips the redundant WASM round-trip.
        const kConsistencyResult = await konclude.checkConsistency(kWorkingStore);
        if (kConsistencyResult) {
          reasoningStage({ type: "reasoningStage", id: msg.id, stage: "reasoner-start", meta: { backend: 'konclude' } });
          await konclude.reason(kWorkingStore);
          kReasonerDuration = Date.now() - kStart;
          kUsedReasoner = true;
          kIsConsistent = true;
          reasoningStage({ type: "reasoningStage", id: msg.id, stage: "reasoner-complete", meta: { durationMs: kReasonerDuration, backend: 'konclude' } });
        } else {
          // Phase 2: ontology is inconsistent — emit stage so the UI can show the badge
          // before the MIPS explanation run. explainInconsistency() hits the consistency
          // cache set above, so no second WASM consistency call is made.
          reasoningStage({ type: "reasoningStage", id: msg.id, stage: "inconsistent-detected", meta: { durationMs: Date.now() - kStart } });
          const DEFAULT_UI_MAX_JUSTIFICATIONS = 3;
          const mips = await konclude.explainInconsistency(kWorkingStore, DEFAULT_UI_MAX_JUSTIFICATIONS);
          kReasonerDuration = Date.now() - kStart;
          kIsConsistent = false;
          kMipsErrors = mips.map(mipsToReasoningError);
          debugLog("[VG_REASONING_WORKER] Konclude inconsistency detected, MIPS count:", mips.length);
          reasoningStage({ type: "reasoningStage", id: msg.id, stage: "inconsistent", meta: { durationMs: kReasonerDuration, mipsCount: mips.length } });
        }
      } catch (err) {
        const errMsg = String((err as Error).message || err);
        console.error("[VG_REASONING_WORKER] Konclude failed:", errMsg);
        reasoningStage({ type: "reasoningStage", id: msg.id, stage: "reasoner-error", meta: { error: errMsg } });
        // F1: surface the failure as a result error instead of swallowing it, so the
        // report no longer shows a silent "0 errors" success when reasoning actually failed.
        kMipsErrors.push({
          rule: "reasoner-error",
          severity: "error",
          message: `OWL DL reasoning could not complete: ${errMsg}`,
        });
      }

      const kAddedQuads: Quad[] = [];
      const kTouchedSubjects = new Set<string>();
      const kAdditionSeen = new Set<string>();

      // Clear stale inferred triples before writing fresh ones so a full run
      // reflects retractions. Gate on kIsConsistent !== null: only when the
      // reasoner produced a verdict. A reasoner FAILURE (null) leaves inferred
      // untouched.
      let kRemovedStale = 0;
      const kRemovedSubjects = new Set<string>();
      if (mutateSharedStore && kSharedStoreRef && kIsConsistent !== null) {
        const staleInferred = kSharedStoreRef.getQuads(null, null, null, kInferredGraphTerm) || [];
        if (staleInferred.length > 0) {
          for (const q of staleInferred) {
            const sv = subjectTermToString(q.subject, q.subject.value);
            if (sv) kRemovedSubjects.add(sv);
          }
          kSharedStoreRef.removeQuads(staleInferred);
          kRemovedStale = staleInferred.length;
        }
      }

      if (kUsedReasoner) {
        const rawInferred: Quad[] = kWorkingStore.getQuads(null, null, null, kInferredGraphTerm);
        debugLog("[VG_REASONING_WORKER] Konclude rawInferred from store:", rawInferred.length);
        for (const inferredQuad of skolemizeQuads(rawInferred, DataFactory)) {
          const key = quadKeyFromTerms(inferredQuad);
          if (!kAdditionSeen.has(key)) {
            kAdditionSeen.add(key);
            kAddedQuads.push(inferredQuad);
            if (mutateSharedStore && kSharedStoreRef) {
              try { kSharedStoreRef.addQuad(inferredQuad); } catch (_) { /* dup */ }
            }
            const sv = subjectTermToString(inferredQuad.subject, inferredQuad.subject.value);
            if (sv) kTouchedSubjects.add(sv);
          }
        }
      }

      if (mutateSharedStore && kSharedStoreRef) {
        if (emitChangeFlag && (kAddedQuads.length > 0 || kRemovedStale > 0)) {
          emitChange({ reason: "reasoning", addedCount: kAddedQuads.length, removedCount: kRemovedStale });
        }
        // Emit for added subjects AND for subjects whose stale inferred we cleared
        // (BUG B) so the canvas drops retracted inferred edges even when no new
        // inferred triple replaces them.
        if (emitSubjectsFlag && (kAddedQuads.length > 0 || kRemovedSubjects.size > 0)) {
          const emitSet = new Set(kTouchedSubjects);
          for (const s of kRemovedSubjects) emitSet.add(s);
          const emission = prepareSubjectEmissionFromSet(emitSet, kSharedStoreRef, DataFactory);
          if (emission.subjects.length > 0) {
            emitSubjects(emission.subjects, emission.quadsBySubject, emission.snapshot, { reason: "reasoning", graphName: "urn:vg:inferred" });
          }
        }
      }

      const { warnings: kWarnings, errors: kShaclErrors } = collectShaclResults(kAddedQuads);

      // Run SHACL validation against urn:vg:shapes if shapes are loaded
      if (msg.shaclEnabled !== false) {
        try {
          const shaclResult = await runShaclValidation();
          if (!shaclResult.conforms) {
            for (const v of shaclResult.violations) {
              const entry = shaclViolationToEntry(v);
              if (entry.severity === "error") {
                kShaclErrors.push(entry);
              } else {
                kWarnings.push(entry);
              }
            }
          }
        } catch (shaclErr) {
          // F4: do not silently swallow — a failed validation must not look like "data conforms".
          const m = String((shaclErr as Error)?.message ?? shaclErr);
          debugLog("[VG_REASONING_WORKER] SHACL validation failed", m);
          kWarnings.push({
            rule: "shacl:engine-error",
            severity: "warning",
            message: `SHACL validation could not run (data conformance unknown): ${m}`,
          });
        }
      }

      const kErrors: ReasoningError[] = [...kMipsErrors, ...kShaclErrors];
      if (!kUsedReasoner && kIsConsistent === null) {
        kWarnings.push({
          message: "Konclude OWL DL reasoner unavailable. Requires SharedArrayBuffer (HTTPS or localhost). Switch to reasonerBackend='n3' for rule-based reasoning, or access via HTTPS.",
          rule: "konclude-unavailable",
          severity: "warning",
        } as any);
      }
      const RDF_TYPE_K = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
      const kInferences: ReasoningInference[] = kAddedQuads
        .map((quad) => {
          const subject = subjectTermToString(quad.subject, quad.subject.value);
          const predicate = termToString(quad.predicate);
          const object = termToString(quad.object);
          if (!subject || !predicate) return null;
          return predicate === RDF_TYPE_K
            ? { type: "class", subject, predicate, object, confidence: 0.95 } as ReasoningInference
            : { type: "relationship", subject, predicate, object, confidence: 0.9 } as ReasoningInference;
        })
        .filter((e): e is ReasoningInference => Boolean(e));

      const kDurationMs = Date.now() - startedAt;
      const kResult: ReasoningResultMessage = {
        type: "reasoningResult",
        id: msg.id,
        durationMs: kDurationMs,
        startedAt,
        added: includeAdded ? kAddedQuads.map((quad) => serializeQuad(quad)) : undefined,
        addedCount: kAddedQuads.length,
        warnings: kWarnings,
        errors: kErrors,
        inferences: kInferences,
        usedReasoner: kUsedReasoner,
        workerDurationMs: kReasonerDuration,
        ruleQuadCount: 0,
        isConsistent: kIsConsistent,
      };

      if (emitResultEvent) {
        const eventPayload: ReasoningResult = {
          id: msg.id,
          timestamp: startedAt,
          status: "completed",
          duration: kDurationMs,
          errors: kErrors,
          warnings: kWarnings,
          inferences: kInferences,
          meta: {
            usedReasoner: kUsedReasoner,
            workerDurationMs: kReasonerDuration,
            totalDurationMs: kDurationMs,
            addedCount: kResult.addedCount,
            ruleQuadCount: 0,
          },
        };
        post({ type: "event", event: "reasoningResult", payload: eventPayload });
      }

      reasoningStage({ type: "reasoningStage", id: msg.id, stage: "complete", meta: {
        durationMs: kDurationMs, addedCount: kResult.addedCount, usedReasoner: kUsedReasoner,
        inferenceCount: kInferences.length, ruleQuadCount: 0,
      }});

      return kResult;
    }
    // ── END KONCLUDE PATH — N3 path follows ────────────────────────────────────

    let sharedStoreRef: any | null = null;
    let workingStore: any;

    if (mutateSharedStore) {
      sharedStoreRef = getSharedStore();
      // Always reason on a working copy so the N3 Reasoner's internal _addToIndex
      // calls (which write string-keyed entries) never pollute the main store.
      // After reasoning we persist only the captured inferred quads to urn:vg:inferred
      // in the main store via the proper addQuad API.
      workingStore = new (StoreCls as any)();
      try {
        // Only copy data + ontology graphs — never feed previous inferred quads
        // back into the reasoner, which would accumulate spurious inferences on
        // repeated runs (N3 OWL-RL re-applies rules to already-inferred triples).
        const sourceGraphs = [
          DataFactory.namedNode("urn:vg:data"),
          DataFactory.namedNode("urn:vg:ontologies"),
        ];
        for (const g of sourceGraphs) {
          workingStore.addQuads(sharedStoreRef.getQuads(null, null, null, g));
        }
      } catch (_) {
        // Fallback: reason directly on the main store (old, broken behaviour).
        // This path should never be hit with a standard N3.js store.
        workingStore = sharedStoreRef;
      }
    } else {
      workingStore = new (StoreCls as any)();
      for (const pq of msg.quads || []) {
        try {
          const quad = deserializeQuad(pq, DataFactory);
          workingStore.addQuad(quad);
        } catch (err) {
          reasoningStage({
            type: "reasoningStage",
            id: msg.id,
            stage: "ingest-quad-failed",
            meta: { error: String((err as Error).message || err) },
          });
        }
      }
    }

    try {
      const countsBefore = collectGraphCountsFromStore(workingStore);
      debugLog("[VG_REASONING_WORKER] quad counts before reasoning", {
        id: msg.id,
        total: Object.values(countsBefore).reduce((acc, v) => acc + v, 0),
        counts: countsBefore,
      });
    } catch (err) {
      debugLog("[VG_REASONING_WORKER] unable to log pre-reasoning counts", err);
    }

    const parser = ParserCls ? new (ParserCls as any)({ format: "text/n3" }) : null;
    const parsedRules: any[] = [];
    const ruleDiagnostics: { name: string; quadCount: number }[] = [];

    const rulesets = Array.isArray(msg.rulesets)
      ? msg.rulesets.filter((r) => typeof r === "string" && r)
      : [];
    const baseUrlRaw =
      typeof msg.baseUrl === "string" && msg.baseUrl.length > 0 ? msg.baseUrl : "/";
    const normalizedBase = (() => {
      try {
        let v = baseUrlRaw;
        if (!v.startsWith("/")) v = `/${v}`;
        if (!v.endsWith("/")) v = `${v}/`;
        return v;
      } catch (_) {
        return "/";
      }
    })();
    const workerDir = (() => {
      try {
        if (typeof globalThis !== "undefined" && (globalThis as any).location && (globalThis as any).location.href) {
          const dir = new URL("./", (globalThis as any).location.href).pathname;
          return dir.endsWith("/") ? dir : `${dir}/`;
        }
      } catch (_) {
        /* ignore */
      }
      return "";
    })();
    const origin = (() => {
      try {
        return (globalThis as any).location && (globalThis as any).location.origin
          ? String((globalThis as any).location.origin)
          : "";
      } catch (_) {
        return "";
      }
    })();

    const fetchRuleText = async (name: string) => {
      const attemptsSet = new Set<string>();
      attemptsSet.add(`${normalizedBase}reasoning-rules/${name}`);
      attemptsSet.add(`/reasoning-rules/${name}`);
      attemptsSet.add(`${normalizedBase}${name}`);
      attemptsSet.add(name);
      if (workerDir) attemptsSet.add(`${workerDir}reasoning-rules/${name}`);
      if (origin) {
        attemptsSet.add(`${origin}${normalizedBase}reasoning-rules/${name}`);
        attemptsSet.add(`${origin}/reasoning-rules/${name}`);
        if (workerDir) attemptsSet.add(`${origin}${workerDir}reasoning-rules/${name}`);
      }
      const attempts = Array.from(attemptsSet);
      let lastErr: unknown = null;
      for (const url of attempts) {
        try {
          reasoningStage({
            type: "reasoningStage",
            id: msg.id,
            stage: "fetch-ruleset",
            meta: { name },
          });
          const response = await fetch(url, { mode: "cors" });
          if (response.ok) {
            const text = await response.text();
            if (text && text.length > 0) {
              return text;
            }
          }
          lastErr = new Error(`Failed to fetch ruleset ${name} from ${url}`);
        } catch (err) {
          lastErr = err;
        }
      }
      if (lastErr) throw lastErr;
      throw new Error(`Unable to fetch ruleset ${name}`);
    };

    if (parser && rulesets.length > 0) {
      for (const name of rulesets) {
        try {
          const text = await fetchRuleText(String(name));
          if (text && text.trim()) {
            const quads = parser.parse(text);
            if (Array.isArray(quads) && quads.length > 0) {
              parsedRules.push(...quads);
              ruleDiagnostics.push({ name: String(name), quadCount: quads.length });
              reasoningStage({
                type: "reasoningStage",
                id: msg.id,
                stage: "ruleset-parsed",
                meta: { name, quadCount: quads.length },
              });
            }
          }
        } catch (err) {
          reasoningStage({
            type: "reasoningStage",
            id: msg.id,
            stage: "ruleset-parse-error",
            meta: { name, error: String((err as Error).message || err) },
          });
        }
      }
    }

    try {
      const totalRuleQuads = ruleDiagnostics.reduce((acc, item) => acc + item.quadCount, 0);
      debugLog("[VG_REASONING_WORKER] ruleset load summary", {
        id: msg.id,
        requested: rulesets,
        parsedRuleSets: ruleDiagnostics,
        totalRuleQuads,
        parserAvailable: Boolean(parser),
      });
    } catch (_) {
      /* ignore diagnostics errors */
    }

    const inferredGraphTerm = DataFactory.namedNode("urn:vg:inferred");

    let usedReasoner = false;
    let reasonerDuration = 0;
    let captureReasonerInsertions: () => ReasonerInsertion[] = () => [];

    if (ReasonerCls) {
      try {
        const reasoner = new (ReasonerCls as any)(workingStore);
        captureReasonerInsertions = attachReasonerAddInterceptor(reasoner, workingStore);
        const totalRuleQuads = ruleDiagnostics.reduce((acc, item) => acc + item.quadCount, 0);
        reasoningStage({
          type: "reasoningStage",
          id: msg.id,
          stage: "reasoner-start",
          meta: { ruleQuadCount: totalRuleQuads },
        });
        let rulesInput: any = new (StoreCls as any)();
        if (parsedRules.length > 0) {
          try {
            rulesInput = new (StoreCls as any)(parsedRules);
          } catch (_) {
            rulesInput = new (StoreCls as any)();
            for (const quad of parsedRules) {
              try {
                rulesInput.addQuad(quad);
              } catch (_) {
                /* ignore individual rule quad failures */
              }
            }
          }
        }
        const reasonerStart = Date.now();
        const maybePromise = reasoner.reason(rulesInput);
        if (maybePromise && typeof maybePromise.then === "function") {
          await maybePromise;
        }
        usedReasoner = true;
        reasonerDuration = Date.now() - reasonerStart;
        reasoningStage({
          type: "reasoningStage",
          id: msg.id,
          stage: "reasoner-complete",
          meta: { durationMs: reasonerDuration, ruleQuadCount: totalRuleQuads },
        });
        debugLog("[VG_REASONING_WORKER] reasoner run complete", {
          id: msg.id,
          durationMs: reasonerDuration,
          ruleQuadCount: totalRuleQuads,
        });
      } catch (err) {
        reasoningStage({
          type: "reasoningStage",
          id: msg.id,
          stage: "reasoner-error",
          meta: { error: String((err as Error).message || err) },
        });
        usedReasoner = false;
      }
    } else {
      reasoningStage({ type: "reasoningStage", id: msg.id, stage: "reasoner-missing" });
    }

    const capturedInsertions = captureReasonerInsertions();

    debugLog("[VG_REASONING_WORKER] captured insertions summary", {
      id: msg.id,
      capturedCount: capturedInsertions.length,
      usedReasoner,
    });

    if (!usedReasoner) {
      reasoningStage({
        type: "reasoningStage",
        id: msg.id,
        stage: "reasoner-missing",
        meta: { message: "Reasoner unavailable after execution attempt" },
      });

      const durationMs = Date.now() - startedAt;
      const fallbackWarnings: ReasoningWarning[] = [
        {
          message: "Reasoner unavailable; no inferred triples were generated.",
          rule: "reasoner-missing",
          severity: "warning",
        },
      ];

      const fallbackResult: ReasoningResultMessage = {
        type: "reasoningResult",
        id: msg.id,
        durationMs,
        startedAt,
        added: includeAdded ? [] : undefined,
        addedCount: 0,
        warnings: fallbackWarnings,
        errors: [],
        inferences: [],
        usedReasoner: false,
        workerDurationMs: 0,
        ruleQuadCount: ruleDiagnostics.reduce((acc, item) => acc + item.quadCount, 0),
        isConsistent: null,
      };

      if (emitResultEvent) {
        const eventPayload: ReasoningResult = {
          id: msg.id,
          timestamp: startedAt,
          status: "completed",
          duration: durationMs,
          errors: [],
          warnings: fallbackWarnings,
          inferences: [],
          meta: {
            usedReasoner: false,
            workerDurationMs: 0,
            totalDurationMs: durationMs,
            addedCount: 0,
            ruleQuadCount: fallbackResult.ruleQuadCount,
          },
        };
        post({
          type: "event",
          event: "reasoningResult",
          payload: eventPayload,
        });
      }

      reasoningStage({
        type: "reasoningStage",
        id: msg.id,
        stage: "complete",
        meta: {
          durationMs,
          addedCount: 0,
          usedReasoner: false,
          inferenceCount: 0,
          ruleQuadCount: fallbackResult.ruleQuadCount,
        },
      });

      return fallbackResult;
    }

    const touchedSubjects = new Set<string>();
    const addedQuads: Quad[] = [];
    const additionSeen = new Set<string>();

    // capturedInsertions hold raw string values from the N3 Reasoner's internal _add
    // (c.subject.value, c.predicate.value, c.object.value).  Convert them directly to
    // RDF Terms and persist to urn:vg:inferred in the MAIN store.
    // No removal step is needed: the reasoner ran on a working copy so the main store
    // was never touched by string-keyed _addToIndex calls.
    if (capturedInsertions.length > 0) {
      const rawInferred: Quad[] = [];
      for (const insertion of capturedInsertions) {
        const subjectTerm = termFromReasonerValue(DataFactory, insertion.subject);
        const predicateTerm = termFromReasonerValue(DataFactory, insertion.predicate);
        const objectTerm = termFromReasonerValue(DataFactory, insertion.object);
        if (!subjectTerm || !predicateTerm || !objectTerm) continue;
        rawInferred.push(DataFactory.quad(subjectTerm, predicateTerm, objectTerm, inferredGraphTerm));
      }

      for (const inferredQuad of skolemizeQuads(rawInferred, DataFactory)) {
        const additionKey = quadKeyFromTerms(inferredQuad);
        if (!additionSeen.has(additionKey)) {
          additionSeen.add(additionKey);
          addedQuads.push(inferredQuad);

          // Persist to the main store under urn:vg:inferred
          if (mutateSharedStore && sharedStoreRef) {
            try {
              sharedStoreRef.addQuad(inferredQuad);
            } catch (_) {
              /* duplicate or store error — ignore */
            }
          }

          const subjectValue = subjectTermToString(inferredQuad.subject, inferredQuad.subject.value);
          if (subjectValue) touchedSubjects.add(subjectValue);
        }
      }
    }

    const effectiveAdded = addedQuads;

    if (mutateSharedStore && sharedStoreRef) {
      if (emitChangeFlag && effectiveAdded.length > 0) {
        emitChange({ reason: "reasoning", addedCount: effectiveAdded.length });
      }
      if (emitSubjectsFlag && effectiveAdded.length > 0) {
        const emission = prepareSubjectEmissionFromSet(
          touchedSubjects,
          sharedStoreRef,
          DataFactory,
        );
        if (emission.subjects.length > 0) {
          emitSubjects(
            emission.subjects,
            emission.quadsBySubject,
            emission.snapshot,
            { reason: "reasoning", graphName: "urn:vg:inferred" },
          );
        }
      }
    }

    const { warnings, errors } = collectShaclResults(effectiveAdded);

    // Run SHACL validation against urn:vg:shapes if shapes are loaded
    if (msg.shaclEnabled !== false) {
      try {
        const shaclResult = await runShaclValidation();
        if (!shaclResult.conforms) {
          for (const v of shaclResult.violations) {
            const entry = shaclViolationToEntry(v);
            if (entry.severity === "error") {
              errors.push(entry);
            } else {
              warnings.push(entry);
            }
          }
        }
      } catch (shaclErr) {
        // F4: surface rather than swallow — see konclude path above.
        const m = String((shaclErr as Error)?.message ?? shaclErr);
        debugLog("[VG_REASONING_WORKER] SHACL validation failed", m);
        warnings.push({
          rule: "shacl:engine-error",
          severity: "warning",
          message: `SHACL validation could not run (data conformance unknown): ${m}`,
        });
      }
    }

    const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
    const inferences: ReasoningInference[] = effectiveAdded
      .map((quad) => {
        const subject = subjectTermToString(quad.subject, quad.subject.value);
        const predicate = termToString(quad.predicate);
        const object = termToString(quad.object);
        if (!subject || !predicate) return null;
        if (predicate === RDF_TYPE) {
          return {
            type: "class",
            subject,
            predicate,
            object,
            confidence: 0.95,
          } as ReasoningInference;
        }
        return {
          type: "relationship",
          subject,
          predicate,
          object,
          confidence: 0.9,
        } as ReasoningInference;
      })
      .filter((entry): entry is ReasoningInference => Boolean(entry));

    const durationMs = Date.now() - startedAt;

    try {
      const countsAfter = collectGraphCountsFromStore(
        mutateSharedStore && sharedStoreRef ? sharedStoreRef : workingStore,
      );
      debugLog("[VG_REASONING_WORKER] quad counts after reasoning", {
        id: msg.id,
        durationMs,
        total: Object.values(countsAfter).reduce((acc, v) => acc + v, 0),
        counts: countsAfter,
        addedCount: effectiveAdded.length,
        usedReasoner,
        ruleQuadCount: ruleDiagnostics.reduce((acc, item) => acc + item.quadCount, 0),
      });
    } catch (err) {
      debugLog("[VG_REASONING_WORKER] unable to log post-reasoning counts", err);
    }

    const result: ReasoningResultMessage = {
      type: "reasoningResult",
      id: msg.id,
      durationMs,
      startedAt,
      added: includeAdded ? effectiveAdded.map((quad) => serializeQuad(quad)) : undefined,
      addedCount: effectiveAdded.length,
      warnings,
      errors,
      inferences,
      usedReasoner,
      workerDurationMs: reasonerDuration,
      ruleQuadCount: ruleDiagnostics.reduce((acc, item) => acc + item.quadCount, 0),
      isConsistent: null,
    };

    if (emitResultEvent) {
      const eventPayload: ReasoningResult = {
        id: msg.id,
        timestamp: startedAt,
        status: "completed",
        duration: durationMs,
        errors,
        warnings,
        inferences,
        meta: {
          usedReasoner,
          workerDurationMs: reasonerDuration,
          totalDurationMs: durationMs,
          addedCount: result.addedCount,
          ruleQuadCount: result.ruleQuadCount,
        },
      };
      post({
        type: "event",
        event: "reasoningResult",
        payload: eventPayload,
      });
    }

    reasoningStage({
      type: "reasoningStage",
      id: msg.id,
      stage: "complete",
      meta: {
        durationMs,
        addedCount: result.addedCount,
        usedReasoner,
        inferenceCount: usedReasoner ? inferences.length : 0,
        ruleQuadCount: result.ruleQuadCount,
      },
    });

    return result;
  }
  return {
    handleEvent(message: unknown) {
      handleInbound(message);
    },
    terminate() {
      sharedStore = null;
      graphCounts = new Map();
      graphCountsReady = false;
      workerNamespaces = {};
      workerBlacklistPrefixes = new Set(["owl", "rdf", "rdfs", "xml", "xsd"]);
      workerBlacklistUris = [
        "http://www.w3.org/2002/07/owl",
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
        "http://www.w3.org/2000/01/rdf-schema#",
        "http://www.w3.org/XML/1998/namespace",
        "http://www.w3.org/2001/XMLSchema#",
      ];
      workerChangeCounter = 0;
    },
  };
}
