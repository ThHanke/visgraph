// src/mcp/workspaceContext.ts
import type * as Reactodia from '@reactodia/workspace';
import type { N3DataProvider } from '@/providers/N3DataProvider';

const CHANNEL_NAME = 'visgraph-relay-v1';

interface WorkspaceRefs {
  ctx: Reactodia.WorkspaceContext;
  dataProvider: N3DataProvider;
  runReasoning?: () => Promise<unknown>;
  navigateToIri?: (iri: string) => void;
}

let refs: WorkspaceRefs | null = null;
let pendingReasoningCallback: (() => Promise<unknown>) | null = null;
let bc: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel {
  if (!bc) {
    bc = new BroadcastChannel(CHANNEL_NAME);
    // Respond to relay bridge ping (sent on startup) so it can confirm app is ready
    bc.addEventListener('message', (evt) => {
      if (evt.data?.type === 'vg-ping' && !evt.data?.requestId) {
        // A ping without requestId is the relay bridge's startup readiness check
        maybeNotifyReady();
      }
    });
  }
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

export function registerNavigateToIri(fn: (iri: string) => void): void {
  if (refs) refs.navigateToIri = fn;
}

export function getWorkspaceRefs(): WorkspaceRefs {
  if (!refs) throw new Error('[MCP] WorkspaceContext not yet initialised');
  return refs;
}
