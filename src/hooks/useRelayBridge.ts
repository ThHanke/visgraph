import { useEffect, useState } from "react";
import { startRelayBridge, onCallLogged, RelayCallLogEntry } from "../mcp/relayBridge";
export type { RelayCallLogEntry };

export function useRelayBridge(enabled: boolean): { connected: boolean; callLog: RelayCallLogEntry[] } {
  const [connected, setConnected] = useState(false);
  const [callLog, setCallLog] = useState<RelayCallLogEntry[]>([]);

  useEffect(() => {
    console.info('[useRelayBridge] enabled=', enabled);
    if (!enabled) return;

    const stopBridge = startRelayBridge();
    setConnected(true);

    const unsubscribe = onCallLogged((entry) => {
      setCallLog((prev) => [entry, ...prev].slice(0, 10));
    });

    return () => {
      unsubscribe();
      stopBridge();
      setConnected(false);
    };
  }, [enabled]);

  return { connected, callLog };
}
