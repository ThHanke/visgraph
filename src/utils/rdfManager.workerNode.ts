import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import { buildSync } from "esbuild";
import type { RdfWorkerRuntime } from "../workers/rdfManager.runtime.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNTIME_ENTRY = path.resolve(__dirname, "../workers/rdfManager.runtime.ts");

let cachedRuntimeFactory:
  | ((postMessage: (message: unknown) => void) => RdfWorkerRuntime)
  | null = null;

function loadRuntimeFactory() {
  if (cachedRuntimeFactory) return cachedRuntimeFactory;

  const result = buildSync({
    entryPoints: [RUNTIME_ENTRY],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "es2020",
    write: false,
    sourcemap: false,
  });
  if (!result.outputFiles || result.outputFiles.length === 0) {
    throw new Error("Failed to bundle rdfManager runtime for in-process execution");
  }

  const code = result.outputFiles[0].text;
  const runtimeRequire = createRequire(pathToFileURL(RUNTIME_ENTRY));
  const wrapper = vm.runInThisContext(
    `(function (exports, require, module, __filename, __dirname) { ${code}\n});`,
    { filename: "rdfManager.runtime.cjs" },
  );
  const moduleExports: any = {};
  const moduleObj = { exports: moduleExports };
  wrapper(
    moduleExports,
    runtimeRequire,
    moduleObj,
    "rdfManager.runtime.cjs",
    path.dirname(RUNTIME_ENTRY),
  );

  const factory = moduleObj.exports?.createRdfWorkerRuntime;
  if (typeof factory !== "function") {
    throw new Error("Bundled runtime did not export createRdfWorkerRuntime");
  }

  cachedRuntimeFactory = factory;
  return factory;
}

type WorkerEventHandler = (event: any) => void;

type ListenerMap = Map<string, Set<WorkerEventHandler>>;

export class InProcessWorker {
  private hostListeners: ListenerMap = new Map();
  private runtime: RdfWorkerRuntime;
  private terminated = false;

  constructor() {
    const factory = loadRuntimeFactory();
    this.runtime = factory((message) => {
      this.dispatchToHost("message", { data: message });
    });
  }

  postMessage(message: unknown): void {
    if (this.terminated) return;
    try {
      const cloned =
        typeof structuredClone === "function"
          ? structuredClone(message)
          : JSON.parse(JSON.stringify(message));
      this.runtime.handleEvent(cloned);
    } catch (err) {
      this.dispatchToHost("error", err instanceof Error ? err : new Error(String(err)));
    }
  }

  terminate(): void {
    if (this.terminated) return;
    this.runtime.terminate();
    this.hostListeners.clear();
    this.terminated = true;
  }

  addEventListener(type: "message" | "error", listener: WorkerEventHandler): void {
    let set = this.hostListeners.get(type);
    if (!set) {
      set = new Set();
      this.hostListeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: "message" | "error", listener: WorkerEventHandler): void {
    const set = this.hostListeners.get(type);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) this.hostListeners.delete(type);
  }

  private dispatchToHost(type: string, event: any) {
    const listeners = this.hostListeners.get(type);
    if (!listeners) return;
    for (const handler of Array.from(listeners)) {
      try {
        handler(event);
      } catch (err) {
        if (type !== "error") {
          this.dispatchToHost("error", err instanceof Error ? err : new Error(String(err)));
        }
      }
    }
  }
}
