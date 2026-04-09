import React from 'react';
import * as Reactodia from '@reactodia/workspace';
import { VG_GRAPH_NAME_PROP, VG_GRAPH_NAME_STATE } from '../providers/N3DataProvider';

function isInferred(link: Reactodia.Link): boolean {
  if (!(link instanceof Reactodia.RelationLink)) return false;
  // linkState persists across importLayout (serialized in diagram snapshot).
  if (link.linkState?.get(VG_GRAPH_NAME_STATE) === 'urn:vg:inferred') return true;
  // data.properties fallback for the initial render right after reasoning.
  const graphName = link.data?.properties[VG_GRAPH_NAME_PROP]?.[0];
  return graphName?.termType === 'NamedNode' && graphName.value === 'urn:vg:inferred';
}

interface RdfLinkBodyProps extends Reactodia.LinkTemplateProps {
  inferred: boolean;
}

function RdfLinkBody({ inferred, ...rest }: RdfLinkBodyProps) {
  return (
    <Reactodia.StandardRelation
      {...rest}
      pathProps={inferred ? { strokeDasharray: '6 3', stroke: 'var(--vg-inferred-color)' } : undefined}
      primaryLabelProps={inferred ? { style: { color: 'var(--vg-inferred-color)', fontStyle: 'italic' } } : undefined}
      // Hide the synthetic urn:vg:graphName property — it must not render as a visible label
      propertyLabelProps={(iri) => iri === VG_GRAPH_NAME_PROP ? null : undefined}
    />
  );
}

export const RdfLinkTemplate: Reactodia.LinkTemplate = {
  markerTarget: Reactodia.LinkMarkerArrowhead,
  renderLink: (props: Reactodia.LinkTemplateProps) => {
    const inferred = isInferred(props.link);
    return <RdfLinkBody {...props} inferred={inferred} />;
  },
};

export function rdfLinkTemplateResolver(
  _linkType: Reactodia.LinkTypeIri | undefined,
  _link: Reactodia.Link
): Reactodia.LinkTemplate {
  return RdfLinkTemplate;
}
