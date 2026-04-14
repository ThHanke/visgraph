import React from 'react';
import * as Reactodia from '@reactodia/workspace';
import { ProvActivityTemplate } from './ProvActivityTemplate';
import { useOntologyStore } from '@/stores/ontologyStore';
import { PrefixContext } from '@/providers/PrefixContext';
import { prefixShorten } from '@/providers/prefixShorten';
import { INFERRED_TYPES_PROP, INFERRED_DATA_PROPS_PROP, VG_GRAPH_NAME_PROP, SYNTHETIC_VG_PROPS } from '../providers/N3DataProvider';

const RDF_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

function extractNamespace(iri: string): string {
  const hash = iri.lastIndexOf('#');
  if (hash > 0) return iri.slice(0, hash + 1);
  const slash = iri.lastIndexOf('/');
  if (slash > 0) return iri.slice(0, slash + 1);
  return iri;
}

type NSEntry = { prefix: string; namespace: string; color: string };

function getLabel(
  data: Reactodia.ElementModel,
  prefixes: Record<string, string>,
  registry: ReadonlyArray<NSEntry>,
): string {
  const labels = data.properties[RDF_LABEL];
  if (labels && labels.length > 0) {
    const lit = labels[0];
    if (lit.termType === 'Literal') return lit.value;
  }
  const reg = Object.keys(prefixes).length > 0
    ? registry.map(e => ({ ...e, namespace: prefixes[e.prefix] ?? e.namespace }))
    : registry;
  return prefixShorten(data.id, Object.fromEntries(reg.map(e => [e.prefix, e.namespace])));
}

function getNamespaceColor(iri: string, registry: ReadonlyArray<NSEntry>): string {
  const ns = extractNamespace(iri);
  for (const entry of registry) {
    if (entry.namespace && (iri.startsWith(entry.namespace) || entry.namespace === ns)) {
      return entry.color || '#C7B2FE';
    }
  }
  return '#C7B2FE';
}

interface PropertyEntry {
  keyIri: string;
  keyShort: string;
  values: string[];
}

function getProperties(
  data: Reactodia.ElementModel,
  prefixes: Record<string, string>,
): PropertyEntry[] {
  const result: PropertyEntry[] = [];
  for (const [propIri, values] of Object.entries(data.properties)) {
    if (propIri === RDF_LABEL || SYNTHETIC_VG_PROPS.has(propIri)) continue;
    if (!values || values.length === 0) continue;
    const literals = values.filter(v => v.termType === 'Literal');
    if (literals.length === 0) continue;
    result.push({
      keyIri: propIri,
      keyShort: prefixShorten(propIri, prefixes),
      values: literals.map(v => (v as Reactodia.Rdf.Literal).value),
    });
  }
  return result;
}

function RdfElementBody({ props }: { props: Reactodia.TemplateProps }) {
  const { element, isExpanded, onlySelected } = props;
  const { model, editor } = Reactodia.useWorkspace();

  // Track authoring state to detect changed properties
  const authoringEvent = Reactodia.useObservedProperty(
    editor.events,
    'changeAuthoringState',
    () => element instanceof Reactodia.EntityElement
      ? editor.authoringState.elements.get(element.data.id)
      : undefined
  );
  const beforeData = authoringEvent?.type === 'entityChange' ? authoringEvent.before : undefined;

  const registry = useOntologyStore(
    s => (Array.isArray(s.namespaceRegistry) ? s.namespaceRegistry : [])
  );
  const prefixes = React.useContext(PrefixContext);

  if (!(element instanceof Reactodia.EntityElement)) return null;

  const data = element.data;
  const label = getLabel(data, prefixes, registry);
  const nsColor = getNamespaceColor(data.id, registry);

  // Type labels — prefer prefix-shortened IRI (e.g. owl:NamedIndividual), fall back to
  // model-loaded label, then bare local name
  const typeLabels = data.types.map(typeIri => {
    const shortened = prefixShorten(typeIri, prefixes);
    // prefixShorten returns the full IRI unchanged when no prefix matches
    if (shortened !== typeIri) return shortened;
    const typeEl = model.getElementType(typeIri);
    return typeEl?.data?.label?.[0]?.value ?? shortened;
  });

  // Icon letter from label
  const iconLetter = label.replace(/^[^a-zA-Z0-9]*/, '').charAt(0).toUpperCase() || '✳';

  const properties = getProperties(data, prefixes);
  const inferredTypesSet = new Set<string>(
    (data.properties[INFERRED_TYPES_PROP] ?? []).map(v => v.value)
  );
  const inferredDataPropsSet = new Set<string>(
    (data.properties[INFERRED_DATA_PROPS_PROP] ?? []).map(v => v.value)
  );

  const onDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    model.history.execute(Reactodia.setElementExpanded(element, !isExpanded));
  };

  return (
    <div
      onDoubleClick={onDoubleClick}
      style={{
        display: 'flex',
        flexDirection: 'row',
        minWidth: 180,
        maxWidth: 320,
        background: 'var(--reactodia-paper-bg)',
        borderRadius: 6,
        border: onlySelected
          ? '2px solid var(--reactodia-selection-color, #3b82f6)'
          : '1px solid var(--reactodia-paper-border, #d1d5db)',
        overflow: 'hidden',
        boxShadow: onlySelected
          ? '0 0 0 2px rgba(59,130,246,0.25)'
          : '0 1px 3px rgba(0,0,0,0.1)',
        fontSize: 12,
        fontFamily: 'inherit',
        cursor: 'default',
        userSelect: 'none',
      }}
    >
      {/* Left namespace color bar */}
      <div style={{
        width: 6,
        flexShrink: 0,
        background: nsColor,
      }} />

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>

        {/* Types row */}
        {typeLabels.length > 0 && (
          <div
            style={{
              padding: '3px 8px 0',
              fontSize: 10,
              color: 'var(--reactodia-paper-fg-muted, #6b7280)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={data.types.join(', ')}
          >
            {typeLabels.map((label, i) => (
              <span
                key={data.types[i]}
                style={inferredTypesSet.has(data.types[i])
                  ? { fontStyle: 'italic', color: 'var(--vg-inferred-color)', opacity: 0.9 }
                  : undefined}
              >
                {i > 0 ? ', ' : ''}{label}
              </span>
            ))}
          </div>
        )}

        {/* Main row: icon + label */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px 4px' }}>
          <div style={{
            flexShrink: 0,
            width: 26,
            height: 26,
            borderRadius: 4,
            background: nsColor,
            color: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 700,
            fontSize: 13,
          }}>
            {iconLetter}
          </div>
          <span
            style={{
              flex: 1,
              fontWeight: 600,
              fontSize: 13,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--reactodia-paper-fg)',
            }}
            title={data.id}
          >
            {label}
          </span>
        </div>

        {/* Expanded panel */}
        {isExpanded && (
          <div style={{
            borderTop: '1px solid var(--reactodia-paper-border, #e5e7eb)',
            padding: '6px 8px 6px',
            display: 'flex',
            flexDirection: 'column',
            gap: 5,
            maxHeight: 280,
            overflowY: 'auto',
          }}>
            {/* IRI */}
            <div>
              <div style={{ fontSize: 10, color: 'var(--reactodia-paper-fg-muted, #9ca3af)', fontWeight: 600, marginBottom: 1 }}>
                IRI
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--reactodia-paper-fg-muted, #6b7280)',
                  wordBreak: 'break-all',
                  lineHeight: 1.4,
                  ...(beforeData && beforeData.id !== data.id
                    ? { borderLeft: '3px solid var(--reactodia-color-primary)', paddingLeft: 4 }
                    : {}),
                }}
                title={data.id}
              >
                {data.id}
              </div>
            </div>

            {/* Annotation properties */}
            {properties.length > 0 && (
              <div style={{ borderTop: '1px solid var(--reactodia-paper-border, #f3f4f6)', paddingTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
                {properties.map(({ keyIri, keyShort, values }) => {
                  const beforeValues = beforeData?.properties[keyIri];
                  const beforeStrings = beforeValues?.map(v => v.value) ?? [];
                  const isNew = beforeData && !beforeValues;
                  const isChanged = beforeData && beforeValues &&
                    JSON.stringify(values) !== JSON.stringify(beforeStrings);
                  const isInferredProp = inferredDataPropsSet.has(keyIri);
                  const changeColor = isNew ? 'var(--reactodia-color-success)'
                    : isChanged ? 'var(--reactodia-color-primary)'
                    : undefined;
                  return (
                  <div key={keyIri}>
                    <div
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        color: isInferredProp ? 'var(--vg-inferred-color)' : 'var(--reactodia-paper-fg-muted, #9ca3af)',
                        fontStyle: isInferredProp ? 'italic' : undefined,
                        opacity: isInferredProp ? 0.85 : undefined,
                      }}
                      title={keyIri}
                    >
                      {keyShort}
                    </div>
                    {/* Old values struck through when changed */}
                    {isChanged && beforeStrings.map((old, i) => (
                      <div key={`old-${i}`} style={{
                        fontSize: 11,
                        color: 'var(--reactodia-paper-fg-muted)',
                        lineHeight: 1.5,
                        paddingLeft: 6,
                        borderLeft: `2px solid var(--reactodia-color-danger)`,
                        marginLeft: 2,
                        marginTop: 1,
                        textDecoration: 'line-through',
                        opacity: 0.7,
                      }}>{old}</div>
                    ))}
                    {values.map((val, i) => (
                      <div
                        key={i}
                        style={{
                          fontSize: 11,
                          color: 'var(--reactodia-paper-fg)',
                          fontStyle: isInferredProp ? 'italic' : undefined,
                          opacity: isInferredProp ? 0.75 : undefined,
                          lineHeight: 1.5,
                          paddingLeft: 6,
                          borderLeft: `2px solid ${changeColor ?? nsColor}`,
                          marginLeft: 2,
                          marginTop: 1,
                          userSelect: 'text',
                        }}
                      >
                        {val}
                      </div>
                    ))}
                  </div>
                  );
                })}
              </div>
            )}

            {properties.length === 0 && (
              <div style={{ fontSize: 10, color: 'var(--reactodia-paper-fg-muted, #9ca3af)', fontStyle: 'italic' }}>
                No annotation properties
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}

export const RdfElementTemplate: Reactodia.ElementTemplate = {
  renderElement: (props: Reactodia.TemplateProps) => <RdfElementBody props={props} />,
  supports: {
    [Reactodia.TemplateProperties.Expanded]: true,
  },
};

const PROV_ACTIVITY_IRI = 'http://www.w3.org/ns/prov#Activity';

export function rdfElementTemplateResolver(
  _types: readonly string[],
  element: Reactodia.Element
): Reactodia.ElementTemplate {
  if (element instanceof Reactodia.EntityGroup) {
    return Reactodia.StandardTemplate;
  }
  if (element instanceof Reactodia.EntityElement &&
      element.data.types.includes(PROV_ACTIVITY_IRI as Reactodia.ElementTypeIri)) {
    return ProvActivityTemplate;
  }
  return RdfElementTemplate;
}
