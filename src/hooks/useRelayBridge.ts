import { useEffect, useState } from "react";
import { startRelayBridge, onCallLogged, onConnectionChanged, RelayCallLogEntry } from "../mcp/relayBridge";
export type { RelayCallLogEntry };

export function useRelayBridge(enabled: boolean): { connected: boolean; callLog: RelayCallLogEntry[] } {
  const [connected, setConnected] = useState(false);
  const [callLog, setCallLog] = useState<RelayCallLogEntry[]>([]);

  useEffect(() => {
    console.info('[useRelayBridge] enabled=', enabled);
    if (!enabled) return;

    const stopBridge = startRelayBridge();
    const unsubscribeConnection = onConnectionChanged(setConnected);

    const unsubscribeLog = onCallLogged((entry) => {
      setCallLog((prev) => [entry, ...prev].slice(0, 10));
    });

    return () => {
      unsubscribeConnection();
      unsubscribeLog();
      stopBridge();
      setConnected(false);
    };
  }, [enabled]);

  return { connected, callLog };
}
