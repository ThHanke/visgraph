/**
 * @fileoverview AI Relay sidebar section
 * Shows relay connection status, setup instructions, draggable bookmarklet, and call log.
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { Zap, ExternalLink, Copy, Check } from 'lucide-react';
import { Button } from '../ui/button';

function fallbackCopy(text: string) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

const STARTER_PROMPT =
`You are connected to Ontosphere via a relay. A script in this tab intercepts your tool calls, runs them in Ontosphere, and injects results back as a user message. If a tool call returns success:false, read the error, fix the argument, and retry the same call immediately — never skip a failed call.

Output format — one JSON-RPC 2.0 call per line, backtick-wrapped:
\`{"jsonrpc":"2.0","id":<N>,"method":"tools/call","params":{"name":"<toolName>","arguments":{...}}}\`

Call help first to get full instructions and the tool list:
\`{"jsonrpc":"2.0","id":0,"method":"tools/call","params":{"name":"help","arguments":{}}}\``;
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
  const [copied, setCopied] = useState(false);

  const copyPrompt = useCallback(() => {
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 2000); };
    if (navigator.clipboard) {
      navigator.clipboard.writeText(STARTER_PROMPT).then(done).catch(() => {
        fallbackCopy(STARTER_PROMPT);
        done();
      });
    } else {
      fallbackCopy(STARTER_PROMPT);
      done();
    }
  }, []);

  useEffect(() => {
    if (bookmarkletRef.current) {
      bookmarkletRef.current.setAttribute('href', bookmarkletHref);
    }
  }, [bookmarkletHref]);

  return (
    <div className="px-3 py-2 space-y-3">
      {/* Description */}
      <p className="text-xs text-muted-foreground leading-relaxed">
        Connect ChatGPT, Claude, or Gemini to this graph — no server or extension needed. The AI outputs backtick-wrapped JSON-RPC 2.0 tool calls; the relay executes them here and injects results back into the chat automatically.
      </p>

      {/* Setup steps */}
      <ol className="text-xs text-muted-foreground space-y-1 list-none">
        <li className="flex gap-2"><span className="text-foreground font-medium">1.</span> Drag the button below to your bookmark bar</li>
        <li className="flex gap-2"><span className="text-foreground font-medium">2.</span> Go to your AI chat tab, click the bookmark</li>
        <li className="flex gap-2 items-start">
          <span className="text-foreground font-medium shrink-0">3.</span>
          <span>
            Paste the starter prompt into your AI chat — the AI calls <code className="text-xs">help()</code> to get full instructions, then tool calls run here automatically
          </span>
          <button
            onClick={copyPrompt}
            title="Copy starter prompt"
            className="shrink-0 ml-auto text-muted-foreground hover:text-foreground transition-colors"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        </li>
      </ol>

      {/* Draggable bookmarklet */}
      <Button variant="outline" size="sm" asChild className="w-full cursor-grab active:cursor-grabbing">
        <a
          ref={bookmarkletRef}
          draggable
          onClick={(e) => e.preventDefault()}
          aria-label="Drag to bookmark bar to install Ontosphere Relay"
        >
          <Zap className="h-3.5 w-3.5 mr-1.5" />
          Ontosphere Relay
        </a>
      </Button>

      {/* Docs link */}
      <a
        href="https://github.com/ThHanke/ontosphere#chatgpt-gemini-claudeai--ai-relay-bridge"
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
