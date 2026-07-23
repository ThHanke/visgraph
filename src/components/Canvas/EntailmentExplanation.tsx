import React from 'react';
import ReactDOM from 'react-dom';
import { HelpCircle } from 'lucide-react';
import { rdfManager } from '../../utils/rdfManager';
import { PrefixContext } from '../../providers/PrefixContext';
import { prefixShorten } from '../../providers/prefixShorten';
import { dataProvider } from './ReactodiaCanvas';

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

function labelOrLocal(iri: string): string {
  return dataProvider.labelForIri(iri) ?? iri.split(/[/#]/).pop() ?? iri;
}

function formatAxiomReadable(
  axiom: { subject: string; predicate: string; object: string },
): string {
  const s = labelOrLocal(axiom.subject);
  const o = labelOrLocal(axiom.object);
  if (axiom.predicate === SUBCLASS_OF) return `${s} is a subclass of ${o}`;
  if (axiom.predicate === SUBPROPERTY_OF) return `${s} is a subproperty of ${o}`;
  if (axiom.predicate === RDF_TYPE) return `${s} is a ${o}`;
  return `${s} ${labelOrLocal(axiom.predicate)} ${o}`;
}

interface FormattedLine {
  formal: string;
  readable: string;
}

function formatResult(
  result: ExplainResult,
  prefixes: Record<string, string>,
): { header: string; lines: FormattedLine[] } {
  if (result.ontologyInconsistent)
    return { header: 'Cannot explain: ontology is inconsistent.', lines: [] };
  if (result.isEntailed === false)
    return { header: 'Asserted (not inferred).', lines: [] };
  if (result.vacuous)
    return { header: 'Holds vacuously (unsatisfiable class).', lines: [] };
  const justs = (result.justifications ?? []).filter(j => Array.isArray(j) && j.length > 0);
  if (justs.length === 0)
    return { header: 'Inferred (no justification available).', lines: [] };
  const lines: FormattedLine[] = [];
  for (const j of justs)
    for (const ax of j)
      lines.push({
        formal: formatAxiom(ax, prefixes),
        readable: formatAxiomReadable(ax),
      });
  return { header: 'Inferred because:', lines };
}

export interface EntailmentExplanationProps {
  triple: ExplainTriple;
  explain?: typeof rdfManager.explainEntailment;
  label?: string;
}

export function EntailmentExplanation(
  { triple, explain, label }: EntailmentExplanationProps,
): React.ReactElement {
  const [tooltip, setTooltip] = React.useState<{ header: string; lines: FormattedLine[] } | null>(null);
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
      setTooltip(formatResult(result, prefixes));
    }).catch((err: unknown) => {
      asked.current = false;
      setTooltip({ header: `Error: ${err instanceof Error ? err.message : String(err)}`, lines: [] });
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
      {hovered && tooltip && ReactDOM.createPortal(
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
          maxWidth: 400,
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
        }}>
          <div>{tooltip.header}</div>
          {tooltip.lines.map((line, i) => (
            <div key={i} style={{ marginTop: 2 }}>
              <div style={{ color: '#a0a0b8' }}>{`  • ${line.formal}`}</div>
              <div style={{ fontStyle: 'italic', color: '#c8c8e0', marginLeft: 16 }}>{line.readable}</div>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

export default EntailmentExplanation;
