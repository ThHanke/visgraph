// src/mcp/relayBridge.ts
import { toast } from 'sonner';
import type { McpResult } from './types';

const CHANNEL_NAME = 'ontosphere-relay-v1';
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

function shortIri(iri: unknown): string | undefined {
  return typeof iri === 'string' ? (iri.split(/[/#]/).filter(Boolean).pop() ?? iri) : undefined;
}

function toastLabel(tool: string, result: McpResult): string {
  const d = result.data as Record<string, unknown> | null | undefined;
  if (!d) return tool;
  switch (tool) {
    case 'loadOntology':
      if (typeof d.count === 'number') return `${tool} · ${d.count} results`;
      return `${tool} · ${d.requestedAs ?? shortIri(d.loaded) ?? ''}`;
    case 'loadRDF':
      return `${tool} · ${shortIri(d.loaded) ?? ''}`;
    case 'queryGraph': {
      const n = d.total;
      if (d.updated) return `${tool} · updated`;
      if (typeof n === 'number') return `${tool} · ${n} ${Array.isArray(d.rows) ? 'rows' : 'triples'}`;
      return tool;
    }
    case 'addNode':
    case 'focusNode':
    case 'getNodeDetails':
      return `${tool} · ${shortIri(d.iri) ?? ''}`;
    case 'removeNode':
      return `${tool} · ${shortIri(d.removed) ?? ''}`;
    case 'updateNode':
      return `${tool} · ${shortIri(d.updated) ?? ''}`;
    case 'expandAll':
      return typeof d.expanded === 'number' ? `${tool} · ${d.expanded} nodes` : tool;
    case 'addLink': {
      const rel = d.added as Record<string, unknown> | undefined;
      return `${tool} · ${shortIri(rel?.p) ?? ''}`;
    }
    case 'removeLink': {
      const rel = d.removed as Record<string, unknown> | undefined;
      return `${tool} · ${shortIri(rel?.p) ?? ''}`;
    }
    case 'runLayout':
    case 'setLayout':
    case 'layout':
      return typeof d.algorithm === 'string' ? `${tool} · ${d.algorithm}` : tool;
    case 'setGraphMode':
      return typeof d.mode === 'string' ? `${tool} · ${d.mode}` : tool;
    default:
      return tool;
  }
}

async function waitForMcpTools(retries: number): Promise<Record<string, (params: unknown) => Promise<McpResult>> | null> {
  for (let i = 0; i <= retries; i++) {
    if (window.__mcpTools) return window.__mcpTools;
    if (i < retries) await delay(RETRY_DELAY_MS);
  }
  return null;
}

/** Compact one-line store state string, e.g. "Store: 3 nodes (Alice, Bob, Carol), 2 links" */
async function buildCanvasSummary(
  tools: Record<string, (params: unknown) => Promise<McpResult>>
): Promise<string | undefined> {
  try {
    // Use getNodes (full RDF store) so count reflects all addNode calls,
    // not just nodes placed on the visual canvas.
    const nodesHandler = tools['getNodes'];
    const linksHandler = tools['getLinks'];
    if (!nodesHandler) return undefined;

    const nodesResult = await nodesHandler({});
    if (!nodesResult.success || !nodesResult.data) return undefined;
    const rawNodes = nodesResult.data as { content: string } | Array<unknown>;
    const nodes: Array<{ iri: string; label?: string }> =
      typeof (rawNodes as { content: string }).content === 'string'
        ? (JSON.parse((rawNodes as { content: string }).content) as Array<{ iri: string; label?: string }>)
        : (rawNodes as Array<{ iri: string; label?: string }>);

    let linkCount = 0;
    if (linksHandler) {
      const linksResult = await linksHandler({});
      if (linksResult.success && linksResult.data) {
        const d = linksResult.data as { links?: Array<unknown>; content?: string };
        if (Array.isArray(d.links)) linkCount = d.links.length;
        else if (typeof d.content === 'string') linkCount = (JSON.parse(d.content) as Array<unknown>).length;
      }
    }

    const nodeCount = nodes.length;
    const MAX_LABELS = 8;
    const labels = nodes
      .slice(0, MAX_LABELS)
      .map(n => n.label || n.iri.split(/[/#]/).pop() || n.iri)
      .join(', ');
    const more = nodeCount > MAX_LABELS ? ` +${nodeCount - MAX_LABELS} more` : '';
    return `Store: ${nodeCount} node${nodeCount !== 1 ? 's' : ''} (${labels}${more}), ${linkCount} link${linkCount !== 1 ? 's' : ''}`;
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
  onDone: () => void,
): Promise<void> {
  const tools = await waitForMcpTools(RETRY_COUNT);

  if (!tools) {
    const error = 'Ontosphere workspace not yet initialised';
    channel.postMessage({ type: 'vg-result', requestId, result: { success: false, error } });
    channel.postMessage({ type: 'vg-ready' });
    toast.error(`✗ ${tool}: ${error}`);
    notifyCallLog({ tool, success: false, timestamp: Date.now() });
    onDone();
    return;
  }

  const handler = tools[tool];
  if (!handler) {
    const error = `Unknown tool: ${tool}`;
    console.error('[RelayBridge] Unknown tool:', tool);
    channel.postMessage({ type: 'vg-result', requestId, result: { success: false, error } });
    channel.postMessage({ type: 'vg-ready' });
    toast.error(`✗ ${tool}: ${error}`);
    notifyCallLog({ tool, success: false, timestamp: Date.now() });
    onDone();
    return;
  }

  // Heartbeat: ping the AI tab every 10s while the tool runs (layout/reasoning can be slow)
  const pingInterval = setInterval(() => {
    channel.postMessage({ type: 'vg-ping', requestId, sessionId: SESSION_ID });
  }, 10_000);

  let result: McpResult;
  try {
    result = await handler(params);
    console.info('[RelayBridge] Tool result:', tool, JSON.stringify(result).slice(0, 300));
  } catch (err) {
    clearInterval(pingInterval);
    const error = err instanceof Error ? err.message : String(err);
    console.error('[RelayBridge] Tool error:', tool, JSON.stringify(params).slice(0, 200), error);
    result = { success: false, error };
    channel.postMessage({ type: 'vg-result', requestId, result });
    channel.postMessage({ type: 'vg-ready' });
    toast.error(`✗ ${toastLabel(tool, { success: false, error })}: ${error}`);
    notifyCallLog({ tool, success: false, timestamp: Date.now() });
    onDone();
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

  // Signal the relay popup that the app is idle
  channel.postMessage({ type: 'vg-ready' });

  if (result.success) {
    toast.success(`✓ ${toastLabel(tool, result)}`);
    notifyCallLog({ tool, success: true, timestamp: Date.now() });
  } else {
    toast.error(`✗ ${toastLabel(tool, result)}: ${result.error}`);
    notifyCallLog({ tool, success: false, timestamp: Date.now() });
  }

  // Signal internal queue to dispatch next pending call
  onDone();
}

const PING_STALE_MS = 15000;
const PING_CHECK_INTERVAL_MS = 5000;

export function startRelayBridge(): () => void {
  const channel = new BroadcastChannel(CHANNEL_NAME);
  let lastPingAt = 0;
  let isConnected = false;
  let appReady = false;
  const pendingCalls: Array<{ tool: string; params: unknown; requestId: string; isLast: boolean }> = [];

  // Ask the app if it's ready — workspaceContext responds with vg-ready if initialised
  channel.postMessage({ type: 'vg-ping' });

  const staleCheck = setInterval(() => {
    const stale = lastPingAt > 0 && (Date.now() - lastPingAt > PING_STALE_MS);
    if (stale && isConnected) {
      isConnected = false;
      notifyConnectionChanged(false);
    }
  }, PING_CHECK_INTERVAL_MS);

  function dispatch(tool: string, params: unknown, requestId: string, isLast: boolean): void {
    appReady = false;
    handleCall(channel, tool, params, requestId, isLast, () => {
      appReady = true;
      if (pendingCalls.length > 0) {
        const next = pendingCalls.shift()!;
        console.info('[RelayBridge] Dispatching next queued call:', next.tool, '(', pendingCalls.length, 'remaining)');
        dispatch(next.tool, next.params, next.requestId, next.isLast);
      }
    }).catch(err => {
      console.error('[RelayBridge] Unhandled error in handleCall:', err);
      appReady = true;
    });
  }

  channel.onmessage = (event: MessageEvent) => {
    const msg = event.data;
    console.info('[RelayBridge] BC message received:', JSON.stringify(msg));

    if (msg?.type === 'vg-ready') {
      // Initial vg-ready from workspaceContext signals the app is ready for first call
      if (!appReady) {
        appReady = true;
        if (pendingCalls.length > 0) {
          const next = pendingCalls.shift()!;
          console.info('[RelayBridge] App ready — dispatching first queued call:', next.tool);
          dispatch(next.tool, next.params, next.requestId, next.isLast);
        }
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

    dispatch(tool, params, requestId, isLast);
  };

  console.info('[RelayBridge] Listening on BroadcastChannel:', CHANNEL_NAME);

  return () => {
    clearInterval(staleCheck);
    channel.close();
    console.info('[RelayBridge] Channel closed.');
  };
}
