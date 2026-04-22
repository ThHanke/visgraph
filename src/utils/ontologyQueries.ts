import type { N3DataProvider } from '../providers/N3DataProvider';
import { toPrefixed } from './termUtils';

const OWL_METACLASSES = new Set([
  'http://www.w3.org/2002/07/owl#NamedIndividual',
  'http://www.w3.org/2002/07/owl#Class',
  'http://www.w3.org/2002/07/owl#ObjectProperty',
  'http://www.w3.org/2002/07/owl#DatatypeProperty',
  'http://www.w3.org/2002/07/owl#AnnotationProperty',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property',
  'http://www.w3.org/2002/07/owl#Thing',
  'http://www.w3.org/2000/01/rdf-schema#Resource',
]);

/** Pick the most specific domain class from a types array, skipping OWL metaclasses. */
export function pickDomainClass(types: readonly string[] | undefined): string {
  if (!types) return '';
  return types.find(t => !OWL_METACLASSES.has(t)) ?? '';
}

export interface FatMapEntity {
  iri: string;
  label?: string;
  prefixed?: string;
  domainRangeScore?: 0 | 1 | 2 | 3;
  [k: string]: any;
}

function getLabel(label: ReadonlyArray<{ value: string; language?: string }> | Record<string, string> | undefined): string | undefined {
  if (!label) return undefined;
  // Handle plain {lang: value} object (e.g. { en: 'knows' })
  if (!Array.isArray(label)) {
    const obj = label as Record<string, string>;
    return obj['en'] ?? obj[''] ?? Object.values(obj)[0];
  }
  if (label.length === 0) return undefined;
  const en = label.find(l => l.language === 'en');
  if (en) return en.value;
  return label[0].value;
}

function tryPrefixed(iri: string): string | undefined {
  try {
    const result = toPrefixed(iri);
    return (result && result !== iri) ? result : undefined;
  } catch { return undefined; }
}

export async function fetchClasses(dataProvider: N3DataProvider): Promise<FatMapEntity[]> {
  const graph = await dataProvider.knownElementTypes({});
  return graph.elementTypes.map(t => {
    const iri = String(t.id);
    return { iri, label: getLabel(t.label as any), prefixed: tryPrefixed(iri) };
  });
}

export async function fetchLinkTypes(dataProvider: N3DataProvider): Promise<FatMapEntity[]> {
  const types = await dataProvider.knownLinkTypes({});
  return types.map(t => {
    const iri = String(t.id);
    return { iri, label: getLabel(t.label as any), prefixed: tryPrefixed(iri) };
  });
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
