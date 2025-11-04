 
// Deterministic N3 reasoner worker (template based on parseRdf.worker.ts)
// - Uses static imports so bundler includes n3 in the worker chunk.
// - Linear, deterministic flow with clear stage messages so dev/prod behave identically.
// - Fail fast on missing runtime pieces (no silent fallbacks).
// - Preserves existing protocol: main -> worker { type: "run", id, quads, rules } and { type: "cancel", id" }
// - Emits stage messages and final result/error messages.
//
// Messages posted to main:
// - { type: "stage", id, stage, ... }    // debug stages
// - { type: "result", id, afterQuads: SerializedQuad[] }
// - { type: "error", id, message, details? }
// - { type: "cancelled", id }
//
import * as N3 from 'n3';

type SerializedObject = { t: "iri" | "lit" | "bnode", v: string, dt?: string, ln?: string };
type SerializedQuad = { s: string, p: string, o: SerializedObject, g?: string };

declare const self: any;

// Small helper to post stage messages (non-throwing)
function stage(id: string, s: string, data?: Record<string, any>) {
  try { self.postMessage(Object.assign({ type: "stage", id, stage: s }, data || {})); } catch (_) { /* ignore */ }
}

// Minimal helpers for serializing quads for diagnostics
function serializeSample(quads: any[], limit = 10) {
  try {
    return (quads || []).slice(0, limit).map((q: any) => {
      try {
        return {
          s: q.subject && q.subject.value ? String(q.subject.value) : "",
          p: q.predicate && q.predicate.value ? String(q.predicate.value) : "",
          o: q.object && q.object.value ? String(q.object.value) : "",
          g: q.graph && q.graph.value ? String(q.graph.value) : "",
        };
      } catch (_) { return null; }
    }).filter((x: any) => x);
  } catch (_) { return []; }
}

function toSerializedQuad(q: any): SerializedQuad | null {
  try {
    const subj = q.subject && q.subject.value ? String(q.subject.value) : "";
    const pred = q.predicate && q.predicate.value ? String(q.predicate.value) : "";
    const objTerm = (q as any).object;
    let obj: SerializedObject = { t: "lit", v: "" };
    if (objTerm) {
      if (objTerm.termType === "NamedNode") obj = { t: "iri", v: String(objTerm.value) };
      else if (objTerm.termType === "BlankNode") obj = { t: "bnode", v: String(objTerm.value) };
      else if (objTerm.termType === "Literal") {
        const dt = objTerm.datatype && objTerm.datatype.value ? String(objTerm.datatype.value) : undefined;
        const ln = objTerm.language || undefined;
        obj = { t: "lit", v: String(objTerm.value), dt, ln };
      } else {
        obj = { t: "lit", v: String(objTerm.value || "") };
      }
    }
    const g = q.graph && q.graph.value ? String(q.graph.value) : undefined;
    return { s: subj, p: pred, o: obj, g };
  } catch (_) { return null; }
}

// Main runner - linear and deterministic
async function runReasoner(id: string, quads: SerializedQuad[], rulesOrNames: any[] | undefined) {
  stage(id, "start");

  // Resolve N3 primitives from static import
  const DataFactory = (N3 as any).DataFactory || ((N3 as any).default && (N3 as any).default.DataFactory);
  const StoreCls = (N3 as any).Store || ((N3 as any).default && (N3 as any).default.Store);
  const ParserCls = (N3 as any).Parser || ((N3 as any).default && (N3 as any).default.Parser);
  const ReasonerCls = (N3 as any).Reasoner || (N3 as any).N3Reasoner || ((N3 as any).default && ((N3 as any).default.Reasoner || (N3 as any).default.N3Reasoner)) || null;

  if (!DataFactory || !StoreCls || !ParserCls) {
    // Try dynamic import diagnostic if static import shape is unexpected
    try { stage(id, "n3-shape", { keys: Object.keys(N3 || {}) }); } catch (_) { /* ignore */ }
    try {
      const dyn: any = await import('n3').catch(() => null);
      if (dyn) {
        try { stage(id, "n3-dynamic-import", { keys: Object.keys(dyn || {}) }); } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore */ }
    stage(id, "error", { message: "n3-api-unavailable" });
    try { self.postMessage({ type: "error", id, message: "n3-api-unavailable" }); } catch (_) { /* ignore */ }
    return;
  }

  const { namedNode, literal, blankNode, quad } = DataFactory;

  // Build a temporary store from input quads (best-effort per-quad)
  const tempStore = new StoreCls();
  let addedCount = 0;
  for (const sq of quads || []) {
    try {
      const s = /^_:/.test(String(sq.s || "")) ? blankNode(String(sq.s).replace(/^_:/, "")) : namedNode(String(sq.s));
      const p = namedNode(String(sq.p));
      let o: any = null;
      if (sq.o && sq.o.t === "iri") o = namedNode(String(sq.o.v));
      else if (sq.o && sq.o.t === "bnode") o = blankNode(String(sq.o.v));
      else if (sq.o && sq.o.t === "lit") {
        if (sq.o.dt) o = literal(String(sq.o.v), namedNode(String(sq.o.dt)));
        else if (sq.o.ln) o = literal(String(sq.o.v), String(sq.o.ln));
        else o = literal(String(sq.o.v));
      } else {
        o = literal(String((sq.o && sq.o.v) || ""));
      }
      const g = sq.g ? namedNode(String(sq.g)) : undefined;
      tempStore.addQuad(quad(s as any, p as any, o as any, g as any));
      addedCount++;
    } catch (e) {
      // ignore bad quad
    }
  }
  stage(id, "store-created", { quadCount: addedCount });

  // Prepare parsedRules array (N3 quads)
  const parsedRules: any[] = [];

  // Helper to parse text rules via ParserCls in deterministic manner
  const parseRulesText = (text: string, name?: string) => {
    if (!text || !ParserCls) return [];
    try {
      const parser = new (ParserCls as any)({ format: "text/n3" });
      const parsed = parser.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      stage(id, "parsing-rules-error", { name: name || "inline", message: String(e && (e as any).message ? (e as any).message : e) });
    }
    return [];
  };

  // If rulesOrNames are strings -> fetch each and parse; if objects -> treat as serialized quads
  if (Array.isArray(rulesOrNames) && rulesOrNames.length > 0) {
    if (typeof rulesOrNames[0] === "string") {
      // fetch each named ruleset
      for (const name of rulesOrNames as string[]) {
        try {
          stage(id, "fetching-rules", { name });
          const resp = await fetch(`${import.meta.env.BASE_URL}reasoning-rules/${name}`);
          const text = resp && resp.ok ? await resp.text() : "";
          stage(id, "fetched-rules", { name, bytes: text ? text.length : 0, ok: Boolean(text && text.length) });
          if (text && text.trim().length > 0) {
            const parsed = parseRulesText(text, name);
            if (parsed && parsed.length) {
              parsedRules.push(...parsed);
              stage(id, "parsing-rules", { name, rulesParsedCount: parsed.length });
            } else {
              stage(id, "parsing-rules", { name, rulesParsedCount: 0 });
            }
          }
        } catch (e) {
          stage(id, "fetch-error", { name, message: String(e && (e as any).message ? (e as any).message : e) });
        }
      }
    } else {
      // assume serialized quad rule objects
      for (const r of rulesOrNames as SerializedQuad[]) {
        try {
          const s = /^_:/.test(String(r.s || "")) ? blankNode(String(r.s).replace(/^_:/, "")) : namedNode(String(r.s));
          const p = namedNode(String(r.p));
          let o: any = null;
          if (r.o && r.o.t === "iri") o = namedNode(String(r.o.v));
          else if (r.o && r.o.t === "bnode") o = blankNode(String(r.o.v));
          else if (r.o && r.o.t === "lit") {
            if (r.o.dt) o = literal(String(r.o.v), namedNode(String(r.o.dt)));
            else if (r.o.ln) o = literal(String(r.o.v), String(r.o.ln));
            else o = literal(String(r.o.v));
          } else {
            o = literal(String((r.o && r.o.v) || ""));
          }
          const g = r.g ? namedNode(String(r.g)) : undefined;
          parsedRules.push(quad(s as any, p as any, o as any, g as any));
        } catch (_) {
          // ignore per-rule
        }
      }
      stage(id, "parsing-rules", { rulesParsedCount: parsedRules.length });
    }
  } else {
    // no rules provided: try default file
    try {
      const name = "best-practice.n3";
      stage(id, "fetching-rules", { name });
      const resp = await fetch(`${import.meta.env.BASE_URL}reasoning-rules/${name}`);
      const text = resp && resp.ok ? await resp.text() : "";
      stage(id, "fetched-rules", { name, bytes: text ? text.length : 0, ok: Boolean(text && text.length) });
      if (text && text.trim().length > 0) {
        const parsed = parseRulesText(text, name);
        if (parsed && parsed.length) {
          parsedRules.push(...parsed);
          stage(id, "parsing-rules", { name, rulesParsedCount: parsed.length });
        }
      }
    } catch (e) {
      // best-effort
      stage(id, "fetch-default-rules-failed", { message: String(e && (e as any).message ? (e as any).message : e) });
    }
  }

  // Emit small parsed rules snapshot
  try {
    stage(id, "parsed_rules_snapshot", { parsedCount: parsedRules.length, sampleRules: serializeSample(parsedRules, 10) });
  } catch (_) { /* ignore */ }

  // If we have parsed rules, create a rules store
  let rulesStore: any = undefined;
  if (parsedRules.length > 0 && StoreCls) {
    try {
      rulesStore = new StoreCls(parsedRules);
      stage(id, "rules-store-created", { rulesCount: parsedRules.length });
    } catch (e) {
      stage(id, "rules-store-create-failed", { message: String(e && (e as any).message ? (e as any).message : e) });
      rulesStore = undefined;
    }
  }

  // Reasoner: instantiate and run if available
  if (!ReasonerCls || typeof ReasonerCls !== "function") {
    stage(id, "no-reasoner-impl");
    // We still return the current store snapshot as a result (best-effort)
    try {
      const after = tempStore.getQuads(null, null, null, null) || [];
      const serializedAfter: SerializedQuad[] = after.map((q: any) => toSerializedQuad(q)).filter((x: any) => x) as SerializedQuad[];
      self.postMessage({ type: "result", id, afterQuads: serializedAfter });
    } catch (e) {
      try { self.postMessage({ type: "error", id, message: "result-serialize-failed", details: String(e) }); } catch (_) { /* ignore */ }
    }
    return;
  }

  // instantiate reasoner impl (normalize default)
  let ReasonerImpl: any = ReasonerCls;
  if (typeof ReasonerImpl !== "function" && ReasonerImpl && typeof ReasonerImpl.default === "function") {
    ReasonerImpl = ReasonerImpl.default;
  }
  if (typeof ReasonerImpl !== "function") {
    stage(id, "reasoner-not-callable");
    try { self.postMessage({ type: "error", id, message: "reasoner-not-callable" }); } catch (_) { /* ignore */ }
    return;
  }

  try {
    stage(id, "reasoner-instantiated");
    const reasoner = new ReasonerImpl(tempStore);

    stage(id, "reasoning-started");
    const beforeQuads = tempStore.getQuads(null, null, null, null) || [];
    const beforeCount = beforeQuads.length;
    const t0 = Date.now();

    // Provide rules dataset-like object for the reasoner
    let reasonerInput: any = null;
    if (rulesStore) reasonerInput = rulesStore;
    else if (Array.isArray(parsedRules) && parsedRules.length > 0) {
      reasonerInput = {
        match: (s: any, p: any, o: any, g: any) => {
          try {
            return (parsedRules || []).filter((q: any) => {
              try {
                if (p && p.value) {
                  if (!q.predicate || String(q.predicate.value) !== String(p.value)) return false;
                }
                if (g && typeof g.value === "string" && String(g.value) !== "") {
                  if (!(q.graph && q.graph.value && String(q.graph.value) === String(g.value))) return false;
                }
                return true;
              } catch (_) { return false; }
            });
          } catch (_) { return []; }
        },
      };
    } else {
      reasonerInput = { match: () => [] };
    }

    const maybePromise = reasoner.reason(reasonerInput);
    if (maybePromise && typeof maybePromise.then === "function") {
      await maybePromise;
    }
    const duration = Date.now() - t0;

    const after = tempStore.getQuads(null, null, null, null) || [];

    // Compute added quads
    const beforeMap = new Map<string, boolean>();
    for (const q of beforeQuads || []) {
      try {
        const key = `${q.subject && q.subject.value ? q.subject.value : ""}|${q.predicate && q.predicate.value ? q.predicate.value : ""}|${q.object && q.object.value ? q.object.value : ""}|${q.graph && q.graph.value ? q.graph.value : ""}`;
        beforeMap.set(key, true);
      } catch (_) { /* ignore */ }
    }
    const addedQuads: any[] = [];
    for (const q of after || []) {
      try {
        const key = `${q.subject && q.subject.value ? q.subject.value : ""}|${q.predicate && q.predicate.value ? q.predicate.value : ""}|${q.object && q.object.value ? q.object.value : ""}|${q.graph && q.graph.value ? q.graph.value : ""}`;
        if (!beforeMap.has(key)) addedQuads.push(q);
      } catch (_) { /* ignore */ }
    }

    // Emit sample of added quads
    try {
      stage(id, "reasoner.added_quads", { addedCount: addedQuads.length, sampleAdded: serializeSample(addedQuads, 10) });
    } catch (_) { /* ignore */ }

    const inferredCount = Math.max(0, (after.length || 0) - beforeCount);
    stage(id, "reasoning-completed", { durationMs: duration, inferredCount });

    // Serialize after-quads and post result
    const serializedAfter: SerializedQuad[] = [];
    for (const q of after) {
      const sq = toSerializedQuad(q);
      if (sq) serializedAfter.push(sq);
    }
    self.postMessage({ type: "result", id, afterQuads: serializedAfter });
  } catch (err) {
    try {
      stage(id, "reasoner-failed", { message: String(err && (err as any).message ? (err as any).message : err) });
      self.postMessage({ type: "error", id, message: String(err && (err as any).message ? (err as any).message : err), stack: err && (err as any).stack ? (err as any).stack : undefined });
    } catch (_) { /* ignore */ }
  }
}

self.onmessage = (ev: MessageEvent) => {
  const m = ev && ev.data ? ev.data : {};
  if (!m || !m.type) return;
  if (m.type === "run") {
    const id = m.id || String(Date.now());
    const quads = Array.isArray(m.quads) ? m.quads as SerializedQuad[] : [];
    const rules = Array.isArray(m.rules) ? m.rules as any[] : undefined;
    void runReasoner(id, quads, rules);
    return;
  }
  if (m.type === "cancel") {
    try { self.postMessage({ type: "cancelled", id: m.id || null }); } catch (_) { /* ignore */ }
    return;
  }
};
