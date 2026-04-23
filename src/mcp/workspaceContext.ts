// src/mcp/workspaceContext.ts
import type * as Reactodia from '@reactodia/workspace';
import type { N3DataProvider } from '@/providers/N3DataProvider';

const CHANNEL_NAME = 'visgraph-relay-v1';

interface WorkspaceRefs {
  ctx: Reactodia.WorkspaceContext;
  dataProvider: N3DataProvider;
  runReasoning?: () => Promise<unknown>;
}

let refs: WorkspaceRefs | null = null;
let pendingReasoningCallback: (() => Promise<unknown>) | null = null;
let bc: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel {
  if (!bc) bc = new BroadcastChannel(CHANNEL_NAME);
  return bc;
}

function maybeNotifyReady(): void {
  if (refs && refs.runReasoning) {
    getChannel().postMessage({ type: 'vg-ready' });
  }
}

export function notifyReady(): void {
  maybeNotifyReady();
}

export function setWorkspaceContext(
  ctx: Reactodia.WorkspaceContext,
  dataProvider: N3DataProvider
): void {
  refs = { ctx, dataProvider };
  if (pendingReasoningCallback) {
    refs.runReasoning = pendingReasoningCallback;
    pendingReasoningCallback = null;
  }
  maybeNotifyReady();
}

export function registerReasoningCallback(fn: () => Promise<unknown>): void {
  if (refs) {
    refs.runReasoning = fn;
  } else {
    pendingReasoningCallback = fn;
  }
  maybeNotifyReady();
}

export function getWorkspaceRefs(): WorkspaceRefs {
  if (!refs) throw new Error('[MCP] WorkspaceContext not yet initialised');
  return refs;
}
