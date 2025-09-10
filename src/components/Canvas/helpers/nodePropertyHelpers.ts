/**
 * Derive the initial node type (canonical URI) from node data.
 * Prioritizes: d.type, d.displayType, d.classType, and rdfTypes (excluding NamedIndividual).
 * Returns a full URI when possible (the caller may map short labels to URIs via classEntities).
 */
export function deriveInitialNodeType(d: any, classEntities: Array<{uri:string,label:string}>) {
  if (!d) return '';
  let initialNodeType = '';

  // Priority:
  // 1) explicit canonical type (d.type)
  // 2) explicit displayType (d.displayType)
  // 3) classType only if it's not a NamedIndividual marker
  // 4) rdfTypes array (filtering out NamedIndividual)
  // Only accept explicit canonical/display type if it is not a NamedIndividual marker.
  // Some data sources set type/displayType to the literal 'NamedIndividual' which is not a meaningful class.
  if (d.type && !String(d.type).includes('NamedIndividual')) {
    initialNodeType = d.type;
  } else if (d.displayType && !String(d.displayType).includes('NamedIndividual')) {
    initialNodeType = d.displayType;
  } else if (d.classType && !String(d.classType).includes('NamedIndividual')) {
    initialNodeType = d.classType;
  } else if (d.rdfTypes && Array.isArray(d.rdfTypes)) {
    const meaningfulTypes = d.rdfTypes.filter((type: string) => type && !type.includes('NamedIndividual'));
    // Avoid falling back to a NamedIndividual marker. Only use d.rdfType when it is not a NamedIndividual.
    if (meaningfulTypes.length > 0) {
      initialNodeType = meaningfulTypes[0];
    } else if (d.rdfType && !String(d.rdfType).includes('NamedIndividual')) {
      initialNodeType = d.rdfType;
    } else {
      initialNodeType = '';
    }
  }

  // If the type looks like a short label (not a full URI) try to map to a full URI via available classEntities
  if (initialNodeType && !initialNodeType.includes(':') && !initialNodeType.startsWith('http')) {
    const match = classEntities.find(e =>
      e.label === initialNodeType || e.uri.endsWith(`/${initialNodeType}`) || e.uri.endsWith(`#${initialNodeType}`)
    );
    if (match) initialNodeType = match.uri;
  }

  return initialNodeType || '';
}
