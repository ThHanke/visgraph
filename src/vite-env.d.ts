/// <reference types="vite/client" />

// Vite query-suffix module declarations so TypeScript accepts imports like:
// import WorkerFactory from '../workers/rdfManager.worker.ts?worker'
// import workerUrl from '../workers/rdfManager.worker.ts?url'
declare module '*?worker' {
  const WorkerFactory: new (...args: any[]) => Worker;
  export default WorkerFactory;
}
declare module '*?url' {
  const url: string;
  export default url;
}
