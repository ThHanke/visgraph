// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { workerQuadsToRdf } from '../quadConverter';

describe('workerQuadsToRdf', () => {
  it('converts a named-node quad', () => {
    const wq = {
      subject: { termType: 'NamedNode', value: 'http://ex.org/s' },
      predicate: { termType: 'NamedNode', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' },
      object: { termType: 'NamedNode', value: 'http://ex.org/Class' },
      graph: { termType: 'NamedNode', value: 'urn:vg:data' },
    };
    const [q] = workerQuadsToRdf([wq as any]);
    expect(q.subject.value).toBe('http://ex.org/s');
    expect(q.object.value).toBe('http://ex.org/Class');
  });
  it('converts a language-tagged literal', () => {
    const wq = {
      subject: { termType: 'NamedNode', value: 'http://ex.org/s' },
      predicate: { termType: 'NamedNode', value: 'http://www.w3.org/2000/01/rdf-schema#label' },
      object: { termType: 'Literal', value: 'Hello', language: 'en' },
      graph: { termType: 'DefaultGraph', value: '' },
    };
    const [q] = workerQuadsToRdf([wq as any]);
    expect(q.object.termType).toBe('Literal');
    expect(q.object.language).toBe('en');
  });
  it('converts a blank node', () => {
    const wq = {
      subject: { termType: 'BlankNode', value: 'b0' },
      predicate: { termType: 'NamedNode', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type' },
      object: { termType: 'NamedNode', value: 'http://ex.org/Class' },
      graph: { termType: 'DefaultGraph', value: '' },
    };
    const [q] = workerQuadsToRdf([wq as any]);
    expect(q.subject.termType).toBe('BlankNode');
  });
});
