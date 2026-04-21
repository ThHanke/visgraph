// @vitest-environment node
/**
 * Unit tests for the TOOL block parser logic from relay-bookmarklet.js.
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

interface ToolCall { tool: string; params: Record<string, unknown> }

function extractAllToolCalls(text: string, seen = new Set<string>()): ToolCall[] {
  const stripped = text.replace(/^```[^\n]*\n([\s\S]*?)^```/gm, '$1');
  const calls: ToolCall[] = [];
  const parts = stripped.split(/^TOOL:\s*/m);

  for (let i = 1; i < parts.length; i++) {
    const lines = parts[i].split('\n');
    const firstLine = lines[0].trim();
    const toolMatch = firstLine.match(/^(\w+)(.*)/);
    if (!toolMatch) continue;
    const tool = toolMatch[1];
    const params: Record<string, unknown> = {};

    function parseParamLine(line: string) {
      line = line.trim();
      if (!line) return;
      const kv = line.match(/^(\w+):\s*(.+)/);
      if (kv && !/\s+\w+:/.test(kv[2])) {
        let v = kv[2].trim();
        if (v.indexOf(':') !== -1 && v.indexOf(' ') === -1) v = expandPrefix(v);
        params[kv[1]] = v === 'true' ? true : v === 'false' ? false
          : (!isNaN(+v) && v !== '') ? +v : v;
        return;
      }
      // Inline multi-param: match each key-value pair stopping before next \s+word:
      // This correctly handles IRI values that contain "http:" or "https:".
      const pairRe = /(\w+):\s*(.*?)(?=\s+\w+:|$)/g;
      let mp: RegExpExecArray | null;
      while ((mp = pairRe.exec(line)) !== null) {
        let v = mp[2].trim();
        if (!v) continue;
        if (v.indexOf(':') !== -1 && v.indexOf(' ') === -1) v = expandPrefix(v);
        params[mp[1]] = v === 'true' ? true : v === 'false' ? false
          : (!isNaN(+v) && v !== '') ? +v : v;
      }
    }

    const inlineRest = toolMatch[2].trim();
    if (inlineRest) parseParamLine(inlineRest);
    for (let j = 1; j < lines.length; j++) parseParamLine(lines[j]);

    const sig = tool + ':' + JSON.stringify(params);
    if (!seen.has(sig)) {
      seen.add(sig);
      calls.push({ tool, params });
    }
  }
  return calls;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('extractAllToolCalls', () => {
  let seen: Set<string>;
  beforeEach(() => { seen = new Set(); });

  it('parses a single TOOL block', () => {
    const text = 'TOOL: addNode\niri: http://example.org/Alice\nlabel: Alice';
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('addNode');
    expect(calls[0].params.iri).toBe('http://example.org/Alice');
    expect(calls[0].params.label).toBe('Alice');
  });

  it('parses multiple TOOL blocks', () => {
    const text = [
      'TOOL: addNode',
      'iri: http://example.org/Alice',
      'label: Alice',
      '',
      'TOOL: addNode',
      'iri: http://example.org/Bob',
      'label: Bob',
    ].join('\n');
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(2);
    expect(calls[0].params.label).toBe('Alice');
    expect(calls[1].params.label).toBe('Bob');
  });

  it('strips markdown fences', () => {
    const text = '```text\nTOOL: addNode\niri: http://example.org/Fenced\nlabel: Fenced\n```';
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(1);
    expect(calls[0].params.label).toBe('Fenced');
  });

  it('expands prefixed IRIs', () => {
    const text = 'TOOL: addNode\niri: ex:Alice\ntypeIri: owl:Class';
    const calls = extractAllToolCalls(text, seen);
    expect(calls[0].params.iri).toBe('http://example.org/Alice');
    expect(calls[0].params.typeIri).toBe('http://www.w3.org/2002/07/owl#Class');
  });

  it('parses inline params on same line as tool name', () => {
    const text = 'TOOL: addNode iri: http://example.org/Inline label: InlineNode typeIri: http://example.org/Thing';
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('addNode');
    expect(calls[0].params.iri).toBe('http://example.org/Inline');
    expect(calls[0].params.label).toBe('InlineNode');
  });

  it('coerces boolean values', () => {
    const text = 'TOOL: exportImage\nformat: svg\nnoCss: true\ncompact: false';
    const calls = extractAllToolCalls(text, seen);
    expect(calls[0].params.noCss).toBe(true);
    expect(calls[0].params.compact).toBe(false);
  });

  it('coerces numeric values', () => {
    const text = 'TOOL: someOp\ncount: 42\nfactor: 3.14';
    const calls = extractAllToolCalls(text, seen);
    expect(calls[0].params.count).toBe(42);
    expect(calls[0].params.factor).toBe(3.14);
  });

  it('deduplicates identical calls (dispatchedSigs)', () => {
    const block = 'TOOL: addNode\niri: http://example.org/Alice\nlabel: Alice';
    const calls1 = extractAllToolCalls(block, seen);
    const calls2 = extractAllToolCalls(block, seen);
    expect(calls1).toHaveLength(1);
    expect(calls2).toHaveLength(0); // already in seen
  });

  it('handles TOOL block with no params', () => {
    const text = 'TOOL: fitCanvas';
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('fitCanvas');
    expect(calls[0].params).toEqual({});
  });

  it('handles runLayout with algorithm param', () => {
    const text = 'TOOL: runLayout\nalgorithm: dagre-lr';
    const calls = extractAllToolCalls(text, seen);
    expect(calls[0].tool).toBe('runLayout');
    expect(calls[0].params.algorithm).toBe('dagre-lr');
  });

  it('handles addLink with literal objectIri', () => {
    const text = [
      'TOOL: addLink',
      'subjectIri: http://example.org/Alice',
      'predicateIri: http://example.org/role',
      'objectIri: Chief Executive',
    ].join('\n');
    const calls = extractAllToolCalls(text, seen);
    expect(calls[0].params.objectIri).toBe('Chief Executive');
  });

  it('does not expand values that contain spaces (literals)', () => {
    const text = 'TOOL: addNode\niri: http://example.org/X\nlabel: some label with spaces';
    const calls = extractAllToolCalls(text, seen);
    expect(calls[0].params.label).toBe('some label with spaces');
  });

  it('parses real FhGenie-style message with surrounding prose', () => {
    const text = [
      'I will add three nodes to the graph.',
      '',
      'TOOL: addNode',
      'iri: http://example.org/Alice',
      'label: Alice',
      'typeIri: http://example.org/Person',
      '',
      'TOOL: addNode',
      'iri: http://example.org/Bob',
      'label: Bob',
      'typeIri: http://example.org/Person',
      '',
      'TOOL: runLayout',
      'algorithm: dagre-lr',
      '',
      'TOOL: fitCanvas',
    ].join('\n');
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(4);
    expect(calls.map(c => c.tool)).toEqual(['addNode', 'addNode', 'runLayout', 'fitCanvas']);
  });

  it('Open WebUI: markdown prose with leading/trailing text per paragraph', () => {
    // Open WebUI renders assistant messages as <div class="prose">; innerText looks like this:
    const text = [
      'Ich werde jetzt die Knoten zum Graphen hinzufügen.',
      '',
      'TOOL: addNode',
      'iri: http://example.org/Alice',
      'label: Alice',
      'typeIri: http://xmlns.com/foaf/0.1/Person',
      '',
      'TOOL: addNode',
      'iri: http://example.org/Bob',
      'label: Bob',
      'typeIri: http://xmlns.com/foaf/0.1/Person',
      '',
      'TOOL: addLink',
      'subjectIri: http://example.org/Alice',
      'predicateIri: http://xmlns.com/foaf/0.1/knows',
      'objectIri: http://example.org/Bob',
      '',
      'TOOL: runLayout',
      'algorithm: dagre-lr',
      '',
      'TOOL: fitCanvas',
      '',
      'Die Knoten wurden erfolgreich hinzugefügt.',
    ].join('\n');
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(5);
    expect(calls[0].tool).toBe('addNode');
    expect(calls[0].params.iri).toBe('http://example.org/Alice');
    expect(calls[0].params.typeIri).toBe('http://xmlns.com/foaf/0.1/Person');
    expect(calls[2].tool).toBe('addLink');
    expect(calls[2].params.subjectIri).toBe('http://example.org/Alice');
    expect(calls[2].params.objectIri).toBe('http://example.org/Bob');
    expect(calls[3].tool).toBe('runLayout');
    expect(calls[3].params.algorithm).toBe('dagre-lr');
  });

  it('ChatGPT: fenced code blocks with prose between', () => {
    // ChatGPT wraps TOOL blocks in ```text fences; prose renders as plain paragraphs:
    const text = [
      'Hier sind die Tool-Aufrufe für den Wissensgraphen:',
      '',
      '```text',
      'TOOL: addNode',
      'iri: http://example.org/Alice',
      'label: Alice',
      'typeIri: http://example.org/Person',
      '```',
      '',
      'Und ein weiterer Knoten:',
      '',
      '```',
      'TOOL: addNode',
      'iri: http://example.org/Bob',
      'label: Bob',
      'typeIri: http://example.org/Person',
      '```',
      '',
      'Abschließend das Layout:',
      '',
      '```',
      'TOOL: runLayout',
      'algorithm: dagre-lr',
      '',
      'TOOL: fitCanvas',
      '',
      'TOOL: exportImage',
      'format: svg',
      'noCss: true',
      '```',
    ].join('\n');
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(5);
    expect(calls[0].params.iri).toBe('http://example.org/Alice');
    expect(calls[1].params.iri).toBe('http://example.org/Bob');
    expect(calls[2].tool).toBe('runLayout');
    expect(calls[4].params.format).toBe('svg');
    expect(calls[4].params.noCss).toBe(true);
  });

  it('FhGenie GPT-5.1: prose before each block, no code fences', () => {
    // FhGenie shows raw assistant text without fences
    const text = [
      'Ich lese zunächst die Tool-Liste von VisGraph.',
      '',
      'TOOL: getGraphState',
      '',
      'Gut. Jetzt füge ich Alice und Bob hinzu.',
      '',
      'TOOL: addNode',
      'iri: http://example.org/Alice',
      'label: Alice',
      'typeIri: http://example.org/Person',
      '',
      'TOOL: addNode',
      'iri: http://example.org/Bob',
      'label: Bob',
      'typeIri: http://example.org/Person',
      '',
      'TOOL: addLink',
      'subjectIri: http://example.org/Alice',
      'predicateIri: http://example.org/knows',
      'objectIri: http://example.org/Bob',
      '',
      'TOOL: runLayout',
      'algorithm: dagre-lr',
      '',
      'TOOL: fitCanvas',
      '',
      'TOOL: exportImage',
      'format: svg',
      'noCss: true',
    ].join('\n');
    const calls = extractAllToolCalls(text, seen);
    expect(calls).toHaveLength(7);
    expect(calls[0].tool).toBe('getGraphState');
    expect(calls[1].tool).toBe('addNode');
    expect(calls[3].tool).toBe('addLink');
    expect(calls[6].params.noCss).toBe(true);
  });
});
