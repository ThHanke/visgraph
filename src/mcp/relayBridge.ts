// src/mcp/relayBridge.ts
import { toast } from 'sonner';
import type { McpResult } from './types';

const CHANNEL_NAME = 'visgraph-relay-v1';
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 200;

export interface RelayCallLogEntry {
  tool: string;
  success: boolean;
  timestamp: number;
}

type CallLogCallback = (entry: RelayCallLogEntry) => void;
const callLogListeners: CallLogCallback[] = [];

export function onCallLogged(cb: CallLogCallback): () => void {
  callLogListeners.push(cb);
  return () => {
    const idx = callLogListeners.indexOf(cb);
    if (idx !== -1) callLogListeners.splice(idx, 1);
  };
}

function notifyCallLog(entry: RelayCallLogEntry): void {
  for (const cb of callLogListeners) {
    try { cb(entry); } catch { /* ignore listener errors */ }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForMcpTools(retries: number): Promise<Record<string, (params: unknown) => Promise<McpResult>> | null> {
  for (let i = 0; i <= retries; i++) {
    if (window.__mcpTools) return window.__mcpTools;
    if (i < retries) await delay(RETRY_DELAY_MS);
  }
  return null;
}

async function handleCall(
  channel: BroadcastChannel,
  tool: string,
  params: unknown,
  requestId: string,
): Promise<void> {
  const tools = await waitForMcpTools(RETRY_COUNT);

  if (!tools) {
    const error = 'VisGraph workspace not yet initialised';
    channel.postMessage({ type: 'vg-result', requestId, result: { success: false, error } });
    toast.error(`✗ ${tool}: ${error}`);
    notifyCallLog({ tool, success: false, timestamp: Date.now() });
    return;
  }

  const handler = tools[tool];
  if (!handler) {
    const error = `Unknown tool: ${tool}`;
    channel.postMessage({ type: 'vg-result', requestId, result: { success: false, error } });
    toast.error(`✗ ${tool}: ${error}`);
    notifyCallLog({ tool, success: false, timestamp: Date.now() });
    return;
  }

  let result: McpResult;
  try {
    result = await handler(params);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    result = { success: false, error };
    channel.postMessage({ type: 'vg-result', requestId, result });
    toast.error(`✗ ${tool}: ${error}`);
    notifyCallLog({ tool, success: false, timestamp: Date.now() });
    return;
  }

  // Attempt SVG export — optional, never fails the result
  let svg: string | undefined;
  try {
    const exportHandler = tools['exportImage'];
    if (exportHandler) {
      const exportResult = await exportHandler({ format: 'svg' });
      if (exportResult.success) {
        svg = exportResult.data as string;
      }
    }
  } catch { /* svg export is best-effort */ }

  channel.postMessage({ type: 'vg-result', requestId, result, ...(svg !== undefined ? { svg } : {}) });

  if (result.success) {
    toast.success(`✓ ${tool}`);
    notifyCallLog({ tool, success: true, timestamp: Date.now() });
  } else {
    toast.error(`✗ ${tool}: ${result.error}`);
    notifyCallLog({ tool, success: false, timestamp: Date.now() });
  }
}

export function startRelayBridge(): () => void {
  const channel = new BroadcastChannel(CHANNEL_NAME);

  channel.onmessage = (event: MessageEvent) => {
    const msg = event.data;
    console.info('[RelayBridge] BC message received:', msg);
    if (!msg || msg.type !== 'vg-call') { console.warn('[RelayBridge] Ignored (wrong type):', msg?.type); return; }
    if (typeof msg.tool !== 'string' || typeof msg.requestId !== 'string') { console.warn('[RelayBridge] Ignored (bad shape):', msg); return; }

    const { tool, params, requestId } = msg as { tool: string; params: unknown; requestId: string };
    handleCall(channel, tool, params, requestId).catch(err => {
      console.error('[RelayBridge] Unhandled error in handleCall:', err);
    });
  };

  console.info('[RelayBridge] Listening on BroadcastChannel:', CHANNEL_NAME);

  return () => {
    channel.close();
    console.info('[RelayBridge] Channel closed.');
  };
}
