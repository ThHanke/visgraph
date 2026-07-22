import React from 'react';
import ReactDOM from 'react-dom';
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
  if (axiom.predicate === SUBCLASS_OF || axiom.predicate === SUBPROPERTY_OF) return `${s} ⊑ ${o}`;
  if (axiom.predicate === RDF_TYPE) return `${s} rdf:type ${o}`;
  return `${s} ${shorten(axiom.predicate)} ${o}`;
}

function formatResult(result: ExplainResult, prefixes: Record<string, string>): string {
  if (result.ontologyInconsistent) return 'Cannot explain: ontology is inconsistent.';
  if (result.isEntailed === false) return 'Asserted (not inferred).';
  if (result.vacuous) return 'Holds vacuously (unsatisfiable class).';
  const justs = (result.justifications ?? []).filter(j => Array.isArray(j) && j.length > 0);
  if (justs.length === 0) return 'Inferred (no justification available).';
  const lines = ['Inferred because:'];
  for (const j of justs) for (const ax of j) lines.push(`  • ${formatAxiom(ax, prefixes)}`);
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
  const [text, setText] = React.useState<string | null>(null);
  const [hovered, setHovered] = React.useState(false);
  const [pos, setPos] = React.useState({ x: 0, y: 0 });
  const btnRef = React.useRef<HTMLButtonElement>(null);
  const asked = React.useRef(false);
  const prefixes = React.useContext(PrefixContext);

  const onEnter = React.useCallback(() => {
    setHovered(true);
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ x: r.left + r.width / 2, y: r.top });

    if (asked.current) return;
    asked.current = true;
    const call = explain ?? rdfManager.explainEntailment.bind(rdfManager);
    call(triple.subject, triple.predicate, triple.object, {
      objectIsLiteral: triple.objectIsLiteral,
    }).then(result => {
      const formatted = formatResult(result, prefixes);
      setText(formatted);
    }).catch((err: unknown) => {
      asked.current = false;
      setText(`Error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, [explain, triple.subject, triple.predicate, triple.object, triple.objectIsLiteral, prefixes]);

  const onLeave = React.useCallback(() => setHovered(false), []);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label ? `Explain inference: ${label}` : 'Explain inference'}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={onEnter}
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
      {hovered && text && ReactDOM.createPortal(
        <div style={{
          position: 'fixed',
          left: pos.x,
          top: pos.y - 6,
          transform: 'translate(-50%, -100%)',
          padding: '6px 10px',
          background: '#1a1a2e',
          color: '#e0e0e0',
          fontSize: 12,
          lineHeight: 1.4,
          borderRadius: 6,
          whiteSpace: 'pre-line',
          pointerEvents: 'none',
          zIndex: 99999,
          maxWidth: 320,
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}>
          {text}
        </div>,
        document.body,
      )}
    </>
  );
}

export default EntailmentExplanation;
