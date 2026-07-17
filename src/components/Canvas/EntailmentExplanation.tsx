import React from 'react';
import { HelpCircle } from 'lucide-react';
import { rdfManager } from '../../utils/rdfManager';
import { PrefixContext } from '../../providers/PrefixContext';
import { prefixShorten } from '../../providers/prefixShorten';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';
const SUBPROPERTY_OF = 'http://www.w3.org/2000/01/rdf-schema#subPropertyOf';

export interface ExplainTriple {
  subject: string;
  predicate: string;
  object: string;
  objectIsLiteral?: boolean;
}

type ExplainResult = Awaited<ReturnType<typeof rdfManager.explainEntailment>>;

function formatAxiom(
  axiom: { subject: string; predicate: string; object: string },
  prefixes: Record<string, string>,
): string {
  const shorten = (iri: string) => prefixShorten(iri, prefixes);
  const s = shorten(axiom.subject);
  const o = shorten(axiom.object);
  if (axiom.predicate === SUBCLASS_OF || axiom.predicate === SUBPROPERTY_OF) {
    return `${s} ⊑ ${o}`;
  }
  if (axiom.predicate === RDF_TYPE) {
    return `${s} rdf:type ${o}`;
  }
  return `${s} ${shorten(axiom.predicate)} ${o}`;
}

function formatResult(result: ExplainResult, prefixes: Record<string, string>): string {
  if (result.ontologyInconsistent) {
    return 'Cannot explain: ontology is inconsistent.';
  }
  if (result.isEntailed === false) {
    return 'Asserted triple (not inferred).';
  }
  if (result.vacuous) {
    return 'Holds vacuously (subject class is unsatisfiable).';
  }
  const justifications = Array.isArray(result.justifications)
    ? result.justifications.filter(j => Array.isArray(j) && j.length > 0)
    : [];
  if (justifications.length === 0) {
    return 'Inferred (no detailed justification available).';
  }
  const lines: string[] = ['Inferred because:'];
  for (const justification of justifications) {
    for (const axiom of justification) {
      lines.push(`  • ${formatAxiom(axiom, prefixes)}`);
    }
  }
  return lines.join('\n');
}

export interface EntailmentExplanationProps {
  triple: ExplainTriple;
  explain?: typeof rdfManager.explainEntailment;
  label?: string;
}

export function EntailmentExplanation(
  { triple, explain, label }: EntailmentExplanationProps,
): React.ReactElement {
  const [tooltip, setTooltip] = React.useState('Why was this inferred?');
  const loadedRef = React.useRef(false);
  const prefixes = React.useContext(PrefixContext);

  const triggerExplain = React.useCallback(
    () => {
      if (loadedRef.current) return;
      loadedRef.current = true;
      setTooltip('Explaining…');
      const call = explain ?? rdfManager.explainEntailment.bind(rdfManager);
      Promise.resolve(
        call(triple.subject, triple.predicate, triple.object, {
          objectIsLiteral: triple.objectIsLiteral,
        }),
      )
        .then(result => {
          setTooltip(formatResult(result, prefixes));
        })
        .catch((err: unknown) => {
          loadedRef.current = false;
          setTooltip(`Error: ${err instanceof Error ? err.message : String(err)}`);
        });
    },
    [explain, triple.subject, triple.predicate, triple.object, triple.objectIsLiteral, prefixes],
  );

  const ariaLabel = label ? `Explain inference: ${label}` : 'Explain inference';

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={tooltip}
      onMouseEnter={triggerExplain}
      onFocus={triggerExplain}
      onClick={e => { e.preventDefault(); e.stopPropagation(); }}
      onDoubleClick={e => { e.preventDefault(); e.stopPropagation(); }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 14,
        height: 14,
        padding: 0,
        marginLeft: 3,
        border: 'none',
        background: 'transparent',
        color: 'var(--vg-inferred-color)',
        cursor: 'pointer',
        opacity: 0.75,
        lineHeight: 0,
        verticalAlign: 'middle',
      }}
    >
      <HelpCircle size={12} aria-hidden />
    </button>
  );
}

export default EntailmentExplanation;
