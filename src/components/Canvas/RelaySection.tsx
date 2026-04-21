/**
 * @fileoverview AI Relay sidebar section
 * Shows relay connection status, setup instructions, draggable bookmarklet, and call log.
 */

import React, { useRef, useEffect } from 'react';
import { Zap, ExternalLink } from 'lucide-react';
import { Button } from '../ui/button';
import type { RelayCallLogEntry } from '../../hooks/useRelayBridge';

interface RelaySectionProps {
  bookmarkletHref: string;
  connected: boolean;
  callLog: RelayCallLogEntry[];
}

function formatRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  return `${diffMin}m ago`;
}

export const RelaySection: React.FC<RelaySectionProps> = ({ bookmarkletHref, connected, callLog }) => {
  const bookmarkletRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (bookmarkletRef.current) {
      bookmarkletRef.current.setAttribute('href', bookmarkletHref);
    }
  }, [bookmarkletHref]);

  return (
    <div className="px-3 py-2 space-y-3">
      {/* Description */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        Connect ChatGPT, Claude, or Gemini to this graph — no server or extension needed. The AI outputs <code className="text-xs">TOOL:</code> / <code className="text-xs">PARAMS:</code> blocks; the relay executes them here and injects results back into the chat automatically.
      </p>

      {/* Setup steps */}
      <ol className="text-xs text-muted-foreground space-y-1 list-none">
        <li className="flex gap-2"><span className="text-foreground font-medium">1.</span> Drag the button below to your bookmark bar</li>
        <li className="flex gap-2"><span className="text-foreground font-medium">2.</span> Go to your AI chat tab, click the bookmark</li>
        <li className="flex gap-2"><span className="text-foreground font-medium">3.</span> Paste the starter prompt — tool calls execute here automatically and results appear in the chat input</li>
      </ol>

      {/* Draggable bookmarklet */}
      <Button variant="outline" size="sm" asChild className="w-full cursor-grab active:cursor-grabbing">
        <a
          ref={bookmarkletRef}
          draggable
          onClick={(e) => e.preventDefault()}
          aria-label="Drag to bookmark bar to install VisGraph Relay"
        >
          <Zap className="h-3.5 w-3.5 mr-1.5" />
          VisGraph Relay
        </a>
      </Button>

      {/* Docs link */}
      <a
        href="https://github.com/ThHanke/visgraph#chatgpt-gemini-claudeai--ai-relay-bridge"
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ExternalLink className="h-3 w-3" />
        How it works
      </a>

      {/* Divider + status */}
      <div className="border-t border-border/40 pt-2 space-y-1.5">
        <div className="flex items-center gap-2 text-xs font-medium">
          <span
            className={`h-2 w-2 rounded-full flex-shrink-0 ${connected ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
            aria-label={connected ? 'Relay active' : 'Relay waiting'}
          />
          <span className={connected ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}>
            {connected ? 'relay active' : 'waiting'}
          </span>
        </div>

        {/* Call log */}
        {callLog.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No calls yet</p>
        ) : (
          <ul className="space-y-0.5">
            {callLog.map((entry: RelayCallLogEntry) => (
              <li key={`${entry.timestamp}-${entry.tool}`} className="flex items-center justify-between text-xs">
                <span className="font-mono text-foreground">{entry.tool}</span>
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span className={entry.success ? 'text-green-600 dark:text-green-400' : 'text-destructive'}>
                    {entry.success ? '✓' : '✗'}
                  </span>
                  <span>{formatRelativeTime(entry.timestamp)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};
