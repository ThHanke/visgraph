import type { ReasoningResult } from "./reasoningTypes";
import type { WorkerQuad, WorkerQuadUpdate, WorkerTerm } from "./rdfSerialization";
import { isWorkerQuad, isWorkerQuadUpdate, isWorkerTerm } from "./rdfSerialization";
import {
  assertArray,
  assertBoolean,
  assertNumber,
  assertPlainObject,
  assertString,
  invariant,
  isPlainObject,
  isStringRecord,
} from "./guards";

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
  removes: WorkerQuadUpdate[];
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

export const RDF_WORKER_COMMANDS = [
  "ping",
  "clear",
  "getGraphCounts",
  "getNamespaces",
  "setNamespaces",
  "setBlacklist",
  "getBlacklist",
  "syncBatch",
  "syncLoad",
  "syncRemoveGraph",
  "syncRemoveAllQuadsForIri",
  "fetchQuadsPage",
  "getQuads",
  "emitAllSubjects",
  "triggerSubjects",
  "runReasoning",
] as const;

export type RDFWorkerCommandName = (typeof RDF_WORKER_COMMANDS)[number];

type PayloadFor<C extends RDFWorkerCommandName> = RDFWorkerCommandPayloads[C];

export type RDFWorkerCommand<C extends RDFWorkerCommandName = RDFWorkerCommandName> =
  PayloadFor<C> extends undefined
    ? { type: "command"; id: string; command: C; payload?: undefined }
    : { type: "command"; id: string; command: C; payload: PayloadFor<C> };

type CommandValidator = (payload: unknown) => void;

function assertWorkerQuadArray(value: unknown, message: string): asserts value is WorkerQuad[] {
  assertArray(value, message);
  for (const entry of value as unknown[]) {
    invariant(isWorkerQuad(entry), message, { entry });
  }
}

function assertWorkerQuadUpdateArray(
  value: unknown,
  message: string,
): asserts value is WorkerQuadUpdate[] {
  assertArray(value, message);
  for (const entry of value as unknown[]) {
    invariant(isWorkerQuadUpdate(entry), message, { entry });
  }
}

function assertOptionalStringRecord(value: unknown, message: string) {
  if (typeof value === "undefined") return;
  invariant(isStringRecord(value), message, { value });
}

function assertOptionalPlainObject(value: unknown, message: string) {
  if (typeof value === "undefined") return;
  assertPlainObject(value, message);
}

function assertStringArray(value: unknown, message: string): asserts value is string[] {
  assertArray(value, message);
  for (const entry of value as unknown[]) {
    assertString(entry, message);
  }
}

function assertOptionalString(value: unknown, message: string) {
  if (typeof value === "undefined" || value === null) return;
  assertString(value, message);
}

function assertOptionalFiniteNumber(value: unknown, message: string) {
  if (typeof value === "undefined" || value === null) return;
  assertNumber(value, message);
}

function assertWorkerQuadRecord(
  value: unknown,
  message: string,
): asserts value is Record<string, WorkerQuad[]> {
  assertPlainObject(value, message);
  for (const [graphName, entries] of Object.entries(value as Record<string, unknown>)) {
    assertString(graphName, `${message} (invalid graph key)`);
    assertWorkerQuadArray(entries, `${message} (invalid quad array)`);
  }
}

function assertReasoningError(
  value: unknown,
  message: string,
): asserts value is ReasoningResult["errors"][number] {
  assertPlainObject(value, message);
  const payload = value as Record<string, unknown>;
  assertString(payload.message, `${message}.message must be a string`);
  assertString(payload.rule, `${message}.rule must be a string`);
  assertOptionalString(payload.nodeId, `${message}.nodeId must be a string when provided`);
  assertOptionalString(payload.edgeId, `${message}.edgeId must be a string when provided`);
  if (payload.severity !== "critical" && payload.severity !== "error") {
    throw new Error(`${message}.severity must equal 'critical' or 'error'`);
  }
}

function assertReasoningWarning(
  value: unknown,
  message: string,
): asserts value is ReasoningResult["warnings"][number] {
  assertPlainObject(value, message);
  const payload = value as Record<string, unknown>;
  assertString(payload.message, `${message}.message must be a string`);
  assertString(payload.rule, `${message}.rule must be a string`);
  assertOptionalString(payload.nodeId, `${message}.nodeId must be a string when provided`);
  assertOptionalString(payload.edgeId, `${message}.edgeId must be a string when provided`);
  if (typeof payload.severity !== "undefined") {
    const severity = payload.severity;
    if (severity !== "critical" && severity !== "warning" && severity !== "info") {
      throw new Error(`${message}.severity must be one of 'critical' | 'warning' | 'info'`);
    }
  }
}

function assertReasoningInference(
  value: unknown,
  message: string,
): asserts value is ReasoningResult["inferences"][number] {
  assertPlainObject(value, message);
  const payload = value as Record<string, unknown>;
  if (payload.type !== "property" && payload.type !== "class" && payload.type !== "relationship") {
    throw new Error(`${message}.type must be one of 'property' | 'class' | 'relationship'`);
  }
  assertString(payload.subject, `${message}.subject must be a string`);
  assertString(payload.predicate, `${message}.predicate must be a string`);
  assertString(payload.object, `${message}.object must be a string`);
  assertNumber(payload.confidence, `${message}.confidence must be a finite number`);
}

function assertReasoningResult(
  value: unknown,
  message: string,
): asserts value is ReasoningResult {
  assertPlainObject(value, message);
  const payload = value as Record<string, unknown>;
  assertString(payload.id, `${message}.id must be a string`);
  assertNumber(payload.timestamp, `${message}.timestamp must be a finite number`);
  if (payload.status !== "running" && payload.status !== "completed" && payload.status !== "error") {
    throw new Error(`${message}.status must be one of 'running' | 'completed' | 'error'`);
  }
  assertOptionalFiniteNumber(payload.duration, `${message}.duration must be a finite number when provided`);
  assertArray(payload.errors, `${message}.errors must be an array`);
  for (const entry of payload.errors as unknown[]) {
    assertReasoningError(entry, `${message}.errors entry`);
  }
  assertArray(payload.warnings, `${message}.warnings must be an array`);
  for (const entry of payload.warnings as unknown[]) {
    assertReasoningWarning(entry, `${message}.warnings entry`);
  }
  assertArray(payload.inferences, `${message}.inferences must be an array`);
  for (const entry of payload.inferences as unknown[]) {
    assertReasoningInference(entry, `${message}.inferences entry`);
  }
  if (typeof payload.inferredQuads !== "undefined") {
    assertArray(payload.inferredQuads, `${message}.inferredQuads must be an array when provided`);
    for (const entry of payload.inferredQuads as unknown[]) {
      assertPlainObject(entry, `${message}.inferredQuads entry must be an object`);
      const quad = entry as Record<string, unknown>;
      assertString(quad.subject, `${message}.inferredQuads entry.subject must be a string`);
      assertString(quad.predicate, `${message}.inferredQuads entry.predicate must be a string`);
      assertString(quad.object, `${message}.inferredQuads entry.object must be a string`);
      if (typeof quad.graph !== "undefined") {
        assertString(quad.graph, `${message}.inferredQuads entry.graph must be a string when provided`);
      }
    }
  }
  if (typeof payload.meta !== "undefined") {
    assertPlainObject(payload.meta, `${message}.meta must be an object when provided`);
    const meta = payload.meta as Record<string, unknown>;
    if (typeof meta.usedReasoner !== "undefined") {
      assertBoolean(meta.usedReasoner, `${message}.meta.usedReasoner must be a boolean when provided`);
    }
    if (typeof meta.workerDurationMs !== "undefined") {
      assertNumber(
        meta.workerDurationMs,
        `${message}.meta.workerDurationMs must be a finite number when provided`,
      );
    }
    if (typeof meta.totalDurationMs !== "undefined") {
      assertNumber(
        meta.totalDurationMs,
        `${message}.meta.totalDurationMs must be a finite number when provided`,
      );
    }
    if (typeof meta.addedCount !== "undefined") {
      assertNumber(meta.addedCount, `${message}.meta.addedCount must be a finite number when provided`);
    }
    if (typeof meta.ruleQuadCount !== "undefined") {
      assertNumber(
        meta.ruleQuadCount,
        `${message}.meta.ruleQuadCount must be a finite number when provided`,
      );
    }
  }
}

const COMMAND_VALIDATORS: Record<RDFWorkerCommandName, CommandValidator> = {
  ping(payload) {
    invariant(typeof payload === "undefined", "ping payload must be undefined");
  },
  clear(payload) {
    invariant(typeof payload === "undefined", "clear payload must be undefined");
  },
  getGraphCounts(payload) {
    invariant(typeof payload === "undefined", "getGraphCounts payload must be undefined");
  },
  getNamespaces(payload) {
    invariant(typeof payload === "undefined", "getNamespaces payload must be undefined");
  },
  setNamespaces(payload) {
    assertPlainObject(payload, "setNamespaces payload must be an object");
    const { namespaces } = payload as SyncNamespacesPayload;
    invariant(isStringRecord(namespaces), "setNamespaces.namespaces must be a string record", {
      namespaces,
    });
  },
  setBlacklist(payload) {
    assertPlainObject(payload, "setBlacklist payload must be an object");
    const { prefixes, uris } = payload as SyncBlacklistPayload;
    assertArray(prefixes, "setBlacklist.prefixes must be an array");
    assertArray(uris, "setBlacklist.uris must be an array");
    for (const prefix of prefixes as unknown[]) {
      assertString(prefix, "setBlacklist.prefixes entries must be strings");
    }
    for (const uri of uris as unknown[]) {
      assertString(uri, "setBlacklist.uris entries must be strings");
    }
  },
  getBlacklist(payload) {
    invariant(typeof payload === "undefined", "getBlacklist payload must be undefined");
  },
  syncBatch(payload) {
    assertPlainObject(payload, "syncBatch payload must be an object");
    const { graphName, adds, removes, options } = payload as SyncBatchPayload;
    assertString(graphName, "syncBatch.graphName must be a string");
    assertWorkerQuadArray(adds, "syncBatch.adds must contain WorkerQuad entries");
    assertWorkerQuadUpdateArray(removes, "syncBatch.removes must contain WorkerQuadUpdate entries");
    if (typeof options !== "undefined") {
      assertPlainObject(options, "syncBatch.options must be an object");
      if (typeof (options as { suppressSubjects?: unknown }).suppressSubjects !== "undefined") {
        assertBoolean(
          (options as { suppressSubjects?: unknown }).suppressSubjects,
          "syncBatch.options.suppressSubjects must be a boolean",
        );
      }
    }
  },
  syncLoad(payload) {
    assertPlainObject(payload, "syncLoad payload must be an object");
    const { quads, graphName, prefixes, parsingMeta } = payload as SyncLoadPayload;
    assertWorkerQuadArray(quads, "syncLoad.quads must contain WorkerQuad entries");
    assertString(graphName, "syncLoad.graphName must be a string");
    assertOptionalStringRecord(prefixes, "syncLoad.prefixes must be a string record when provided");
    assertOptionalPlainObject(parsingMeta, "syncLoad.parsingMeta must be an object when provided");
  },
  syncRemoveGraph(payload) {
    assertPlainObject(payload, "syncRemoveGraph payload must be an object");
    const { graphName } = payload as SyncRemoveGraphPayload;
    assertString(graphName, "syncRemoveGraph.graphName must be a string");
  },
  syncRemoveAllQuadsForIri(payload) {
    assertPlainObject(payload, "syncRemoveAllQuadsForIri payload must be an object");
    const { iri, graphName, includePredicate } = payload as SyncRemoveAllQuadsForIriPayload;
    assertString(iri, "syncRemoveAllQuadsForIri.iri must be a string");
    if (typeof graphName !== "undefined") {
      assertString(graphName, "syncRemoveAllQuadsForIri.graphName must be a string when provided");
    }
    if (typeof includePredicate !== "undefined") {
      assertBoolean(
        includePredicate,
        "syncRemoveAllQuadsForIri.includePredicate must be a boolean when provided",
      );
    }
  },
  fetchQuadsPage(payload) {
    assertPlainObject(payload, "fetchQuadsPage payload must be an object");
    const { graphName, offset, limit, serialize, filter } = payload as FetchQuadsPagePayload;
    assertString(graphName, "fetchQuadsPage.graphName must be a string");
    assertNumber(offset, "fetchQuadsPage.offset must be a finite number");
    assertNumber(limit, "fetchQuadsPage.limit must be a finite number");
    if (typeof serialize !== "undefined") {
      assertBoolean(serialize, "fetchQuadsPage.serialize must be a boolean when provided");
    }
    if (typeof filter !== "undefined") {
      assertPlainObject(filter, "fetchQuadsPage.filter must be an object when provided");
      const { subject, predicate, object } = filter as FetchQuadsPagePayload["filter"];
      if (typeof subject !== "undefined") {
        assertString(subject, "fetchQuadsPage.filter.subject must be a string when provided");
      }
      if (typeof predicate !== "undefined") {
        assertString(predicate, "fetchQuadsPage.filter.predicate must be a string when provided");
      }
      if (typeof object !== "undefined") {
        assertString(object, "fetchQuadsPage.filter.object must be a string when provided");
      }
    }
  },
  getQuads(payload) {
    assertPlainObject(payload, "getQuads payload must be an object");
    const { subject, predicate, object, graphName } = payload as GetQuadsPayload;
    if (typeof subject !== "undefined" && subject !== null) {
      assertString(subject, "getQuads.subject must be a string when provided");
    }
    if (typeof predicate !== "undefined" && predicate !== null) {
      assertString(predicate, "getQuads.predicate must be a string when provided");
    }
    if (typeof object !== "undefined" && object !== null) {
      invariant(isWorkerTerm(object), "getQuads.object must be a WorkerTerm when provided", {
        object,
      });
    }
    if (typeof graphName !== "undefined" && graphName !== null) {
      assertString(graphName, "getQuads.graphName must be a string when provided");
    }
  },
  emitAllSubjects(payload) {
    if (typeof payload === "undefined") return;
    assertPlainObject(payload, "emitAllSubjects payload must be an object when provided");
    const { graphName } = payload as EmitAllSubjectsPayload;
    if (typeof graphName !== "undefined") {
      assertString(graphName, "emitAllSubjects.graphName must be a string when provided");
    }
  },
  triggerSubjects(payload) {
    assertPlainObject(payload, "triggerSubjects payload must be an object");
    const { subjects } = payload as TriggerSubjectsPayload;
    assertArray(subjects, "triggerSubjects.subjects must be an array");
    for (const subject of subjects as unknown[]) {
      assertString(subject, "triggerSubjects.subjects entries must be strings");
    }
  },
  runReasoning(payload) {
    assertPlainObject(payload, "runReasoning payload must be an object");
    const { reasoningId, quads, rulesets, baseUrl, emitSubjects } =
      payload as RDFWorkerCommandPayloads["runReasoning"];
    assertString(reasoningId, "runReasoning.reasoningId must be a string");
    if (typeof quads !== "undefined") {
      assertWorkerQuadArray(quads, "runReasoning.quads must contain WorkerQuad entries");
    }
    if (typeof rulesets !== "undefined") {
      assertArray(rulesets, "runReasoning.rulesets must be an array when provided");
      for (const rule of rulesets as unknown[]) {
        assertString(rule, "runReasoning.rulesets entries must be strings");
      }
    }
    if (typeof baseUrl !== "undefined") {
      assertString(baseUrl, "runReasoning.baseUrl must be a string when provided");
    }
    if (typeof emitSubjects !== "undefined") {
      assertBoolean(emitSubjects, "runReasoning.emitSubjects must be a boolean when provided");
    }
  },
};

export function validateRdfWorkerCommandInput(
  command: RDFWorkerCommandName,
  payload: unknown,
): asserts payload is RDFWorkerCommandPayloads[RDFWorkerCommandName] {
  const validator = COMMAND_VALIDATORS[command];
  invariant(typeof validator === "function", "No validator registered for command", {
    command,
  });
  validator(payload);
}

export function assertRdfWorkerCommand(value: unknown): asserts value is RDFWorkerCommand {
  assertPlainObject(value, "rdf-worker-command must be a plain object");
  const message = value as Record<string, unknown>;

  invariant(message.type === "command", "rdf-worker-command.type must equal 'command'", {
    type: message.type,
  });
  assertString(message.id, "rdf-worker-command.id must be a string");
  assertString(message.command, "rdf-worker-command.command must be a string");

  invariant(
    (RDF_WORKER_COMMANDS as readonly string[]).includes(message.command),
    "rdf-worker-command.command is not recognised",
    { command: message.command },
  );

  const validator = COMMAND_VALIDATORS[message.command as RDFWorkerCommandName];
  invariant(typeof validator === "function", "No validator registered for command", {
    command: message.command,
  });
  validator(message.payload);
}

export type RDFWorkerEventMap = {
  change: { changeCount: number; meta?: Record<string, unknown> | null };
  subjects: { subjects: string[]; quads?: Record<string, WorkerQuad[]> };
  reasoningStage: { id: string; stage: string; meta?: Record<string, unknown> };
  reasoningResult: ReasoningResult;
  reasoningError: { message: string; stack?: string };
};

export type RDFWorkerEventName = keyof RDFWorkerEventMap;

export type RDFWorkerEvent = {
  [K in RDFWorkerEventName]: {
    type: "event";
    event: K;
    payload: RDFWorkerEventMap[K];
  };
}[RDFWorkerEventName];

export type RDFWorkerResponse =
  | { type: "response"; id: string; ok: true; result?: unknown }
  | { type: "response"; id: string; ok: false; error: string; stack?: string };

export interface RDFWorkerSubscriptionRequest {
  type: "subscribe";
  id: string;
  event: RDFWorkerEventName;
}

export interface RDFWorkerUnsubscribeRequest {
  type: "unsubscribe";
  id: string;
  event: RDFWorkerEventName;
}

export interface RDFWorkerAck {
  type: "ack";
  id: string;
}

export interface RDFWorkerLoadFromUrlMessage {
  type: "loadFromUrl";
  id: string;
  url: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export interface RDFWorkerRunReasoningMessage {
  type: "runReasoning";
  id: string;
  quads?: WorkerQuad[];
  rulesets?: string[];
  baseUrl?: string;
  emitSubjects?: boolean;
}

export type RDFWorkerInboundMessage =
  | RDFWorkerCommand
  | RDFWorkerSubscriptionRequest
  | RDFWorkerUnsubscribeRequest
  | RDFWorkerAck
  | RDFWorkerLoadFromUrlMessage
  | RDFWorkerRunReasoningMessage;

export type RDFWorkerOutboundMessage = RDFWorkerResponse | RDFWorkerEvent | RDFWorkerAck;

export type RDFWorkerMessage = RDFWorkerInboundMessage | RDFWorkerOutboundMessage;

export function assertRdfWorkerSubscriptionRequest(
  value: unknown,
): asserts value is RDFWorkerSubscriptionRequest {
  assertPlainObject(value, "rdf-worker-subscribe must be a plain object");
  const message = value as Record<string, unknown>;
  invariant(message.type === "subscribe", "subscription.type must equal 'subscribe'", {
    type: message.type,
  });
  assertString(message.id, "subscription.id must be a string");
  assertString(message.event, "subscription.event must be a string");
  const validEvents = new Set<RDFWorkerEventName>([
    "change",
    "subjects",
    "reasoningStage",
    "reasoningResult",
    "reasoningError",
  ]);
  invariant(validEvents.has(message.event as RDFWorkerEventName), "Unknown subscription event", {
    event: message.event,
  });
}

export function assertRdfWorkerUnsubscribeRequest(
  value: unknown,
): asserts value is RDFWorkerUnsubscribeRequest {
  assertPlainObject(value, "rdf-worker-unsubscribe must be a plain object");
  const message = value as Record<string, unknown>;
  invariant(message.type === "unsubscribe", "unsubscribe.type must equal 'unsubscribe'", {
    type: message.type,
  });
  assertString(message.id, "unsubscribe.id must be a string");
  assertString(message.event, "unsubscribe.event must be a string");
}

export function assertRdfWorkerAck(value: unknown): asserts value is RDFWorkerAck {
  assertPlainObject(value, "rdf-worker-ack must be a plain object");
  const message = value as Record<string, unknown>;
  invariant(message.type === "ack", "ack.type must equal 'ack'", { type: message.type });
  assertString(message.id, "ack.id must be a string");
}

export function assertRdfWorkerResponse(value: unknown): asserts value is RDFWorkerResponse {
  assertPlainObject(value, "rdf-worker-response must be a plain object");
  const message = value as Record<string, unknown>;
  invariant(message.type === "response", "response.type must equal 'response'", {
    type: message.type,
  });
  assertString(message.id, "response.id must be a string");
  assertBoolean(message.ok, "response.ok must be a boolean");
  if (message.ok) {
    return;
  }
  assertString(message.error, "response.error must be a string when ok is false");
  if (typeof message.stack !== "undefined") {
    assertString(message.stack, "response.stack must be a string when provided");
  }
}

export function assertRdfWorkerEvent(value: unknown): asserts value is RDFWorkerEvent {
  assertPlainObject(value, "rdf-worker-event must be a plain object");
  const message = value as Record<string, unknown>;
  invariant(message.type === "event", "event.type must equal 'event'", { type: message.type });
  assertString(message.event, "event.event must be a string");

  const payload = message.payload;
  switch (message.event) {
    case "change":
      assertPlainObject(payload, "change payload must be an object");
      assertNumber(
        (payload as { changeCount: unknown }).changeCount,
        "change payload.changeCount must be a finite number",
      );
      if (typeof (payload as { meta?: unknown }).meta !== "undefined") {
        assertOptionalPlainObject(
          (payload as { meta?: unknown }).meta,
          "change payload.meta must be an object when provided",
        );
      }
      return;
    case "subjects":
      assertPlainObject(payload, "subjects payload must be an object");
      assertStringArray(
        (payload as { subjects: unknown }).subjects,
        "subjects payload.subjects must be an array of strings",
      );
      if (typeof (payload as { quads?: unknown }).quads !== "undefined") {
        assertWorkerQuadRecord(
          (payload as { quads?: unknown }).quads,
          "subjects payload.quads must be a record of WorkerQuad arrays",
        );
      }
      return;
    case "reasoningStage":
      assertPlainObject(payload, "reasoningStage payload must be an object");
      assertString((payload as { id: unknown }).id, "reasoningStage payload.id must be a string");
      assertString(
        (payload as { stage: unknown }).stage,
        "reasoningStage payload.stage must be a string",
      );
      if (typeof (payload as { meta?: unknown }).meta !== "undefined") {
        assertOptionalPlainObject(
          (payload as { meta?: unknown }).meta,
          "reasoningStage payload.meta must be an object when provided",
        );
      }
      return;
    case "reasoningResult":
      assertReasoningResult(payload, "reasoningResult payload");
      return;
    case "reasoningError":
      assertPlainObject(payload, "reasoningError payload must be an object");
      assertString(
        (payload as { message: unknown }).message,
        "reasoningError payload.message must be a string",
      );
      if (typeof (payload as { stack?: unknown }).stack !== "undefined") {
        assertOptionalString(
          (payload as { stack?: unknown }).stack,
          "reasoningError payload.stack must be a string when provided",
        );
      }
      return;
    default:
      throw new Error(`Unknown rdf-worker event '${String(message.event)}'`);
  }
}

export function assertRdfWorkerOutbound(value: unknown): asserts value is RDFWorkerOutboundMessage {
  assertPlainObject(value, "rdf-worker-outbound message must be a plain object");
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "response":
      assertRdfWorkerResponse(message);
      return;
    case "event":
      assertRdfWorkerEvent(message);
      return;
    case "ack":
      assertRdfWorkerAck(message);
      return;
    default:
      throw new Error(`Unrecognised rdf-worker outbound message type: ${String(message.type)}`);
  }
}

export function assertRdfWorkerInbound(value: unknown): asserts value is RDFWorkerInboundMessage {
  assertPlainObject(value, "rdf-worker-inbound message must be a plain object");
  const message = value as Record<string, unknown>;
  const type = message.type;

  switch (type) {
    case "command":
      assertRdfWorkerCommand(message);
      return;
    case "subscribe":
      assertRdfWorkerSubscriptionRequest(message);
      return;
    case "unsubscribe":
      assertRdfWorkerUnsubscribeRequest(message);
      return;
    case "ack":
      assertRdfWorkerAck(message);
      return;
    case "loadFromUrl":
      assertString(message.id, "loadFromUrl.id must be a string");
      assertString(message.url, "loadFromUrl.url must be a string");
      if (typeof message.timeoutMs !== "undefined") {
        assertNumber(message.timeoutMs, "loadFromUrl.timeoutMs must be a finite number when provided");
      }
      if (typeof message.headers !== "undefined") {
        assertPlainObject(message.headers, "loadFromUrl.headers must be an object when provided");
        for (const [key, value] of Object.entries(message.headers as Record<string, unknown>)) {
          assertString(key, "loadFromUrl.headers keys must be strings");
          assertString(value, "loadFromUrl.headers values must be strings");
        }
      }
      return;
    case "runReasoning":
      assertString(message.id, "runReasoning.id must be a string");
      if (typeof message.quads !== "undefined") {
        assertWorkerQuadArray(message.quads, "runReasoning.quads must contain WorkerQuad entries");
      }
      if (typeof message.rulesets !== "undefined") {
        assertArray(message.rulesets, "runReasoning.rulesets must be an array when provided");
        for (const entry of message.rulesets as unknown[]) {
          assertString(entry, "runReasoning.rulesets entries must be strings");
        }
      }
      if (typeof message.baseUrl !== "undefined") {
        assertString(message.baseUrl, "runReasoning.baseUrl must be a string when provided");
      }
      if (typeof message.emitSubjects !== "undefined") {
        assertBoolean(message.emitSubjects, "runReasoning.emitSubjects must be a boolean when provided");
      }
      return;
    default:
      throw new Error(`Unrecognised rdf-worker inbound message type: ${String(type)}`);
  }
}
