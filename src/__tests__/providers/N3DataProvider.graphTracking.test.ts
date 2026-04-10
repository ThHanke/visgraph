// @vitest-environment node

import { describe, it, expect, beforeEach } from 'vitest';
import { DataFactory } from 'n3';
import { N3DataProvider } from '../../providers/N3DataProvider';
import type { ElementIri, LinkTypeIri } from '@reactodia/workspace';

const df = DataFactory;
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const INFERRED_TYPES_PROP = 'urn:vg:inferredTypes';
const INFERRED_DATA_PROPS_PROP = 'urn:vg:inferredDataProps';
const VG_GRAPH_NAME_PROP = 'urn:vg:graphName';

function quad(s: string, p: string, o: string) {
  return df.quad(df.namedNode(s), df.namedNode(p), df.namedNode(o), df.defaultGraph());
}
function litQuad(s: string, p: string, o: string) {
  return df.quad(df.namedNode(s), df.namedNode(p), df.literal(o), df.defaultGraph());
}

describe('N3DataProvider graph tracking', () => {
  let dp: N3DataProvider;

  beforeEach(() => {
    dp = new N3DataProvider();
  });

  it('does not mark asserted types with urn:vg:inferredTypes', async () => {
    dp.addGraph([quad('ex:Alice', RDF_TYPE, 'ex:Employee')]);
    const result = await dp.elements({ elementIds: ['ex:Alice' as ElementIri] });
    const alice = result.get('ex:Alice' as ElementIri)!;
    expect(alice.properties[INFERRED_TYPES_PROP]).toBeUndefined();
  });

  it('marks inferred rdf:type in urn:vg:inferredTypes synthetic property', async () => {
    dp.addGraph([quad('ex:Alice', RDF_TYPE, 'ex:Employee')]);
    dp.addGraph([quad('ex:Alice', RDF_TYPE, 'ex:Person')], 'urn:vg:inferred');

    const result = await dp.elements({ elementIds: ['ex:Alice' as ElementIri] });
    const alice = result.get('ex:Alice' as ElementIri)!;

    expect(alice.types).toContain('ex:Employee' as any);
    expect(alice.types).toContain('ex:Person' as any);

    const inferredTypes = alice.properties[INFERRED_TYPES_PROP];
    expect(inferredTypes).toBeDefined();
    expect(inferredTypes!.map(v => v.value)).toContain('ex:Person');
    expect(inferredTypes!.map(v => v.value)).not.toContain('ex:Employee');
  });

  it('marks inferred annotation property predicates in urn:vg:inferredDataProps', async () => {
    dp.addGraph([litQuad('ex:Alice', 'ex:name', 'Alice')]);
    dp.addGraph([litQuad('ex:Alice', 'ex:role', 'Inferred Role')], 'urn:vg:inferred');

    const result = await dp.elements({ elementIds: ['ex:Alice' as ElementIri] });
    const alice = result.get('ex:Alice' as ElementIri)!;

    const inferredProps = alice.properties[INFERRED_DATA_PROPS_PROP];
    expect(inferredProps).toBeDefined();
    expect(inferredProps!.map(v => v.value)).toContain('ex:role');
    expect(inferredProps!.map(v => v.value)).not.toContain('ex:name');
  });

  it('does not expose urn:vg:inferredTypes or urn:vg:inferredDataProps as visible properties', async () => {
    dp.addGraph([quad('ex:Alice', RDF_TYPE, 'ex:Person')], 'urn:vg:inferred');

    const result = await dp.elements({ elementIds: ['ex:Alice' as ElementIri] });
    const alice = result.get('ex:Alice' as ElementIri)!;

    const inferredTypes = alice.properties[INFERRED_TYPES_PROP];
    if (inferredTypes) {
      expect(inferredTypes.every(v => v.termType === 'NamedNode')).toBe(true);
    }
  });

  it('marks inferred object-property links with urn:vg:graphName', async () => {
    dp.addGraph([quad('ex:Alice', 'ex:manages', 'ex:Dave')]);
    dp.addGraph([quad('ex:Alice', 'ex:isColleagueOf', 'ex:Dave')], 'urn:vg:inferred');

    const links = await dp.links({
      primary: ['ex:Alice' as ElementIri],
      secondary: ['ex:Dave' as ElementIri],
    });

    const assertedLink = links.find(l => l.linkTypeId === ('ex:manages' as LinkTypeIri));
    const inferredLink = links.find(l => l.linkTypeId === ('ex:isColleagueOf' as LinkTypeIri));

    expect(assertedLink).toBeDefined();
    expect(assertedLink!.properties[VG_GRAPH_NAME_PROP]).toBeUndefined();

    expect(inferredLink).toBeDefined();
    const graphNameVal = inferredLink!.properties[VG_GRAPH_NAME_PROP];
    expect(graphNameVal).toBeDefined();
    expect(graphNameVal![0].termType).toBe('NamedNode');
    expect(graphNameVal![0].value).toBe('urn:vg:inferred');
  });

  it('clears inferred tracking on replaceSubjectQuads', async () => {
    dp.addGraph([quad('ex:Alice', RDF_TYPE, 'ex:Person')], 'urn:vg:inferred');

    dp.replaceSubjectQuads(
      ['ex:Alice'],
      [quad('ex:Alice', RDF_TYPE, 'ex:Employee')],
    );

    const result = await dp.elements({ elementIds: ['ex:Alice' as ElementIri] });
    const alice = result.get('ex:Alice' as ElementIri)!;
    expect(alice.properties[INFERRED_TYPES_PROP]).toBeUndefined();
  });

  it('re-tracks inferred triples when replaceSubjectQuads passes graphName', async () => {
    dp.addGraph([quad('ex:Alice', RDF_TYPE, 'ex:Employee')]);
    dp.replaceSubjectQuads(
      ['ex:Alice'],
      [
        quad('ex:Alice', RDF_TYPE, 'ex:Employee'),
        quad('ex:Alice', RDF_TYPE, 'ex:Person'),
      ],
      'urn:vg:inferred',
    );

    const result = await dp.elements({ elementIds: ['ex:Alice' as ElementIri] });
    const alice = result.get('ex:Alice' as ElementIri)!;
    const inferredTypes = alice.properties[INFERRED_TYPES_PROP];
    expect(inferredTypes).toBeDefined();
    expect(inferredTypes!.map(v => v.value)).toContain('ex:Person');
    expect(inferredTypes!.map(v => v.value)).toContain('ex:Employee');
  });
});
