import WorkerFactory from "../workers/rdfManager.worker.ts?worker";
import type {
  RDFWorkerCommandName,
  RDFWorkerCommand,
  RDFWorkerCommandPayloads,
  RDFWorkerEvent,
  RDFWorkerMessage,
  RDFWorkerResponse,
  RDFWorkerSubscriptionRequest,
  RDFWorkerUnsubscribeRequest,
} from "./rdfManager.workerProtocol";

type EventName = "change" | "subjects" | "reasoningStage" | "reasoningResult" | "reasoningError";

type EventHandlerMap = {
  change: Set<(payload: any) => void>;
  subjects: Set<(payload: any) => void>;
  reasoningStage: Set<(payload: any) => void>;
  reasoningResult: Set<(payload: any) => void>;
  reasoningError: Set<(payload: any) => void>;
};

export interface RdfManagerWorkerClientOptions {
  /**
   * When true, no web worker is spawned. Instead, commands are executed synchronously against
   * the provided executor. Intended for tests that cannot run workers.
   */
  executor?: <C extends RDFWorkerCommandName>(
    command: C,
    payload: RDFWorkerCommandPayloads[C],
  ) => Promise<unknown>;
}

type WorkerLike = {
  postMessage: (message: unknown) => void;
  terminate: () => void | Promise<void>;
  addEventListener: (type: "message" | "error", listener: (event: any) => void) => void;
  removeEventListener: (type: "message" | "error", listener: (event: any) => void) => void;
};

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

export class RdfManagerWorkerClient {
  private worker: WorkerLike | null = null;
  private workerInit: Promise<WorkerLike | null> | null = null;
  private pending: Map<string, PendingRequest> = new Map();
  private events: EventHandlerMap = {
    change: new Set(),
    subjects: new Set(),
    reasoningStage: new Set(),
    reasoningResult: new Set(),
    reasoningError: new Set(),
  };
  private executor: RdfManagerWorkerClientOptions["executor"] | null;
  private subscribedEvents: Set<keyof EventHandlerMap> = new Set();

  constructor(options?: RdfManagerWorkerClientOptions) {
    this.executor = options?.executor ?? null;
    if (!this.executor) {
      void this.ensureWorker();
    }
  }

  private handleMessage = (event: { data: RDFWorkerMessage }) => {
    const data = event.data;
    if (!data) return;

    if (data.type === "response") {
      const responder = this.pending.get(data.id);
      if (!responder) return;
      this.pending.delete(data.id);
      if (data.ok) {
        responder.resolve(data.result);
      } else {
        const err = new Error(data.error || "rdf-worker-error");
        if (data.stack) {
          (err as any).stack = data.stack;
        }
        responder.reject(err);
      }
      return;
    }

    if (data.type === "event") {
      const handlers = this.events[data.event];
      if (!handlers || handlers.size === 0) return;
      for (const handler of handlers) {
        try {
          handler(data.payload);
        } catch (err) {
          console.error("[rdfManager.workerClient] event handler error", err);
        }
      }
    }
  };

  private handleError = (event: ErrorEvent | Error) => {
    const message = event instanceof Error ? event.message : event?.message;
    console.error("[rdfManager.workerClient] worker runtime error", message);
  };

  private async ensureWorker(): Promise<WorkerLike | null> {
    if (this.worker) return this.worker;
    if (this.workerInit) return this.workerInit;

    this.workerInit = (async () => {
      try {
        console.debug("[rdfManager.workerClient] ensureWorker start", {
          hasBrowserWorker: typeof Worker !== "undefined",
          isNode: typeof window === "undefined",
        });
      } catch (_) {
        /* ignore */
      }

      if (typeof Worker !== "undefined") {
        const worker = new WorkerFactory() as unknown as WorkerLike;
        worker.addEventListener("message", this.handleMessage);
        worker.addEventListener("error", this.handleError);
        this.worker = worker;
        return worker;
      }

      if (typeof window === "undefined") {
        try {
          const modulePath = "./rdfManager.workerNode.ts";
          const { InProcessWorker } = await import(
            /* @vite-ignore */ modulePath
          );
          const worker: WorkerLike = new InProcessWorker();
          worker.addEventListener("message", this.handleMessage);
          worker.addEventListener("error", this.handleError);
          this.worker = worker;
          return worker;
        } catch (err) {
          console.error("[rdfManager.workerClient] failed to initialise in-process worker", err);
          return null;
        }
      }

      return null;
    })();

    return this.workerInit;
  }

  async call<C extends RDFWorkerCommandName, T = unknown>(
    command: C,
    payload?: RDFWorkerCommandPayloads[C],
  ): Promise<T> {
    const id = `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (!this.worker) {
      if (this.executor) {
        return (this.executor(command, payload as any) as Promise<T>);
      }
      await this.ensureWorker();
    }
    if (!this.worker) {
      throw new Error("rdfManager worker not initialised");
    }

    const message: RDFWorkerCommand = Object.freeze({
      type: "command",
      id,
      command,
      ...(typeof payload === "undefined" ? {} : { payload }),
    }) as RDFWorkerCommand;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker?.postMessage(message);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(event: EventName, handler: (payload: any) => void): () => void {
    const set = this.events[event];
    set.add(handler);
    if (!this.executor && !this.subscribedEvents.has(event)) {
      this.subscribedEvents.add(event);
      const subMessage: RDFWorkerSubscriptionRequest = { type: "subscribe", id: event, event };
      this.ensureWorker()
        .then(() => {
          try {
            this.worker?.postMessage(subMessage);
          } catch (err) {
            console.error("[rdfManager.workerClient] failed to send subscribe", err);
          }
        })
        .catch((err) => {
          console.error("[rdfManager.workerClient] worker init failed during subscribe", err);
        });
    }
    return () => {
      set.delete(handler);
      if (!this.executor && set.size === 0 && this.subscribedEvents.has(event)) {
        this.subscribedEvents.delete(event);
        const unsubMessage: RDFWorkerUnsubscribeRequest = {
          type: "unsubscribe",
          id: event,
          event,
        };
        try {
          this.worker?.postMessage(unsubMessage);
        } catch (err) {
          console.error("[rdfManager.workerClient] failed to send unsubscribe", err);
        }
      }
    };
  }

  terminate() {
    if (this.worker) {
      this.worker.removeEventListener("message", this.handleMessage);
      this.worker.removeEventListener("error", this.handleError);
      this.worker.terminate();
      this.worker = null;
    }
    this.pending.clear();
  }
}

export function createRdfManagerWorkerClient(options?: RdfManagerWorkerClientOptions) {
  return new RdfManagerWorkerClient(options);
}
