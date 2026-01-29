/**
 * @fileoverview Pyodide web worker entry point
 * Executes Python code in a separate thread using Pyodide
 */

import { createPyodideWorkerRuntime } from './pyodide.runtime';

declare const self: DedicatedWorkerGlobalScope;

const runtime = createPyodideWorkerRuntime((message) => {
  self.postMessage(message);
});

self.addEventListener('message', (event) => {
  runtime.handleEvent(event.data);
});
