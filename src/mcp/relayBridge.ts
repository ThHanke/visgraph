// src/mcp/relayBridge.ts
import { toast } from 'sonner';
import type { McpResult } from './types';

const CHANNEL_NAME = 'visgraph-relay-v1';
const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 200;

// Unique token for this page load — changes on every reload so the relay can detect data loss
const SESSION_ID = Math.random().toString(36).slice(2, 10);

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

type ConnectionCallback = (connected: boolean) => void;
const connectionListeners: ConnectionCallback[] = [];

export function onConnectionChanged(cb: ConnectionCallback): () => void {
  connectionListeners.push(cb);
  return () => {
    const idx = connectionListeners.indexOf(cb);
    if (idx !== -1) connectionListeners.splice(idx, 1);
  };
}

function notifyConnectionChanged(connected: boolean): void {
  for (const cb of connectionListeners) {
    try { cb(connected); } catch { /* ignore */ }
  }
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

/** Compact one-line canvas state string, e.g. "Canvas: 3 nodes (Alice, Bob, Carol), 2 links" */
async function buildCanvasSummary(
  tools: Record<string, (params: unknown) => Promise<McpResult>>
): Promise<string | undefined> {
  try {
    const handler = tools['getGraphState'];
    if (!handler) return undefined;
    const result = await handler({});
    if (!result.success || !result.data) return undefined;
    const d = result.data as {
      nodeCount: number;
      linkCount: number;
      nodes: Array<{ label?: string; iri: string }>;
    };
    const MAX_LABELS = 8;
    const labels = d.nodes
      .slice(0, MAX_LABELS)
      .map(n => n.label || n.iri.split(/[/#]/).pop() || n.iri)
      .join(', ');
    const more = d.nodeCount > MAX_LABELS ? ` +${d.nodeCount - MAX_LABELS} more` : '';
    return `Canvas: ${d.nodeCount} node${d.nodeCount !== 1 ? 's' : ''} (${labels}${more}), ${d.linkCount} link${d.linkCount !== 1 ? 's' : ''}`;
  } catch {
    return undefined;
  }
}

async function handleCall(
  channel: BroadcastChannel,
  tool: string,
  params: unknown,
  requestId: string,
  isLast: boolean,
): Promise<void> {
  const tools = await waitForMcpTools(RETRY_COUNT);

  if (!tools) {
    const error = 'VisGraph workspace not yet initialised';
    channel.postMessage({ type: 'vg-result', requestId, result: { success: false, error } });
    channel.postMessage({ type: 'vg-ready' });
    toast.error(`✗ ${tool}: ${error}`);
    notifyCallLog({ tool, success: false, timestamp: Date.now() });
    return;
  }

  const handler = tools[tool];
  if (!handler) {
    const error = `Unknown tool: ${tool}`;
    channel.postMessage({ type: 'vg-result', requestId, result: { success: false, error } });
    channel.postMessage({ type: 'vg-ready' });
    toast.error(`✗ ${tool}: ${error}`);
    notifyCallLog({ tool, success: false, timestamp: Date.now() });
    return;
  }

  // Heartbeat: ping the AI tab every 10s while the tool runs (layout/reasoning can be slow)
  const pingInterval = setInterval(() => {
    channel.postMessage({ type: 'vg-ping', requestId, sessionId: SESSION_ID });
  }, 10_000);

  let result: McpResult;
  try {
    result = await handler(params);
  } catch (err) {
    clearInterval(pingInterval);
    const error = err instanceof Error ? err.message : String(err);
    result = { success: false, error };
    channel.postMessage({ type: 'vg-result', requestId, result });
    channel.postMessage({ type: 'vg-ready' });
    toast.error(`✗ ${tool}: ${error}`);
    notifyCallLog({ tool, success: false, timestamp: Date.now() });
    return;
  }
  clearInterval(pingInterval);

  // Canvas summary — always included (cheap getGraphState call)
  const summary = await buildCanvasSummary(tools);

  // SVG export — only on the last call of a batch (avoids N-1 wasted exports)
  let svg: string | undefined;
  if (isLast && tool !== 'exportImage') {
    try {
      const exportHandler = tools['exportImage'];
      if (exportHandler) {
        const exportResult = await exportHandler({ format: 'svg', noCss: true });
        if (exportResult.success) {
          svg = exportResult.data as string;
        }
      }
    } catch { /* svg export is best-effort */ }
  }

  channel.postMessage({
    type: 'vg-result',
    requestId,
    result,
    ...(summary !== undefined ? { summary } : {}),
    ...(svg !== undefined ? { svg } : {}),
  });

  // Signal the relay that the app is idle and ready for the next call
  channel.postMessage({ type: 'vg-ready' });

  if (result.success) {
    toast.success(`✓ ${tool}`);
    notifyCallLog({ tool, success: true, timestamp: Date.now() });
  } else {
    toast.error(`✗ ${tool}: ${result.error}`);
    notifyCallLog({ tool, success: false, timestamp: Date.now() });
  }
}

const PING_STALE_MS = 15000;
const PING_CHECK_INTERVAL_MS = 5000;

export function startRelayBridge(): () => void {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  let lastPingAt = 0;
  let isConnected = false;
  let appReady = false;
  // Calls received before app signals vg-ready are queued here
  const pendingCalls: Array<{ tool: string; params: unknown; requestId: string; isLast: boolean }> = [];

  const staleCheck = setInterval(() => {
    const stale = lastPingAt > 0 && (Date.now() - lastPingAt > PING_STALE_MS);
    if (stale && isConnected) {
      isConnected = false;
      notifyConnectionChanged(false);
    }
  }, PING_CHECK_INTERVAL_MS);

  function drainPending(): void {
    const call = pendingCalls.shift();
    if (!call) return;
    // Mark busy — next drain happens when handleCall posts vg-ready and appReady flips back
    appReady = false;
    handleCall(channel, call.tool, call.params, call.requestId, call.isLast).catch(err => {
      console.error('[RelayBridge] Unhandled error in handleCall:', err);
    });
  }

  channel.onmessage = (event: MessageEvent) => {
    const msg = event.data;
    console.info('[RelayBridge] BC message received:', msg);

    if (msg?.type === 'vg-ready') {
      // App (or ourselves) signalling readiness — dispatch next queued call if any
      appReady = true;
      if (pendingCalls.length > 0) {
        console.info('[RelayBridge] App ready — dispatching next queued call (', pendingCalls.length, 'pending)');
        drainPending();
      }
      return;
    }

    if (msg?.type === 'vg-ping') {
      lastPingAt = Date.now();
      if (!isConnected) {
        isConnected = true;
        notifyConnectionChanged(true);
      }
      return;
    }

    if (!msg || msg.type !== 'vg-call') { console.warn('[RelayBridge] Ignored (wrong type):', msg?.type); return; }
    if (typeof msg.tool !== 'string' || typeof msg.requestId !== 'string') { console.warn('[RelayBridge] Ignored (bad shape):', msg); return; }

    const { tool, params, requestId } = msg as { tool: string; params: unknown; requestId: string };
    const isLast = (msg as { isLast?: boolean }).isLast === true;

    if (!appReady) {
      console.info('[RelayBridge] App not ready — queuing call:', tool);
      pendingCalls.push({ tool, params, requestId, isLast });
      return;
    }

    // Mark busy immediately so any subsequent BC messages queue rather than run concurrently
    appReady = false;
    handleCall(channel, tool, params, requestId, isLast).catch(err => {
      console.error('[RelayBridge] Unhandled error in handleCall:', err);
    });
  };

  console.info('[RelayBridge] Listening on BroadcastChannel:', CHANNEL_NAME);

  return () => {
    clearInterval(staleCheck);
    channel.close();
    console.info('[RelayBridge] Channel closed.');
  };
}
