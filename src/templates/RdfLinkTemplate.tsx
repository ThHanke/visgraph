import React from 'react';
import * as Reactodia from '@reactodia/workspace';
const INFERRED_PRED = 'urn:vg:isInferred';

function isInferred(link: Reactodia.Link): boolean {
  if (link instanceof Reactodia.RelationLink) {
    const props = link.data?.properties;
    return !!(props && props[INFERRED_PRED] && props[INFERRED_PRED].length > 0);
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
      pathProps={inferred ? { strokeDasharray: '6 3' } : undefined}
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

// Canvas.linkTemplateResolver signature: (linkType: LinkTypeIri | undefined, link: Link) => LinkTemplate | undefined
export function rdfLinkTemplateResolver(
  _linkType: Reactodia.LinkTypeIri | undefined,
  _link: Reactodia.Link
): Reactodia.LinkTemplate {
  return RdfLinkTemplate;
}
