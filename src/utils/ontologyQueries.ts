import type { N3DataProvider } from '../providers/N3DataProvider';
import { toPrefixed } from './termUtils';

export interface FatMapEntity {
  iri: string;
  label?: string;
  prefixed?: string;
  domainRangeScore?: 0 | 1 | 2 | 3;
  [k: string]: any;
}

function getLabel(label: Record<string, string> | undefined): string | undefined {
  if (!label) return undefined;
  return label['en'] ?? label[''] ?? Object.values(label)[0] ?? undefined;
}

function tryPrefixed(iri: string): string | undefined {
  try { return toPrefixed(iri) || undefined; } catch { return undefined; }
}

export async function fetchClasses(dataProvider: N3DataProvider): Promise<FatMapEntity[]> {
  const graph = await dataProvider.knownElementTypes({});
  return graph.elementTypes.map(t => ({
    iri:      t.id as string,
    label:    getLabel(t.label as Record<string, string> | undefined),
    prefixed: tryPrefixed(t.id as string),
  }));
}

export async function fetchLinkTypes(dataProvider: N3DataProvider): Promise<FatMapEntity[]> {
  const types = await dataProvider.knownLinkTypes({});
  return types.map(t => ({
    iri:      t.id as string,
    label:    getLabel(t.label as Record<string, string> | undefined),
    prefixed: tryPrefixed(t.id as string),
  }));
}

function computeScore(
  domains: string[], ranges: string[],
  src: string | undefined, tgt: string | undefined,
): 0 | 1 | 2 | 3 {
  const hasDomain = domains.length > 0;
  const hasRange  = ranges.length > 0;
  if (!hasDomain && !hasRange) return 2;
  const domainOk = !hasDomain || (!!src && domains.includes(src));
  const rangeOk  = !hasRange  || (!!tgt && ranges.includes(tgt));
  if (domainOk && rangeOk) return 0;
  if (domainOk || rangeOk) return 1;
  return 3;
}

export function scoreLinkTypes(
  entities: FatMapEntity[],
  sourceClassIri: string | undefined,
  targetClassIri: string | undefined,
  dataProvider: N3DataProvider,
): FatMapEntity[] {
  if (!sourceClassIri && !targetClassIri) return entities;
  return [...entities]
    .map(e => {
      const { domains, ranges } = dataProvider.getDomainRange(e.iri);
      return { ...e, domainRangeScore: computeScore(domains, ranges, sourceClassIri, targetClassIri) };
    })
    .sort((a, b) => (a.domainRangeScore ?? 2) - (b.domainRangeScore ?? 2));
}
