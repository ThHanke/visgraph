import type {
  ReasoningError,
  ReasoningInference,
  ReasoningResult,
  ReasoningWarning,
} from "./reasoningTypes";
export type {
  ReasoningError,
  ReasoningInference,
  ReasoningResult,
  ReasoningWarning,
} from "./reasoningTypes";

import { RDFManagerImpl, enableN3StoreWriteLogging, collectGraphCountsFromStore } from "./rdfManager.impl";
import { createRdfManagerWorkerClient, RdfManagerWorkerClient } from "./rdfManager.workerClient";
import type {
  RDFWorkerCommandName,
  RDFWorkerCommandPayloads,
  PlainQuad,
  PlainQuadTerm,
} from "./rdfManager.workerProtocol";
import type { WorkerQuad, WorkerTerm } from "./rdfSerialization";
import { useAppConfigStore } from "../stores/appConfigStore";

export { RDFManagerImpl as RDFManager, enableN3StoreWriteLogging, collectGraphCountsFromStore };

type RDFManagerInstance = RDFManagerImpl & {
  getGraphCounts: () => Promise<Record<string, number>>;
};

const baseManager = new RDFManagerImpl();

const IRI_REGEX = /^[a-z][a-z0-9+.-]*:/i;

const isRdfTerm = (value: any): value is { termType: string; value: string; datatype?: { value: string }; language?: string } => {
  return value && typeof value === "object" && typeof value.termType === "string";
};

const toPlainSubject = (value: any): string => {
  if (isRdfTerm(value)) {
    if (value.termType === "BlankNode") return `_:${String(value.value || "")}`;
    return String(value.value || "");
  }
  if (value && typeof value === "object" && typeof value.value === "string") {
    return String(value.value);
  }
  return String(value ?? "");
};

const toPlainPredicate = (value: any): string => {
  if (isRdfTerm(value)) return String(value.value || "");
  if (value && typeof value === "object" && typeof value.value === "string") {
    return String(value.value);
  }
  return String(value ?? "");
};

const toPlainObjectTerm = (value: any): PlainQuadTerm | null => {
  if (value === null || typeof value === "undefined") return null;

  if (isRdfTerm(value)) {
    const termType = value.termType;
    if (value.termType === "NamedNode") {
      return { t: "iri", v: String(value.value || "") };
    }
    if (value.termType === "BlankNode") {
      return { t: "bnode", v: String(value.value || "") };
    }
    if (value.termType === "Literal") {
      const plain: PlainQuadTerm = { t: "lit", v: String(value.value || "") };
      if (value.datatype && value.datatype.value) plain.dt = String(value.datatype.value);
      if ((value as any).language) plain.ln = String((value as any).language);
      return plain;
    }
  }

  if (value && typeof value === "object") {
    const loweredType = typeof value.type === "string" ? value.type.toLowerCase() : "";
    if ("value" in value) {
      const rawVal = String((value as any).value || "");
      if (loweredType === "iri" || loweredType === "namednode") {
        return { t: "iri", v: rawVal };
      }
      if (loweredType === "bnode" || loweredType === "blanknode" || loweredType === "blank") {
        return { t: "bnode", v: rawVal.replace(/^_:/, "") };
      }
      if (loweredType === "literal" || loweredType === "lit") {
        const plain: PlainQuadTerm = { t: "lit", v: rawVal };
        if (value.datatype) plain.dt = String(value.datatype && value.datatype.value ? value.datatype.value : value.datatype);
        if (value.language) plain.ln = String(value.language);
        if (value.lang) plain.ln = String(value.lang);
        return plain;
      }
      if (value.datatype || value.language || value.lang) {
        const plain: PlainQuadTerm = { t: "lit", v: rawVal };
        if (value.datatype) plain.dt = String(value.datatype && value.datatype.value ? value.datatype.value : value.datatype);
        if (value.language) plain.ln = String(value.language);
        if (value.lang) plain.ln = String(value.lang);
        return plain;
      }
      if (IRI_REGEX.test(rawVal)) {
        return { t: "iri", v: rawVal };
      }
      if (/^_:/i.test(rawVal)) {
        return { t: "bnode", v: rawVal.replace(/^_:/, "") };
      }
      return { t: "lit", v: rawVal };
    }
  }

  const str = String(value);
  if (/^_:/i.test(str)) return { t: "bnode", v: str.replace(/^_:/, "") };
  if (IRI_REGEX.test(str)) return { t: "iri", v: str };
  return { t: "lit", v: str };
};

const quadToPlain = (quad: any): PlainQuad | null => {
  if (!quad) return null;
  const plain: PlainQuad = {
    s: toPlainSubject(quad.subject),
    p: toPlainPredicate(quad.predicate),
    o: toPlainObjectTerm(quad.object) ?? { t: "lit", v: "" },
  };
  try {
    const graphValue =
      quad.graph && typeof quad.graph.value === "string" && quad.graph.value.length > 0
        ? String(quad.graph.value)
        : undefined;
    if (graphValue) plain.g = graphValue;
  } catch (_) {
    /* ignore graph extraction failures */
  }
  return plain;
};

const plainObjectToWorkerTerm = (obj: PlainQuadTerm): WorkerTerm => {
  switch (obj.t) {
    case "iri":
      return { termType: "NamedNode", value: obj.v };
    case "bnode":
      return { termType: "BlankNode", value: obj.v.replace(/^_:/, "") };
    case "lit":
    default: {
      const term: WorkerTerm = { termType: "Literal", value: obj.v };
      if (obj.dt) term.datatype = obj.dt;
      if (obj.ln) term.language = obj.ln;
      return term;
    }
  }
};

const plainQuadToWorkerQuad = (plain: PlainQuad): WorkerQuad => {
  const subject: WorkerTerm = plain.s.startsWith("_:")
    ? { termType: "BlankNode", value: plain.s.slice(2) }
    : { termType: "NamedNode", value: plain.s };
  const predicate: WorkerTerm = { termType: "NamedNode", value: plain.p };
  const graph: WorkerTerm =
    plain.g && plain.g !== "default"
      ? { termType: "NamedNode", value: plain.g }
      : { termType: "DefaultGraph" };
  const worker: WorkerQuad = {
    subject,
    predicate,
    graph,
  };
  if (plain.o) {
    worker.object = plainObjectToWorkerTerm(plain.o);
  }
  return worker;
};

const collectPlainQuadsFromGraph = (graphName: string): PlainQuad[] => {
  try {
    const store = (baseManager as any).getStore?.();
    if (!store || typeof store.getQuads !== "function") return [];
    const graphArg =
      graphName && graphName !== "default" ? graphName : null;
    const quads = store.getQuads(null, null, null, graphArg) || [];
    const plain: PlainQuad[] = [];
    for (const q of quads) {
      const pq = quadToPlain(q);
      if (pq) {
        if (!pq.g && graphName && graphName !== "default") {
          pq.g = graphName;
        }
        plain.push(pq);
      }
    }
    return plain;
  } catch (err) {
    console.error("[rdfManager] collectPlainQuadsFromGraph failed", err);
    return [];
  }
};

const buildWorkerBatchPayload = (
  changes: { removes?: any[]; adds?: any[] },
  graphName: string,
): RDFWorkerCommandPayloads["syncBatch"] => {
  const graph = graphName || "urn:vg:data";
  const adds: PlainQuad[] = [];
  const removes: PlainQuad[] = [];

  if (changes && Array.isArray(changes.adds)) {
    for (const entry of changes.adds) {
      const subjectRaw = entry?.subject ?? entry?.s;
      const predicateRaw = entry?.predicate ?? entry?.p;
      if (typeof subjectRaw === "undefined" || typeof predicateRaw === "undefined") continue;
      const subject = toPlainSubject(subjectRaw);
      const predicate = toPlainPredicate(predicateRaw);
      const objectSource = entry?.object ?? entry?.o ?? entry?.value;
      const objectPlain = toPlainObjectTerm(objectSource);
      if (!objectPlain) continue;
      const graphOverride = entry?.graph ?? entry?.g;
      adds.push({
        s: subject,
        p: predicate,
        o: objectPlain,
        g: typeof graphOverride === "string" && graphOverride.length > 0 ? graphOverride : graph,
      });
    }
  }

  if (changes && Array.isArray(changes.removes)) {
    for (const entry of changes.removes) {
      const subjectRaw = entry?.subject ?? entry?.s;
      const predicateRaw = entry?.predicate ?? entry?.p;
      if (typeof subjectRaw === "undefined" || typeof predicateRaw === "undefined") continue;
      const subject = toPlainSubject(subjectRaw);
      const predicate = toPlainPredicate(predicateRaw);
      const objectSource = entry?.object ?? entry?.o ?? entry?.value;
      const hasObject =
        !(objectSource === null || typeof objectSource === "undefined" || objectSource === "");
      const graphOverride = entry?.graph ?? entry?.g;
      const removePlain: PlainQuad = {
        s: subject,
        p: predicate,
        g: typeof graphOverride === "string" && graphOverride.length > 0 ? graphOverride : graph,
      };
      if (hasObject) {
        const objectPlain = toPlainObjectTerm(objectSource);
        if (objectPlain) removePlain.o = objectPlain;
      }
      removes.push(removePlain);
    }
  }

  const payload: RDFWorkerCommandPayloads["syncBatch"] = {
    graphName: graph,
    adds: adds.map(plainQuadToWorkerQuad),
    removes: removes.map((plain) => plainQuadToWorkerQuad(plain)),
  };

  const options = (changes as any)?.options;
  if (options && typeof options === "object") {
    payload.options = {
      suppressSubjects: options.suppressSubjects === true,
    };
  }

  return payload;
};
const localExecutor = async <C extends RDFWorkerCommandName>(
  command: C,
  payload: RDFWorkerCommandPayloads[C],
): Promise<unknown> => {
  const fn = (RDFManagerImpl.prototype as any)[command];
  if (typeof fn !== "function") {
    throw new Error(`[rdfManager] Unsupported command executed locally: ${String(command)}`);
  }
  if (typeof payload === "undefined") {
    return fn.apply(baseManager, []);
  }
  if (Array.isArray(payload)) {
    return fn.apply(baseManager, payload);
  }
  return fn.apply(baseManager, [payload]);
};

const shouldEnableWorker = (() => {
  try {
    if (typeof window === "undefined") return false;
    if (typeof Worker === "undefined") return false;
    if ((window as any).__VG_ENABLE_RDF_WORKER__ === true) return true;
    if (
      typeof process !== "undefined" &&
      process.env &&
      process.env.VG_ENABLE_RDF_WORKER === "true"
    ) {
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
})();

let workerClient: RdfManagerWorkerClient | null = null;
if (shouldEnableWorker) {
  try {
    workerClient = createRdfManagerWorkerClient({ executor: localExecutor });
  } catch (err) {
    console.warn("[rdfManager] Failed to initialise worker client, falling back to local store:", err);
    workerClient = null;
  }
}
const workerEnabled = !!workerClient;

const callWorker = async <C extends RDFWorkerCommandName>(
  command: C,
  payload?: RDFWorkerCommandPayloads[C],
) => {
  if (!workerClient) {
    throw new Error("rdfManager worker not initialised");
  }
  return workerClient.call(command, payload as any);
};

type ChangeSubscriber = (count: number, meta?: unknown) => void;
type SubjectsSubscriber = (subjects: string[], quads?: unknown) => void;

const changeSubscribers = new Set<ChangeSubscriber>();
const subjectsSubscribers = new Set<SubjectsSubscriber>();
let localChangeBridgeInstalled = false;
let localSubjectsBridgeInstalled = false;

let lastLocalChangeCount = 0;
const localChangeForwarder = (count: number, meta?: unknown) => {
  const resolvedCount =
    typeof count === "number" && Number.isFinite(count) ? count : ++lastLocalChangeCount;
  lastLocalChangeCount = resolvedCount;
  for (const cb of Array.from(changeSubscribers)) {
    try {
      (cb as any)(resolvedCount, meta);
    } catch (err) {
      /* ignore individual subscriber errors */
    }
  }
};

const localSubjectsForwarder = (subjects: string[], quads?: unknown) => {
  for (const cb of Array.from(subjectsSubscribers)) {
    try {
      (cb as any)(subjects, quads);
    } catch (err) {
      /* ignore individual subscriber errors */
    }
  }
};

const ensureLocalChangeBridge = () => {
  if (localChangeBridgeInstalled) return;
  localChangeBridgeInstalled = true;
  baseManager.onChange(localChangeForwarder);
};

const ensureLocalSubjectsBridge = () => {
  if (localSubjectsBridgeInstalled) return;
  localSubjectsBridgeInstalled = true;
  baseManager.onSubjectsChange(localSubjectsForwarder as any);
};

let workerChangeUnsub: (() => void) | null = null;
let workerSubjectsUnsub: (() => void) | null = null;
let lastWorkerChangeCount = 0;

const ensureWorkerChangeBridge = () => {
  if (!workerEnabled || workerChangeUnsub || !workerClient) return;
  workerChangeUnsub = workerClient.on("change", (payload: any) => {
    let resolvedCount: number;
    if (payload && typeof payload.changeCount === "number" && Number.isFinite(payload.changeCount)) {
      resolvedCount = payload.changeCount;
      lastWorkerChangeCount = resolvedCount;
    } else {
      resolvedCount = ++lastWorkerChangeCount;
    }
    const meta = payload ? payload.meta : undefined;
    localChangeForwarder(resolvedCount, meta);
  });
};

const ensureWorkerSubjectsBridge = () => {
  if (!workerEnabled || workerSubjectsUnsub || !workerClient) return;
  workerSubjectsUnsub = workerClient.on("subjects", (payload: any) => {
    const subjects = Array.isArray(payload?.subjects) ? payload.subjects : [];
    const quads = payload?.quads;
    localSubjectsForwarder(subjects, quads);
  });
};

const teardownWorkerChangeBridge = () => {
  if (changeSubscribers.size > 0) return;
  if (workerChangeUnsub) {
    try {
      workerChangeUnsub();
    } catch (_) {
      /* ignore */
    }
    workerChangeUnsub = null;
  }
};

const teardownWorkerSubjectsBridge = () => {
  if (subjectsSubscribers.size > 0) return;
  if (workerSubjectsUnsub) {
    try {
      workerSubjectsUnsub();
    } catch (_) {
      /* ignore */
    }
    workerSubjectsUnsub = null;
  }
};

const rdfManagerProxyHandler: ProxyHandler<RDFManagerImpl> = {
  get(target, prop, receiver) {
    if (prop === "getGraphCounts") {
      return async () => {
        if (workerClient) {
          try {
            const result = await workerClient.call("getGraphCounts");
            return (result && typeof result === "object" ? result : {}) as Record<string, number>;
          } catch (err) {
            console.warn("[rdfManager] getGraphCounts worker call failed, using local store", err);
          }
        }
        try {
          const localResult = (target as any).getGraphCounts();
          return localResult || {};
        } catch (err) {
          console.error("[rdfManager] local getGraphCounts failed", err);
          return {};
        }
      };
    }

    if (prop === "clear") {
      return () => {
        target.clear();
        if (workerEnabled) {
          void callWorker("clear").catch((err) => {
            console.error("[rdfManager] worker clear failed", err);
          });
        }
      };
    }

    if (prop === "onChange") {
      return (cb: ChangeSubscriber) => {
        if (typeof cb !== "function") return;
        changeSubscribers.add(cb);
        ensureLocalChangeBridge();
        if (workerEnabled) ensureWorkerChangeBridge();
      };
    }

    if (prop === "offChange") {
      return (cb: ChangeSubscriber) => {
        changeSubscribers.delete(cb);
        if (workerEnabled) teardownWorkerChangeBridge();
      };
    }

    if (prop === "onSubjectsChange") {
      return (cb: SubjectsSubscriber) => {
        if (typeof cb !== "function") return;
        subjectsSubscribers.add(cb);
        ensureLocalSubjectsBridge();
        if (workerEnabled) ensureWorkerSubjectsBridge();
      };
    }

    if (prop === "offSubjectsChange") {
      return (cb: SubjectsSubscriber) => {
        subjectsSubscribers.delete(cb);
        if (workerEnabled) teardownWorkerSubjectsBridge();
      };
    }

    if (prop === "addNamespace") {
      return (prefix: string, uri: any) => {
        (target as any).addNamespace(prefix, uri);
        if (workerEnabled) {
          void callWorker("setNamespaces", { namespaces: (target as any).getNamespaces() }).catch((err) => {
            console.error("[rdfManager] worker setNamespaces failed", err);
          });
        }
      };
    }

    if (prop === "removeNamespaceAndQuads") {
      return (prefixOrUri: string) => {
        (target as any).removeNamespaceAndQuads(prefixOrUri);
        if (workerEnabled) {
          void callWorker("setNamespaces", { namespaces: (target as any).getNamespaces() }).catch((err) => {
            console.error("[rdfManager] worker setNamespaces failed", err);
          });
        }
      };
    }

    if (prop === "setBlacklist") {
      return (prefixes?: string[] | null, uris?: string[] | null) => {
        (target as any).setBlacklist(prefixes, uris);
        if (workerEnabled) {
          const current = (target as any).getBlacklist?.();
          if (current) {
            void callWorker("setBlacklist", {
              prefixes: Array.isArray(current.prefixes) ? current.prefixes : [],
              uris: Array.isArray(current.uris) ? current.uris : [],
            }).catch((err) => {
              console.error("[rdfManager] worker setBlacklist failed", err);
            });
          }
        }
      };
    }

    if (prop === "applyBatch") {
      return async (changes: { removes?: any[]; adds?: any[] }, graphName: string = "urn:vg:data") => {
        await (target as any).applyBatch(changes, graphName);
        if (workerEnabled) {
          const payload = buildWorkerBatchPayload(changes || {}, graphName);
          if ((payload.adds && payload.adds.length > 0) || (payload.removes && payload.removes.length > 0)) {
            try {
              await callWorker("syncBatch", payload);
            } catch (err) {
              console.error("[rdfManager] worker syncBatch failed", err);
            }
          }
        }
      };
    }

    if (prop === "removeGraph") {
      return (graphName: string) => {
        (target as any).removeGraph(graphName);
        if (workerEnabled) {
          void callWorker("syncRemoveGraph", { graphName: String(graphName || "urn:vg:data") }).catch((err) => {
            console.error("[rdfManager] worker syncRemoveGraph failed", err);
          });
        }
      };
    }

    if (prop === "removeAllQuadsForIri") {
      return async (iri: string, graphName: string = "urn:vg:data") => {
        await (target as any).removeAllQuadsForIri(iri, graphName);
        if (workerEnabled) {
          try {
            await callWorker("syncRemoveAllQuadsForIri", {
              iri: String(iri),
              graphName: String(graphName || "urn:vg:data"),
            });
          } catch (err) {
            console.error("[rdfManager] worker syncRemoveAllQuadsForIri failed", err);
          }
        }
      };
    }

    if (prop === "emitAllSubjects") {
      return async (graphName: string = "urn:vg:data") => {
        if (workerEnabled) {
          try {
            await callWorker("emitAllSubjects", { graphName: String(graphName || "urn:vg:data") });
            return;
          } catch (err) {
            console.error("[rdfManager] worker emitAllSubjects failed", err);
          }
        }
        await (target as any).emitAllSubjects(graphName);
      };
    }

    if (prop === "triggerSubjectUpdate") {
      return async (subjects: string[]) => {
        if (workerEnabled) {
          try {
            if (Array.isArray(subjects) && subjects.length > 0) {
              await callWorker("triggerSubjects", {
                subjects: subjects.map((s) => String(s)),
              });
            }
            return;
          } catch (err) {
            console.error("[rdfManager] worker triggerSubjects failed", err);
          }
        }
        await (target as any).triggerSubjectUpdate(subjects);
      };
    }

    if (prop === "runReasoning") {
      return async (options?: { rulesets?: string[] }) => {
        if (workerEnabled && workerClient) {
          const start = Date.now();
          const id = `reasoning-${start.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

          let configuredRulesets: string[] = [];
          try {
            if (
              typeof useAppConfigStore !== "undefined" &&
              (useAppConfigStore as any).getState
            ) {
              const st = (useAppConfigStore as any).getState();
              if (st && st.config && Array.isArray(st.config.reasoningRulesets)) {
                configuredRulesets = st.config.reasoningRulesets
                  .map((r: any) => String(r))
                  .filter((r: string) => r.length > 0);
              }
            }
          } catch (_) {
            configuredRulesets = [];
          }

          const requestedRulesets = Array.isArray(options?.rulesets)
            ? options!.rulesets.map((r) => String(r)).filter((r) => r.length > 0)
            : [];

          const rulesets =
            requestedRulesets.length > 0 ? requestedRulesets : configuredRulesets;

          let baseUrl = "/";
          try {
            const maybe = (import.meta as any)?.env?.BASE_URL;
            if (typeof maybe === "string" && maybe.length > 0) {
              baseUrl = maybe;
            }
          } catch (_) {
            try {
              if (typeof window !== "undefined" && window.location) {
                baseUrl = "/";
              }
            } catch (_) {
              /* ignore */
            }
          }

          const runStartMs = Date.now();
          try {
            const raw = (await workerClient.call("runReasoning", {
              reasoningId: id,
              rulesets,
              baseUrl,
              emitSubjects: true,
            })) as any;

            const warningsRaw = Array.isArray(raw?.warnings) ? raw.warnings : [];
            const errorsRaw = Array.isArray(raw?.errors) ? raw.errors : [];
            const inferencesRaw = Array.isArray(raw?.inferences) ? raw.inferences : [];

            const safeWarnings: ReasoningWarning[] = warningsRaw.map((w: any) => ({
              nodeId: w && w.nodeId ? String(w.nodeId) : undefined,
              edgeId: w && w.edgeId ? String(w.edgeId) : undefined,
              message: w && w.message ? String(w.message) : "",
              rule: w && w.rule ? String(w.rule) : "rule",
              severity: w && w.severity ? (w.severity as ReasoningWarning["severity"]) : undefined,
            }));

            const safeErrors: ReasoningError[] = errorsRaw.map((e: any) => ({
              nodeId: e && e.nodeId ? String(e.nodeId) : undefined,
              edgeId: e && e.edgeId ? String(e.edgeId) : undefined,
              message: e && e.message ? String(e.message) : "",
              rule: e && e.rule ? String(e.rule) : "rule",
              severity:
                e && e.severity === "error" ? "error" : ("critical" as ReasoningError["severity"]),
            }));

            const safeInferences: ReasoningInference[] = inferencesRaw
              .map((inf: any) => {
                const type =
                  inf && (inf.type === "class" || inf.type === "relationship" || inf.type === "property")
                    ? inf.type
                    : "relationship";
                const subject = inf && inf.subject ? String(inf.subject) : "";
                const predicate = inf && inf.predicate ? String(inf.predicate) : "";
                const object = inf && inf.object ? String(inf.object) : "";
                const confidence =
                  inf && typeof inf.confidence === "number" ? Number(inf.confidence) : 0.5;
                return { type, subject, predicate, object, confidence };
              })
              .filter((inf: ReasoningInference) => inf.subject && inf.predicate);

            const workerDuration =
              typeof raw?.workerDurationMs === "number" ? Number(raw.workerDurationMs) : null;
            const totalDuration = Date.now() - runStartMs;

            const completed: ReasoningResult = {
              id,
              timestamp: typeof raw?.startedAt === "number" ? Number(raw.startedAt) : start,
              status: "completed",
              duration: totalDuration,
              errors: safeErrors,
              warnings: safeWarnings,
              inferences: safeInferences,
              meta: {
                usedReasoner: Boolean(raw?.usedReasoner),
                workerDurationMs: workerDuration ?? undefined,
                totalDurationMs: totalDuration,
                addedCount: typeof raw?.addedCount === "number" ? Number(raw.addedCount) : undefined,
                ruleQuadCount:
                  typeof raw?.ruleQuadCount === "number" ? Number(raw.ruleQuadCount) : undefined,
              },
            };

            try {
              const summary = {
                id: completed.id,
                status: completed.status,
                durationMs: totalDuration,
                workerDurationMs: workerDuration,
                errorCount: completed.errors.length,
                warningCount: completed.warnings.length,
                inferenceCount: completed.inferences.length,
                usedReasoner: completed.meta?.usedReasoner ?? null,
                addedCount: completed.meta?.addedCount ?? null,
              };
              console.log("[VG_REASONING] completed reasoning run", summary);
            } catch (_) {
              /* ignore console errors */
            }

            return completed;
          } catch (err) {
            console.error("[rdfManager] worker runReasoning failed, falling back to local store", err);
            // fall through to local execution below
          }
        }

        return (target as any).runReasoning(options);
      };
    }

    if (prop === "loadRDFIntoGraph") {
      return async (
        rdfContent: string,
        graphName?: string,
        mimeType?: string,
        filename?: string,
      ) => {
        await (target as any).loadRDFIntoGraph(rdfContent, graphName, mimeType, filename);
        if (workerEnabled) {
          try {
            const gName = String(graphName || "urn:vg:data");
            const quads = collectPlainQuadsFromGraph(gName).map(plainQuadToWorkerQuad);
            const namespaces =
              (target as any).getNamespaces && typeof (target as any).getNamespaces === "function"
                ? (target as any).getNamespaces()
                : {};
            await callWorker("syncLoad", {
              graphName: gName,
              quads,
              prefixes: namespaces,
              parsingMeta: { source: "loadRDFIntoGraph", mimeType, filename },
            });
          } catch (err) {
            console.error("[rdfManager] worker syncLoad failed", err);
          }
        }
      };
    }

    if (prop === "loadRDFFromUrl") {
      return async (
        url: string,
        graphName?: string,
        options?: { timeoutMs?: number; useWorker?: boolean },
      ) => {
        await (target as any).loadRDFFromUrl(url, graphName, options);
        if (workerEnabled) {
          try {
            const gName = String(graphName || "urn:vg:data");
            const quads = collectPlainQuadsFromGraph(gName).map(plainQuadToWorkerQuad);
            const namespaces =
              (target as any).getNamespaces && typeof (target as any).getNamespaces === "function"
                ? (target as any).getNamespaces()
                : {};
            await callWorker("syncLoad", {
              graphName: gName,
              quads,
              prefixes: namespaces,
              parsingMeta: { source: "loadRDFFromUrl", url },
            });
          } catch (err) {
            console.error("[rdfManager] worker syncLoad after loadRDFFromUrl failed", err);
          }
        }
      };
    }

    if (prop === "fetchQuadsPage") {
      return async (
        graphName: string,
        offset: number,
        limit: number,
        options?: { serialize?: boolean; fields?: ("subject" | "predicate" | "object" | "graph")[]; filter?: { subject?: string; predicate?: string; object?: string } },
      ) => {
        const localResult = await (target as any).fetchQuadsPage(graphName, offset, limit, options);
        if (!workerEnabled) return localResult;
        try {
          const payload: RDFWorkerCommandPayloads["fetchQuadsPage"] = {
            graphName: String(graphName || "urn:vg:data"),
            offset: Number(offset) || 0,
            limit: Number(limit) || 0,
            serialize: options && typeof options.serialize === "boolean" ? options.serialize : true,
          };
          if (options && options.filter) {
            payload.filter = {
              subject:
                typeof options.filter.subject === "string"
                  ? options.filter.subject
                  : undefined,
              predicate:
                typeof options.filter.predicate === "string"
                  ? options.filter.predicate
                  : undefined,
              object:
                typeof options.filter.object === "string"
                  ? options.filter.object
                  : undefined,
            };
          }
          const workerResult = await callWorker("fetchQuadsPage", payload);
          if (workerResult && typeof workerResult === "object") {
            return workerResult as typeof localResult;
          }
        } catch (err) {
          console.error("[rdfManager] worker fetchQuadsPage failed", err);
        }
        return localResult;
      };
    }

    const value = Reflect.get(target, prop, receiver);
    if (typeof value === "function") {
      return value.bind(target);
    }
    return value;
  },
};

export const rdfManager = new Proxy(baseManager, rdfManagerProxyHandler) as RDFManagerInstance;
