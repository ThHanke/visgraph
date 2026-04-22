// @vitest-environment node
/**
 * Unit tests for the MCP JSON-RPC 2.0 parser logic from relay-bookmarklet.js.
 *
 * Extracted to pure JS so we can test without a browser environment.
 * Mirrors the exact algorithm in public/relay-bookmarklet.js.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── Replicated parser (keep in sync with relay-bookmarklet.js) ────────────

const KNOWN_PREFIXES: Record<string, string> = {
  'rdf:'     : 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'rdfs:'    : 'http://www.w3.org/2000/01/rdf-schema#',
  'owl:'     : 'http://www.w3.org/2002/07/owl#',
  'xsd:'     : 'http://www.w3.org/2001/XMLSchema#',
  'foaf:'    : 'http://xmlns.com/foaf/0.1/',
  'skos:'    : 'http://www.w3.org/2004/02/skos/core#',
  'dc:'      : 'http://purl.org/dc/elements/1.1/',
  'dcterms:' : 'http://purl.org/dc/terms/',
  'schema:'  : 'https://schema.org/',
  'ex:'      : 'http://example.org/',
};

function expandPrefix(val: string): string {
  for (const p in KNOWN_PREFIXES) {
    if (val.indexOf(p) === 0) return KNOWN_PREFIXES[p] + val.slice(p.length);
  }
  return val;
}

function validateMcpRequest(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  if (o.jsonrpc !== '2.0') return false;
  if (o.method !== 'tools/call') return false;
  if (!o.params || typeof (o.params as Record<string, unknown>).name !== 'string') return false;
  return true;
}

function extractJsonObjects(text: string): string[] {
  const objects: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const start = text.indexOf('{', i);
    if (start === -1) break;
    let depth = 0, inStr = false, complete = false;
    for (let j = start; j < n; j++) {
      const c = text[j];
      if (inStr) {
        if (c === '\\') { j++; continue; }
        if (c === '"') inStr = false;
      } else {
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') {
          if (--depth === 0) { objects.push(text.slice(start, j + 1)); i = j + 1; complete = true; break; }
        }
      }
    }
    if (!complete) break;
  }
  return objects;
}

interface ToolCall { tool: string; params: Record<string, unknown>; mcpId: number | null }

function extractAllToolCalls(text: string, seen = new Set<string>()): ToolCall[] {
  const calls: ToolCall[] = [];
  const objects = extractJsonObjects(text);
  for (const raw of objects) {
    let req: Record<string, unknown>;
    try { req = JSON.parse(raw); } catch { continue; }
    if (!validateMcpRequest(req)) continue;
    const p = req.params as Record<string, unknown>;
    const tool = p.name as string;
    const params: Record<string, unknown> = (p.arguments as Record<string, unknown>) || {};
    for (const k in params) {
      if (typeof params[k] === 'string') params[k] = expandPrefix(params[k] as string);
    }
    const sig = tool + ':' + JSON.stringify(params);
    if (!seen.has(sig)) {
      seen.add(sig);
      const id = req.id;
      calls.push({ tool, params, mcpId: id != null ? (id as number) : null });
    }
  }
  return calls;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('extractAllToolCalls', () => {
  let seen: Set<string>;
  beforeEach(() => { seen = new Set(); });

  // ── Happy path ────────────────────────────────────────────────────────

  it('parses a single inline backtick JSON-RPC call', () => {
    const text = '`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://example.org/Alice","label":"Alice"}}}`';
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('addNode');
    expect(calls[0].params.iri).toBe('http://example.org/Alice');
    expect(calls[0].params.label).toBe('Alice');
    expect(calls[0].mcpId).toBe(1);
  });

  it('parses two calls in one message, preserving order', () => {
    const text = [
      '`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://example.org/Alice","label":"Alice"}}}`',
      '`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://example.org/Bob","label":"Bob"}}}`',
    ].join('\n');
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(2);
    expect(calls[0].params.label).toBe('Alice');
    expect(calls[1].params.label).toBe('Bob');
    expect(calls[0].mcpId).toBe(1);
    expect(calls[1].mcpId).toBe(2);
  });

  it('carries mcpId null when id is omitted', () => {
    const text = '`{"jsonrpc":"2.0","method":"tools/call","params":{"name":"fitCanvas","arguments":{}}}`';
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(1);
    expect(calls[0].mcpId).toBeNull();
  });

  it('expands prefixed IRI values in arguments', () => {
    const text = '`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"ex:Alice","typeIri":"owl:Class"}}}`';
    const calls = extractAllToolCalls(text, seen);
    expect(calls[0].params.iri).toBe('http://example.org/Alice');
    expect(calls[0].params.typeIri).toBe('http://www.w3.org/2002/07/owl#Class');
  });

  it('works when JSON appears without surrounding backticks (rendered <code>)', () => {
    // In rendered HTML the backtick wrapper is stripped by the browser; innerText has raw JSON
    const text = '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"fitCanvas","arguments":{}}}';
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('fitCanvas');
  });

  // ── Streaming safety ──────────────────────────────────────────────────

  it('skips truncated JSON (unbalanced braces — streaming in progress)', () => {
    const text = '`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":{';
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(0);
  });

  // ── False-positive guards ─────────────────────────────────────────────

  it('skips valid JSON with wrong method', () => {
    const text = '`{"jsonrpc":"2.0","id":1,"method":"other/method","params":{"name":"addNode","arguments":{}}}`';
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(0);
  });

  it('skips valid JSON missing params.name', () => {
    const text = '`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"arguments":{}}}`';
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(0);
  });

  it('skips non-MCP JSON objects in the text', () => {
    const text = 'Some context {"key":"value"} and more text without a tool call';
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(0);
  });

  // ── Deduplication ─────────────────────────────────────────────────────

  it('deduplicates identical calls across re-scans (streaming)', () => {
    const call = '`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://example.org/Alice"}}}`';
    const calls1 = extractAllToolCalls(call, seen);
    const calls2 = extractAllToolCalls(call, seen);
    expect(calls1).toHaveLength(1);
    expect(calls2).toHaveLength(0);
  });

  // ── Real-world AI output patterns ─────────────────────────────────────

  it('extracts calls embedded in prose with surrounding text', () => {
    const text = [
      'I will add two nodes to the graph.',
      '',
      '`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://example.org/Alice","label":"Alice"}}}`',
      '',
      'And then Bob:',
      '',
      '`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://example.org/Bob","label":"Bob"}}}`',
    ].join('\n');
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(2);
    expect(calls[0].tool).toBe('addNode');
    expect(calls[1].params.label).toBe('Bob');
  });

  it('handles empty arguments object', () => {
    const text = '`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fitCanvas","arguments":{}}}`';
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('fitCanvas');
    expect(calls[0].params).toEqual({});
  });

  it('returns empty array for text with no JSON', () => {
    const calls = extractAllToolCalls('just some plain text with no JSON at all', seen);
    expect(calls).toHaveLength(0);
  });
});
