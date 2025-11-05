import type { WorkerQuad, WorkerTerm } from "./rdfSerialization";
import type {
  ReasoningError,
  ReasoningInference,
  ReasoningResult,
  ReasoningWarning,
} from "./reasoningTypes";

export type PlainQuadTerm =
  | { t: "iri"; v: string }
  | { t: "bnode"; v: string }
  | { t: "lit"; v: string; dt?: string; ln?: string };

export interface PlainQuad {
  s: string;
  p: string;
  o?: PlainQuadTerm | null;
  g?: string;
}

export interface SyncNamespacesPayload {
  namespaces: Record<string, string>;
}

export interface SyncBlacklistPayload {
  prefixes: string[];
  uris: string[];
}

export interface SyncBatchPayload {
  graphName: string;
  adds: WorkerQuad[];
  removes: WorkerQuad[];
  options?: { suppressSubjects?: boolean };
}

export interface SyncLoadPayload {
  quads: WorkerQuad[];
  graphName: string;
  prefixes?: Record<string, string>;
  parsingMeta?: Record<string, unknown>;
}

export interface SyncRemoveGraphPayload {
  graphName: string;
}

export interface SyncRemoveAllQuadsForIriPayload {
  iri: string;
  graphName?: string;
  includePredicate?: boolean;
}

export interface FetchQuadsPagePayload {
  graphName: string;
  offset: number;
  limit: number;
  serialize?: boolean;
  filter?: { subject?: string; predicate?: string; object?: string };
}

export interface GetQuadsPayload {
  subject?: string | null;
  predicate?: string | null;
  object?: WorkerTerm | null;
  graphName?: string | null;
}

export interface TriggerSubjectsPayload {
  subjects: string[];
}

export interface EmitAllSubjectsPayload {
  graphName?: string;
}

export type RDFWorkerCommandPayloads = {
  ping: undefined;
  clear: undefined;
  getGraphCounts: undefined;
  getNamespaces: undefined;
  setNamespaces: SyncNamespacesPayload;
  setBlacklist: SyncBlacklistPayload;
  getBlacklist: undefined;
  syncBatch: SyncBatchPayload;
  syncLoad: SyncLoadPayload;
  syncRemoveGraph: SyncRemoveGraphPayload;
  syncRemoveAllQuadsForIri: SyncRemoveAllQuadsForIriPayload;
  fetchQuadsPage: FetchQuadsPagePayload;
  getQuads: GetQuadsPayload;
  emitAllSubjects: EmitAllSubjectsPayload;
  triggerSubjects: TriggerSubjectsPayload;
  runReasoning: {
    reasoningId: string;
    quads?: WorkerQuad[];
    rulesets?: string[];
    baseUrl?: string;
    emitSubjects?: boolean;
  };
};

export type RDFWorkerCommandName = keyof RDFWorkerCommandPayloads;

export interface RDFWorkerCommand<C extends RDFWorkerCommandName = RDFWorkerCommandName> {
  type: "command";
  id: string;
  command: C;
  args?: RDFWorkerCommandPayloads[C] extends undefined ? undefined : [RDFWorkerCommandPayloads[C]];
}

export type RDFWorkerResponse =
  | { type: "response"; id: string; ok: true; result?: unknown }
  | { type: "response"; id: string; ok: false; error: string; stack?: string };

export type RDFWorkerEvent =
  | {
      type: "event";
      event: "change";
      payload: { changeCount: number; meta?: Record<string, unknown> | null };
    }
  | {
      type: "event";
      event: "subjects";
      payload: { subjects: string[]; quads?: Record<string, PlainQuad[]> };
    }
  | {
      type: "event";
      event: "reasoningStage";
      payload: { id: string; stage: string; meta?: Record<string, unknown> };
    }
  | {
      type: "event";
      event: "reasoningResult";
      payload: ReasoningResult;
    }
  | {
      type: "event";
      event: "reasoningError";
      payload: { message: string; stack?: string };
    };

export type RDFWorkerMessage = RDFWorkerCommand | RDFWorkerResponse | RDFWorkerEvent;

export interface RDFWorkerSubscriptionRequest {
  type: "subscribe";
  id: string;
  event: "change" | "subjects";
}

export interface RDFWorkerUnsubscribeRequest {
  type: "unsubscribe";
  id: string;
  event: "change" | "subjects";
}
