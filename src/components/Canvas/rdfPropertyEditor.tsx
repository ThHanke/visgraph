import React, { useEffect, useRef, useState } from 'react';
import { DataFactory } from 'n3';
import * as Reactodia from '@reactodia/workspace';
import { Rdf } from '@reactodia/workspace';
import { InputList, InputText } from '@reactodia/workspace/forms';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { dataProvider } from './ReactodiaCanvas';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';
import EntityAutoComplete from '../ui/EntityAutoComplete';
import { expandPrefixed, toPrefixed } from '../../utils/termUtils';
import { getNamespaceRegistry } from '../../utils/storeHelpers';
import { X, Plus } from 'lucide-react';

const { namedNode, literal } = DataFactory;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const DISPLAY_DATATYPE = 'xsd:string';

const XSD_TYPES = [
  DISPLAY_DATATYPE,
  'xsd:boolean',
  'xsd:integer',
  'xsd:decimal',
  'xsd:double',
  'xsd:float',
  'xsd:date',
  'xsd:dateTime',
  'xsd:time',
  'xsd:anyURI',
];

function expandIri(input: string): string {
  const raw = input.trim();
  if (!raw || raw.startsWith('_:') || raw.includes('://')) return raw;
  const registry = getNamespaceRegistry();
  return expandPrefixed(raw, registry as any);
}

function toPrefixedSafe(iri: string): string {
  try { return toPrefixed(iri) || iri; } catch { return iri; }
}

/** Build an Rdf.Literal or Rdf.NamedNode from a form row value/type/lang */
function termFromRow(value: string, type: string, lang: string): Rdf.NamedNode | Rdf.Literal {
  const s = value ?? '';
  if (lang && lang.trim()) return literal(s, lang.trim()) as unknown as Rdf.Literal;
  if (type && type.trim() && type !== DISPLAY_DATATYPE) {
    let dtIri = type.trim();
    if (dtIri.startsWith('xsd:')) dtIri = `http://www.w3.org/2001/XMLSchema#${dtIri.slice(4)}`;
    else if (!dtIri.includes('://')) dtIri = expandIri(dtIri);
    return literal(s, namedNode(dtIri)) as unknown as Rdf.Literal;
  }
  return literal(s) as unknown as Rdf.Literal;
}

/** Extract display string from an Rdf term */
function termValue(term: Rdf.NamedNode | Rdf.Literal): string {
  return term.value ?? '';
}
function termLang(term: Rdf.NamedNode | Rdf.Literal): string {
  return (term as any).language ?? '';
}
function termDatatype(term: Rdf.NamedNode | Rdf.Literal): string {
  if ((term as any).datatype) {
    const dtIri = (term as any).datatype.value as string;
    return toPrefixedSafe(dtIri);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Form row type
// ---------------------------------------------------------------------------

interface PropRow {
  /** property IRI */
  key: string;
  value: string;
  type: string;
  lang: string;
}

function rowsFromElementModel(
  elementData: Reactodia.ElementModel,
): PropRow[] {
  const rows: PropRow[] = [];
  for (const [propIri, terms] of Object.entries(elementData.properties)) {
    for (const term of terms as Array<Rdf.NamedNode | Rdf.Literal>) {
      rows.push({
        key: propIri,
        value: termValue(term),
        type: termDatatype(term) || DISPLAY_DATATYPE,
        lang: termLang(term),
      });
    }
  }
  return rows;
}

function buildProperties(
  rows: PropRow[],
): { [id: string]: Array<Rdf.NamedNode | Rdf.Literal> } {
  const result: { [id: string]: Array<Rdf.NamedNode | Rdf.Literal> } = {};
  for (const row of rows) {
    const iri = expandIri(row.key.trim());
    if (!iri) continue;
    if (!result[iri]) result[iri] = [];
    result[iri].push(termFromRow(row.value, row.type, row.lang));
  }
  return result;
}

// ---------------------------------------------------------------------------
// Entity editor — custom form calling options.onSubmit (AuthoringState staging)
// ---------------------------------------------------------------------------

interface EntityEditorProps {
  options: Reactodia.PropertyEditorOptionsEntity;
}

const EntityEditor = ({ options }: EntityEditorProps) => {
  const { target, onClose } = options;
  const elementData: Reactodia.ElementModel | undefined = (target as any)?.data;
  const { editor } = Reactodia.useWorkspace();

  const entityId = elementData?.id ?? '';
  const [nodeIri, setNodeIri] = useState(entityId);
  const [types, setTypes] = useState<string[]>(elementData ? [...elementData.types] : []);
  const [rows, setRows] = useState<PropRow[]>(() => elementData ? rowsFromElementModel(elementData) : []);

  // Re-initialize when a different entity is opened
  useEffect(() => {
    setNodeIri(entityId);
    setTypes(elementData ? [...elementData.types] : []);
    setRows(elementData ? rowsFromElementModel(elementData) : []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId]);

  if (!elementData) return null;

  // --- Type handlers ---
  const addType = () => setTypes(prev => [...prev, '']);
  const removeType = (i: number) => setTypes(prev => prev.filter((_, idx) => idx !== i));
  const updateType = (i: number, val: string) =>
    setTypes(prev => prev.map((t, idx) => (idx === i ? val : t)));

  // --- Row handlers ---
  const addRow = () => setRows(prev => [...prev, { key: '', value: '', type: DISPLAY_DATATYPE, lang: '' }]);
  const removeRow = (i: number) => setRows(prev => prev.filter((_, idx) => idx !== i));
  const updateRow = (i: number, field: keyof PropRow, val: string) =>
    setRows(prev => prev.map((r, idx) => {
      if (idx !== i) return r;
      const updated = { ...r, [field]: val };
      if (field === 'type' && val !== DISPLAY_DATATYPE) updated.lang = '';
      return updated;
    }));

  // --- Submit → stage into AuthoringState via editor.changeEntity (v0.34 API) ---
  const handleApply = (e: React.FormEvent) => {
    e.preventDefault();
    if (!elementData) return;
    const iri = expandIri(nodeIri.trim()) || nodeIri.trim();
    const filteredTypes = types.filter(t => t.trim()) as Reactodia.ElementTypeIri[];
    const properties = buildProperties(rows.filter(r => r.key.trim()));
    const newData: Reactodia.ElementModel = {
      id: iri as Reactodia.ElementIri,
      types: filteredTypes,
      properties,
    };
    editor.changeEntity(elementData, newData);
    onClose();
  };

  return (
    // flex-1 + min-h-0: fills remaining height inside .reactodia-dialog (flex column)
    // overflow-hidden: clips content, inner div handles scroll
    <form onSubmit={handleApply} className="flex flex-col flex-1 min-h-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-3">

        {/* IRI */}
        <div className="space-y-1">
          <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">IRI</Label>
          <Input value={nodeIri} onChange={e => setNodeIri(e.target.value)} className="h-7 text-xs font-mono" />
        </div>

        {/* RDF Types */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">RDF Types</Label>
            <button type="button" onClick={addType} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent transition-colors">
              <Plus className="h-3 w-3" />Add
            </button>
          </div>
          <div className="space-y-1">
            {types.length === 0 && <p className="text-xs text-muted-foreground">—</p>}
            {types.map((t, i) => (
              <div key={i} className="flex items-center gap-1">
                <EntityAutoComplete
                  mode="classes"
                  optionsLimit={5}
                  value={t}
                  onChange={(ent: any) => updateType(i, ent ? String(ent.iri || '') : '')}
                  placeholder="Search class…"
                  emptyMessage="No classes found"
                  className="flex-1"
                  dataProvider={dataProvider}
                />
                <button type="button" onClick={() => removeType(i)} className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Annotation Properties */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <Label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Annotation Properties</Label>
            <button type="button" onClick={addRow} className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent transition-colors">
              <Plus className="h-3 w-3" />Add
            </button>
          </div>
          {rows.length > 0 && (
            <div className="grid grid-cols-[1fr_1fr_4.5rem_2.5rem_1.75rem] gap-1 px-0.5 pb-0.5">
              <span className="text-[10px] text-muted-foreground">Property</span>
              <span className="text-[10px] text-muted-foreground">Value</span>
              <span className="text-[10px] text-muted-foreground">Type</span>
              <span className="text-[10px] text-muted-foreground">Lang</span>
              <span />
            </div>
          )}
          <div className="space-y-1">
            {rows.length === 0 && <p className="text-xs text-muted-foreground">—</p>}
            {rows.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_4.5rem_2.5rem_1.75rem] gap-1 items-center">
                <EntityAutoComplete
                  mode="properties"
                  value={row.key}
                  onChange={(ent) => updateRow(i, 'key', ent ? String(ent.iri || '') : '')}
                  placeholder="Property…"
                  className={!row.key.trim() ? 'ring-1 ring-destructive' : ''}
                  dataProvider={dataProvider}
                />
                <Input value={row.value} onChange={e => updateRow(i, 'value', e.target.value)} placeholder="Value…" className="h-7 text-xs" />
                <Select value={row.type || DISPLAY_DATATYPE} onValueChange={v => updateRow(i, 'type', v)}>
                  <SelectTrigger className="h-7 text-xs px-1.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {XSD_TYPES.map(t => <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input
                  value={row.lang}
                  onChange={e => updateRow(i, 'lang', e.target.value)}
                  placeholder="en"
                  disabled={row.type !== DISPLAY_DATATYPE}
                  className="h-7 text-xs"
                />
                <button type="button" onClick={() => removeRow(i)} className="h-7 w-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="shrink-0 flex justify-end gap-1.5 px-3 py-2 border-t">
        <Button type="button" variant="ghost" size="sm" className="h-7 px-3 text-xs" onClick={onClose}>Cancel</Button>
        <Button type="submit" size="sm" className="h-7 px-3 text-xs">Apply</Button>
      </div>
    </form>
  );
};

// ---------------------------------------------------------------------------
// Relation editor — use Reactodia's default (handles type changing + AuthoringState)
// ---------------------------------------------------------------------------

const defaultResolveInput: Reactodia.PropertyEditorResolveInput = (_property, inputProps) => (
  <InputList {...inputProps} valueInput={InputText} />
);

// ---------------------------------------------------------------------------
// Main export — dispatches by type
// ---------------------------------------------------------------------------

interface RdfPropertyEditorProps {
  options: Reactodia.PropertyEditorOptions;
}

export function RdfPropertyEditor({ options }: RdfPropertyEditorProps) {
  if (!options) return null;
  console.debug('[RdfPropertyEditor] options', options);
  if (options.type === 'entity') {
    return <EntityEditor options={options} />;
  }
  // For relations, use Reactodia's default editor (type-changing + AuthoringState)
  return (
    <Reactodia.DefaultPropertyEditor
      options={options}
      resolveInput={defaultResolveInput}
    />
  );
}
