/**
 * Worker for running the N3 reasoner off the main thread.
 *
 * Protocol:
 * - main -> worker:
 *   { type: "run", id, quads: SerializedQuad[], rules: SerializedQuad[] }
 *   { type: "cancel", id }
 *
 * - worker -> main:
 *   { type: "progress", id, percent }
 *   { type: "result", id, afterQuads: SerializedQuad[] }
 *   { type: "error", id, message, stack }
 *
 * SerializedQuad shape:
 *  { s: string, p: string, o: { t: "iri"|"lit"|"bnode", v: string, dt?: string, ln?: string }, g?: string }
 *
 * The worker dynamically imports "n3" and attempts to instantiate the Reasoner.
 * This worker runs in browser module Worker context.
*/
 
import './polyfills';
import type { Quad } from "n3";

type SerializedObject = { t: "iri" | "lit" | "bnode", v: string, dt?: string, ln?: string };
type SerializedQuad = { s: string, p: string, o: SerializedObject, g?: string };

declare const self: any;

async function runReasoner(id: string, quads: SerializedQuad[], rulesOrNames: any[] | undefined) {
  // rulesOrNames can be:
  // - undefined
  // - an array of SerializedQuad (pre-parsed rules)
  // - an array of string names (ruleset filenames)
  const stage = (s: string, data?: Record<string, any>) => {
    try { self.postMessage(Object.assign({ type: "stage", id, stage: s }, data || {})); } catch (_) {}
  };

  try {
    stage("init");

    const n3mod: any = await import("n3");
    const DataFactory = n3mod.DataFactory || (n3mod.default && n3mod.default.DataFactory);
    const StoreCls = n3mod.Store || (n3mod.default && n3mod.default.Store);
    const ParserCls = n3mod.Parser || (n3mod.default && n3mod.default.Parser);
    const ReasonerCls = n3mod.Reasoner || (n3mod.default && n3mod.default.Reasoner) || n3mod.N3Reasoner || (n3mod.default && n3mod.default.N3Reasoner) || null;

    const { namedNode, literal, blankNode, quad } = DataFactory;

    // Reconstruct a store from serialized quads
    const tempStore = new StoreCls();
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
      } catch (e) {
        // ignore per-quad
      }
    }
    stage("store-created", { quadCount: (quads || []).length });

    // Build rules store: either from pre-serialized quads or from ruleset filenames (fetch+parse)
    let rulesStore: any = undefined;
    const parsedRules: any[] = [];

    if (Array.isArray(rulesOrNames) && rulesOrNames.length > 0) {
      // decide if these are strings (names) or serialized quads (objects)
      if (typeof (rulesOrNames[0]) === "string") {
        // ruleset names: fetch each and parse inside worker
        for (const name of rulesOrNames as string[]) {
          try {
            stage("fetching-rules", { name });
            const resp = await fetch(`/reasoning-rules/${name}`);
            const text = resp && resp.ok ? await resp.text() : "";
            stage("fetched-rules", { name, bytes: text ? text.length : 0, ok: Boolean(text && text.length) });
            if (text && text.trim().length > 0 && ParserCls) {
              try {
                const parser = new ParserCls({ format: "text/n3" });
                const parsed = parser.parse(text);
                if (Array.isArray(parsed)) {
                  parsedRules.push(...parsed);
                  stage("parsing-rules", { name, rulesParsedCount: parsed.length });
                } else {
                  stage("parsing-rules", { name, rulesParsedCount: 0 });
                }
              } catch (pe) {
                stage("parsing-error", { name, message: String(pe && pe.message ? pe.message : pe) });
              }
            }
          } catch (fe) {
            stage("fetch-error", { name, message: String(fe && fe.message ? fe.message : fe) });
          }
        }
      } else {
        // assume serialized rule quads were provided
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
          } catch (_) { /* ignore per-rule */ }
        }
        stage("parsing-rules", { rulesParsedCount: parsedRules.length });
      }
    } else {
      // try default rules file
      try {
        stage("fetching-rules", { name: "best-practice.n3" });
        const resp = await fetch("/reasoning-rules/best-practice.n3");
        const text = resp && resp.ok ? await resp.text() : "";
        stage("fetched-rules", { name: "best-practice.n3", bytes: text ? text.length : 0, ok: Boolean(text && text.length) });
        if (text && text.trim().length > 0 && ParserCls) {
          try {
            const parser = new ParserCls({ format: "text/n3" });
            const parsed = parser.parse(text);
            if (Array.isArray(parsed)) {
              parsedRules.push(...parsed);
              stage("parsing-rules", { name: "best-practice.n3", rulesParsedCount: parsed.length });
            }
          } catch (pe) {
            stage("parsing-error", { name: "best-practice.n3", message: String(pe && pe.message ? pe.message : pe) });
          }
        }
      } catch (e) {
        // ignore
      }
    }

    // Emit a small parsed-rules diagnostic so the main thread can inspect what the parser produced.
    try {
      const sampleRules = (parsedRules || []).slice(0, 10).map((q: any) => {
        try {
          return {
            s: q.subject && q.subject.value ? String(q.subject.value) : "",
            p: q.predicate && q.predicate.value ? String(q.predicate.value) : "",
            o: q.object && q.object.value ? String(q.object.value) : "",
            g: q.graph && q.graph.value ? String(q.graph.value) : "",
          };
        } catch (_) { return null; }
      }).filter((x: any) => x);
      try { self.postMessage({ type: "stage", id, stage: "parsed_rules_snapshot", parsedCount: Array.isArray(parsedRules) ? parsedRules.length : 0, sampleRules }); } catch (_) { /* ignore */ }
    } catch (_) { /* ignore */ }

    if (parsedRules.length > 0 && StoreCls) {
      try {
        rulesStore = new StoreCls(parsedRules);
        stage("rules-store-created", { rulesCount: parsedRules.length });
      } catch (_) {
        rulesStore = undefined;
      }
    }

    // If there's a Reasoner implementation, attempt to run it.
    if (ReasonerCls && typeof ReasonerCls === "function") {
      try {
        stage("reasoner-instantiated");
        let ReasonerImpl: any = ReasonerCls;
        if (typeof ReasonerImpl !== "function" && ReasonerImpl && typeof ReasonerImpl.default === "function") {
          ReasonerImpl = ReasonerImpl.default;
        }
        if (typeof ReasonerImpl === "function") {
          const reasoner = new ReasonerImpl(tempStore);
          if (typeof reasoner.reason === "function") {
                stage("reasoning-started");
                // Capture full before snapshot so we can compute a meaningful delta inside the worker.
                const beforeQuads = tempStore.getQuads(null, null, null, null) || [];
                const beforeCount = beforeQuads.length;
                const t0 = Date.now();
                // Ensure we always pass a dataset-like object to the reasoner.
                // Some Reasoner implementations call dataset.match(...). To avoid
                // "dataset is undefined" errors, create a small wrapper when we don't
                // have an actual Store instance.
                let reasonerInput: any = null;
                if (rulesStore) {
                  reasonerInput = rulesStore;
                } else if (Array.isArray(parsedRules) && parsedRules.length > 0) {
                  // parsedRules contains parsed quads from the parser; provide a tiny
                  // dataset-like wrapper that supports .match(...) and returns an array
                  // (iterable) of matching quads.
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
                  // No rules available: provide a no-op dataset with match -> []
                  reasonerInput = { match: () => [] };
                }
                const maybePromise = reasoner.reason(reasonerInput);
                if (maybePromise && typeof maybePromise.then === "function") {
                  await maybePromise;
                }
                const duration = Date.now() - t0;
                const after = tempStore.getQuads(null, null, null, null) || [];

                // Compute added quads (worker-side) so main thread can inspect them directly.
                const beforeMap = new Map();
                try {
                  for (const q of beforeQuads || []) {
                    try {
                      const key = `${q.subject && q.subject.value ? q.subject.value : ""}|${q.predicate && q.predicate.value ? q.predicate.value : ""}|${q.object && q.object.value ? q.object.value : ""}|${q.graph && q.graph.value ? q.graph.value : ""}`;
                      beforeMap.set(key, true);
                    } catch (_) { /* ignore per-quad */ }
                  }
                } catch (_) { /* ignore */ }

                const addedQuads = [];
                for (const q of after || []) {
                  try {
                    const key = `${q.subject && q.subject.value ? q.subject.value : ""}|${q.predicate && q.predicate.value ? q.predicate.value : ""}|${q.object && q.object.value ? q.object.value : ""}|${q.graph && q.graph.value ? q.graph.value : ""}`;
                    if (!beforeMap.has(key)) addedQuads.push(q);
                  } catch (_) { /* per-quad */ }
                }

                // Serialize a small sample of added quads for diagnostics
                try {
                  const sampleAdded = (addedQuads || []).slice(0, 10).map((q: any) => {
                    try {
                      return {
                        s: q.subject && q.subject.value ? String(q.subject.value) : "",
                        p: q.predicate && q.predicate.value ? String(q.predicate.value) : "",
                        o: q.object && q.object.value ? String(q.object.value) : "",
                        g: q.graph && q.graph.value ? String(q.graph.value) : "",
                      };
                    } catch (_) { return null; }
                  }).filter((x: any) => x);
                  try { self.postMessage({ type: "stage", id, stage: "reasoner.added_quads", addedCount: Array.isArray(addedQuads) ? addedQuads.length : 0, sampleAdded }); } catch (_) { /* ignore */ }
                } catch (_) { /* ignore */ }

                const inferredCount = Math.max(0, (after.length || 0) - beforeCount);
                stage("reasoning-completed", { durationMs: duration, inferredCount });
          }
        }
      } catch (e) {
        // Reasoner invocation failed; post error but continue to return the store snapshot as best-effort.
        try {
          self.postMessage({ type: "error", id, message: String(e && e.message ? e.message : e), stack: e && e.stack ? e.stack : undefined });
        } catch (_) { /* ignore */ }
      }
    }

    // Collect after-quads
    const after = tempStore.getQuads(null, null, null, null) || [];
    const serializedAfter: SerializedQuad[] = [];
    for (const q of after) {
      try {
        const subj = q.subject && (q.subject as any).value ? String((q.subject as any).value) : "";
        const pred = q.predicate && (q.predicate as any).value ? String((q.predicate as any).value) : "";
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
        const g = q.graph && (q.graph as any).value ? String((q.graph as any).value) : undefined;
        serializedAfter.push({ s: subj, p: pred, o: obj, g });
      } catch (_) { /* ignore per-quad */ }
    }

    // Post result
    self.postMessage({ type: "result", id, afterQuads: serializedAfter });
  } catch (err) {
    try {
      self.postMessage({ type: "error", id, message: String(err && (err as any).message ? (err as any).message : err), stack: (err as any).stack });
    } catch (_) { /* ignore */ }
  }
}

self.addEventListener("message", (ev: MessageEvent) => {
  const m = ev && ev.data ? ev.data : {};
  try {
    if (!m || !m.type) return;
    if (m.type === "run") {
      const id = m.id || String(Date.now());
      const quads = Array.isArray(m.quads) ? m.quads as SerializedQuad[] : [];
      const rules = Array.isArray(m.rules) ? m.rules as SerializedQuad[] : undefined;
      void runReasoner(id, quads, rules);
      return;
    }
    if (m.type === "cancel") {
      // Best-effort: no reliable cancellation for the imported reasoner, but we can terminate worker if needed.
      // Main thread can terminate and recreate the worker if required.
      // A polite approach would be to set a global flag, but the imported reasoner likely won't check it.
      // We'll just acknowledge.
      try {
        self.postMessage({ type: "cancelled", id: m.id || null });
      } catch (_) { /* ignore */ }
      return;
    }
  } catch (e) {
    try {
      self.postMessage({ type: "error", id: m && m.id, message: String(e && (e as any).message ? (e as any).message : e) });
    } catch (_) { /* ignore */ }
  }
});
