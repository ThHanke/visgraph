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
import type { RDFWorkerCommandName, RDFWorkerCommandPayloads } from "./rdfManager.workerProtocol";
import {
  isWorkerQuad,
  isWorkerTerm,
  serializeQuad,
  serializeTerm,
  type WorkerLiteral,
  type WorkerNamedNode,
  type WorkerQuad,
  type WorkerQuadUpdate,
  type WorkerTerm,
} from "./rdfSerialization";
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

type TermContext = "subject" | "predicate" | "object" | "graph";

const sanitizeBlankNodeValue = (value: string): string => value.replace(/^_:/, "");

const cloneLiteral = (source: WorkerLiteral): WorkerLiteral => {
  const literal: WorkerLiteral = { termType: "Literal", value: String(source.value ?? "") };
  if (source.language) literal.language = source.language;
  if (source.datatype) literal.datatype = source.datatype;
  return literal;
};

const normalizeWorkerTerm = (term: WorkerTerm, context: TermContext): WorkerTerm => {
  const value = typeof term.value === "string" ? term.value : "";
  switch (term.termType) {
    case "NamedNode":
      return { termType: "NamedNode", value };
    case "BlankNode": {
      const sanitized = sanitizeBlankNodeValue(value);
      if (context === "predicate" || context === "graph") {
        return { termType: "NamedNode", value: sanitized || value };
      }
      return { termType: "BlankNode", value: sanitized };
    }
    case "Literal":
      if (context === "subject" || context === "predicate" || context === "graph") {
        return { termType: "NamedNode", value };
      }
      return cloneLiteral(term as WorkerLiteral);
    case "DefaultGraph":
    default:
      if (context === "graph") return { termType: "DefaultGraph" };
      if (context === "object") return { termType: "Literal", value: value || "" };
      return { termType: "NamedNode", value: value || "" };
  }
};

const extractDatatype = (input: unknown): string | undefined => {
  if (!input) return undefined;
  if (typeof input === "string") return input;
  if (typeof input === "object" && typeof (input as any).value === "string") {
    return String((input as any).value);
  }
  return undefined;
};

const coerceWorkerTerm = (value: any, context: TermContext): WorkerTerm | null => {
  if (value === null || typeof value === "undefined") {
    if (context === "graph") return { termType: "DefaultGraph" };
    if (context === "object") return null;
    return null;
  }

  if (isWorkerTerm(value)) {
    const next: WorkerTerm =
      value.termType === "BlankNode"
        ? { ...value, value: sanitizeBlankNodeValue(value.value) }
        : { ...value };
    return normalizeWorkerTerm(next, context);
  }

  if (isRdfTerm(value)) {
    try {
      return normalizeWorkerTerm(serializeTerm(value as any), context);
    } catch (err) {
      console.error("[rdfManager] serializeTerm failed", err);
      return null;
    }
  }

  if (typeof value === "object") {
    const termType =
      typeof (value as any).termType === "string"
        ? String((value as any).termType)
        : undefined;
    if (termType) {
      return normalizeWorkerTerm(value as WorkerTerm, context);
    }

    if ("value" in (value as any)) {
      const raw = String((value as any).value ?? "");
      const typeHint =
        typeof (value as any).type === "string"
          ? String((value as any).type).toLowerCase()
          : "";
      const datatype = extractDatatype((value as any).datatype);
      const language =
        typeof (value as any).language === "string"
          ? String((value as any).language)
          : typeof (value as any).lang === "string"
            ? String((value as any).lang)
            : undefined;

      if (context === "object") {
        if (typeHint === "iri" || typeHint === "namednode") {
          return normalizeWorkerTerm({ termType: "NamedNode", value: raw }, context);
        }
        if (typeHint === "bnode" || typeHint === "blank" || typeHint === "blanknode") {
          return normalizeWorkerTerm({ termType: "BlankNode", value: raw }, context);
        }
        if (typeHint === "literal" || typeHint === "lit" || datatype || language) {
          const literal: WorkerLiteral = { termType: "Literal", value: raw };
          if (datatype) literal.datatype = datatype;
          if (language) literal.language = language;
          return normalizeWorkerTerm(literal, context);
        }
        if (/^_:/i.test(raw)) {
          return normalizeWorkerTerm({ termType: "BlankNode", value: raw }, context);
        }
        if (IRI_REGEX.test(raw)) {
          return normalizeWorkerTerm({ termType: "NamedNode", value: raw }, context);
        }
        const literal: WorkerLiteral = { termType: "Literal", value: raw };
        if (datatype) literal.datatype = datatype;
        if (language) literal.language = language;
        return normalizeWorkerTerm(literal, context);
      }

      if (context === "graph") {
        if (typeHint === "defaultgraph" || raw === "default") {
          return { termType: "DefaultGraph" };
        }
        if (typeHint === "bnode" || typeHint === "blank" || typeHint === "blanknode") {
          return normalizeWorkerTerm({ termType: "BlankNode", value: raw }, context);
        }
        return normalizeWorkerTerm({ termType: "NamedNode", value: raw }, context);
      }

      if (context === "subject") {
        if (typeHint === "bnode" || /^_:/i.test(raw)) {
          return normalizeWorkerTerm({ termType: "BlankNode", value: raw }, context);
        }
        return normalizeWorkerTerm({ termType: "NamedNode", value: raw }, context);
      }

      if (context === "predicate") {
        return normalizeWorkerTerm({ termType: "NamedNode", value: raw }, context);
      }
    }
  }

  const str = String(value ?? "").trim();
  if (!str) {
    if (context === "graph") return { termType: "DefaultGraph" };
    if (context === "object") return null;
    return null;
  }

  if (context === "object") {
    if (/^_:/i.test(str)) {
      return normalizeWorkerTerm({ termType: "BlankNode", value: str }, context);
    }
    if (IRI_REGEX.test(str)) {
      return normalizeWorkerTerm({ termType: "NamedNode", value: str }, context);
    }
    return normalizeWorkerTerm({ termType: "Literal", value: str }, context);
  }

  if (context === "graph") {
    if (str === "default") return { termType: "DefaultGraph" };
    return normalizeWorkerTerm({ termType: "NamedNode", value: str }, context);
  }

  if (context === "subject") {
    if (/^_:/i.test(str)) {
      return normalizeWorkerTerm({ termType: "BlankNode", value: str }, context);
    }
    return normalizeWorkerTerm({ termType: "NamedNode", value: str }, context);
  }

  return normalizeWorkerTerm({ termType: "NamedNode", value: str }, context);
};

const toWorkerSubjectTerm = (value: any): WorkerTerm | null => coerceWorkerTerm(value, "subject");

const toWorkerPredicateTerm = (value: any): WorkerNamedNode | null => {
  const term = coerceWorkerTerm(value, "predicate");
  if (!term) return null;
  return {
    termType: "NamedNode",
    value: typeof term.value === "string" ? term.value : "",
  };
};

const toWorkerObjectTerm = (value: any): WorkerTerm | null => coerceWorkerTerm(value, "object");

const toWorkerGraphTerm = (value: any, fallbackGraph: string): WorkerTerm => {
  const raw = typeof value === "undefined" || value === null ? fallbackGraph : value;
  const term = coerceWorkerTerm(raw, "graph");
  if (!term) {
    if (fallbackGraph === "default") return { termType: "DefaultGraph" };
    return {
      termType: "NamedNode",
      value: String(fallbackGraph || "urn:vg:data"),
    };
  }
  if (term.termType === "NamedNode") {
    return {
      termType: "NamedNode",
      value: term.value || String(fallbackGraph || "urn:vg:data"),
    };
  }
  if (term.termType === "DefaultGraph") {
    if (typeof raw === "string" && raw !== "default" && raw.length > 0) {
      return { termType: "NamedNode", value: raw };
    }
    if (fallbackGraph && fallbackGraph !== "default") {
      return { termType: "NamedNode", value: fallbackGraph };
    }
    return { termType: "DefaultGraph" };
  }
  return {
    termType: "NamedNode",
    value: term.value || String(fallbackGraph || "urn:vg:data"),
  };
};

const collectWorkerQuadsFromGraph = (graphName: string): WorkerQuad[] => {
  try {
    const store = (baseManager as any).getStore?.();
    if (!store || typeof store.getQuads !== "function") return [];
    const graphArg = graphName && graphName !== "default" ? graphName : null;
    const quads = store.getQuads(null, null, null, graphArg) || [];
    const serialized: WorkerQuad[] = [];
    for (const q of quads) {
      try {
        const worker = serializeQuad(q);
        if (
          graphName &&
          graphName !== "default" &&
          worker.graph.termType === "DefaultGraph"
        ) {
          serialized.push({
            ...worker,
            graph: { termType: "NamedNode", value: graphName },
          });
        } else {
          serialized.push(worker);
        }
      } catch (err) {
        console.error("[rdfManager] collectWorkerQuadsFromGraph serialize failed", err);
      }
    }
    return serialized;
  } catch (err) {
    console.error("[rdfManager] collectWorkerQuadsFromGraph failed", err);
    return [];
  }
};

const buildWorkerBatchPayload = (
  changes: { removes?: any[]; adds?: any[] },
  graphName: string,
): RDFWorkerCommandPayloads["syncBatch"] => {
  const graph = graphName || "urn:vg:data";
  const adds: WorkerQuad[] = [];
  const removes: WorkerQuadUpdate[] = [];

  if (changes && Array.isArray(changes.adds)) {
    for (const entry of changes.adds) {
      try {
        const subject = toWorkerSubjectTerm(entry?.subject ?? entry?.s);
        const predicate = toWorkerPredicateTerm(entry?.predicate ?? entry?.p);
        if (!subject || !predicate) continue;
        const objectTerm = toWorkerObjectTerm(entry?.object ?? entry?.o ?? entry?.value);
        if (!objectTerm) continue;
        const graphTerm = toWorkerGraphTerm(entry?.graph ?? entry?.g, graph);
        adds.push({
          subject,
          predicate,
          object: objectTerm,
          graph: graphTerm,
        });
      } catch (err) {
        console.error("[rdfManager] buildWorkerBatchPayload.add failed", err);
      }
    }
  }

  if (changes && Array.isArray(changes.removes)) {
    for (const entry of changes.removes) {
      try {
        const subject = toWorkerSubjectTerm(entry?.subject ?? entry?.s);
        const predicate = toWorkerPredicateTerm(entry?.predicate ?? entry?.p);
        if (!subject || !predicate) continue;
        const graphTerm = toWorkerGraphTerm(entry?.graph ?? entry?.g, graph);
        const objectSource = entry?.object ?? entry?.o ?? entry?.value;
        const hasObject =
          !(objectSource === null || typeof objectSource === "undefined" || objectSource === "");
        const update: WorkerQuadUpdate = {
          subject,
          predicate,
          graph: graphTerm,
        };
        if (hasObject) {
          const objectTerm = toWorkerObjectTerm(objectSource);
          if (objectTerm) update.object = objectTerm;
        }
        removes.push(update);
      } catch (err) {
        console.error("[rdfManager] buildWorkerBatchPayload.remove failed", err);
      }
    }
  }

  const payload: RDFWorkerCommandPayloads["syncBatch"] = {
    graphName: graph,
    adds,
    removes,
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
  let payload = quads;

  if (Array.isArray(quads)) {
    const alreadyWorker = quads.every((item) => isWorkerQuad(item));
    if (!alreadyWorker) {
      const converted: WorkerQuad[] = [];
      for (const item of quads) {
        try {
          if (
            item &&
            typeof item === "object" &&
            isRdfTerm((item as any).subject) &&
            isRdfTerm((item as any).predicate) &&
            isRdfTerm((item as any).object) &&
            isRdfTerm((item as any).graph)
          ) {
            converted.push(serializeQuad(item as any));
            continue;
          }
          if (isWorkerQuad(item)) {
            converted.push(item);
          }
        } catch (err) {
          console.error("[rdfManager] localSubjectsForwarder serialize failed", err);
        }
      }
      if (converted.length > 0) {
        payload = converted;
      }
    }
  }

  for (const cb of Array.from(subjectsSubscribers)) {
    try {
      (cb as any)(subjects, payload);
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
    let quadPayload: WorkerQuad[] | undefined;

    if (Array.isArray(payload?.quads)) {
      quadPayload = payload.quads as WorkerQuad[];
    } else if (payload?.quads && typeof payload.quads === "object") {
      const aggregated: WorkerQuad[] = [];
      for (const value of Object.values(payload.quads as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (isWorkerQuad(item)) {
              aggregated.push(item);
            }
          }
        }
      }
      if (aggregated.length > 0) {
        quadPayload = aggregated;
      }
    }

    localSubjectsForwarder(subjects, quadPayload);
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
            const quads = collectWorkerQuadsFromGraph(gName);
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
            const quads = collectWorkerQuadsFromGraph(gName);
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
