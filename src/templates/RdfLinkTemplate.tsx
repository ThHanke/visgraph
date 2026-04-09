import React from 'react';
import * as Reactodia from '@reactodia/workspace';
import { IS_INFERRED_PROP } from '../providers/N3DataProvider';

function isInferred(link: Reactodia.Link): boolean {
  if (link instanceof Reactodia.RelationLink) {
    const props = link.data?.properties;
    return !!(props && props[IS_INFERRED_PROP] && props[IS_INFERRED_PROP].length > 0);
  }
  return false;
}

interface RdfLinkBodyProps extends Reactodia.LinkTemplateProps {
  inferred: boolean;
}

function RdfLinkBody({ inferred, ...rest }: RdfLinkBodyProps) {
  return (
    <Reactodia.StandardRelation
      {...rest}
      pathProps={inferred ? {
        strokeDasharray: '6 3',
        stroke: 'var(--vg-inferred-color)',
      } : undefined}
      primaryLabelProps={inferred ? {
        style: { color: 'var(--vg-inferred-color)' },
      } : undefined}
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
