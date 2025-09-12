import { describe, it, expect } from 'vitest';
import { deriveInitialNodeType } from '../components/Canvas/helpers/nodePropertyHelpers';
import { TemplateManager } from '../components/Canvas/core/TemplateManager';
import { useOntologyStore } from '../stores/ontologyStore';

describe('deriveInitialNodeType', () => {
  const classEntities = [
    {iri: 'http://example.org/Person', label: 'Person' },
    {iri: 'http://example.org/Organization', label: 'Organization' }
  ];

  it('prefers explicit canonical type (d.type)', () => {
    const d = { type: 'http://example.org/CustomType', rdfTypes: ['owl:NamedIndividual'] };
    expect(deriveInitialNodeType(d, classEntities)).toBe('http://example.org/CustomType');
  });

  it('prefers displayType when present', () => {
    const d = { displayType: 'http://example.org/DisplayType', rdfTypes: ['owl:NamedIndividual'] };
    expect(deriveInitialNodeType(d, classEntities)).toBe('http://example.org/DisplayType');
  });

  it('does not use classType if it is NamedIndividual', () => {
    const d = { classType: 'owl:NamedIndividual', rdfTypes: ['owl:NamedIndividual'] };
    expect(deriveInitialNodeType(d, classEntities)).toBe('');
  });

  it('uses first non-NamedIndividual from rdfTypes', () => {
    const d = { rdfTypes: ['owl:NamedIndividual', 'http://example.org/Person', 'http://example.org/Other'] };
    expect(deriveInitialNodeType(d, classEntities)).toBe('http://example.org/Person');
  });

  it('resolves short label to full URI using classEntities', () => {
    const d = { classType: 'Person' }; // short label
    expect(deriveInitialNodeType(d, classEntities)).toBe('http://example.org/Person');
  });

  it('returns empty string when only NamedIndividual is present', () => {
    const d = { rdfTypes: ['owl:NamedIndividual'] };
    expect(deriveInitialNodeType(d, classEntities)).toBe('');
  });
});

describe('TemplateManager.computeDisplayType', () => {
  // Ensure the ontology store exposes a rdfManager that can resolve the example.org namespace
  useOntologyStore.setState({
    getRdfManager: () => ({ getNamespaces: () => ({ ex: 'http://example.org/' }) }),
    rdfManager: { getNamespaces: () => ({ ex: 'http://example.org/' }) } as any,
  } as any);
  const tm = new TemplateManager();

  it('returns short local name for first non-NamedIndividual type', () => {
    const data = {
      rdfTypes: ['owl:NamedIndividual', 'http://example.org/Person']
    };
    const result = (tm as any).computeDisplayType(data);
    expect(result).toBe('ex:Person');
  });

  it('prefers type/displayType/classType before rdfTypes and filters NamedIndividual', () => {
    const data = { displayType: 'http://example.org/Display', rdfTypes: ['owl:NamedIndividual', 'http://example.org/Person'] };
    const result = (tm as any).computeDisplayType(data);
    expect(result).toBe('ex:Display');
  });

  it('returns empty string when only NamedIndividual is present', () => {
    const data = { rdfTypes: ['owl:NamedIndividual'] };
    const result = (tm as any).computeDisplayType(data);
    expect(result).toBe('');
  });

  it('handles arrays and mixed shapes', () => {
    const data = { types: ['http://example.org/TypeA', 'owl:NamedIndividual'] };
    const result = (tm as any).computeDisplayType(data);
    expect(result).toBe('ex:TypeA');
  });
});
