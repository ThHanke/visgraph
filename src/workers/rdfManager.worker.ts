import { createRdfWorkerRuntime } from "./rdfManager.runtime.ts";

declare const self: DedicatedWorkerGlobalScope;

const runtime = createRdfWorkerRuntime((message) => {
  self.postMessage(message);
});

self.addEventListener("message", (event) => {
  runtime.handleEvent(event.data);
});
