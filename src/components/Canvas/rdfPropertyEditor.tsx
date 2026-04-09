import React, { useEffect, useRef, useState } from 'react';
import { DataFactory } from 'n3';
import * as Reactodia from '@reactodia/workspace';
import { Rdf } from '@reactodia/workspace';
import { InputList, InputText } from '@reactodia/workspace/forms';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';
import EntityAutoComplete from '../ui/EntityAutoComplete';
import { useOntologyStore } from '../../stores/ontologyStore';
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
  const prevIdRef = useRef(entityId);
  if (prevIdRef.current !== entityId) {
    prevIdRef.current = entityId;
    setNodeIri(entityId);
    setTypes(elementData ? [...elementData.types] : []);
    setRows(elementData ? rowsFromElementModel(elementData) : []);
  }

  const availableClasses = useOntologyStore((s) => s.availableClasses || []);

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
    <form onSubmit={handleApply} className="space-y-5 p-1">
      {/* IRI */}
      <div className="space-y-1">
        <Label>IRI</Label>
        <Input value={nodeIri} onChange={e => setNodeIri(e.target.value)} />
      </div>

      {/* RDF Types */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>RDF Types</Label>
          <Button type="button" variant="outline" size="sm" onClick={addType}>
            <Plus className="h-4 w-4 mr-1" />Add
          </Button>
        </div>
        {types.length === 0 && (
          <p className="text-xs text-muted-foreground">No types assigned</p>
        )}
        {types.map((t, i) => (
          <div key={i} className="flex items-center gap-2">
            <EntityAutoComplete
              mode="classes"
              optionsLimit={5}
              value={t}
              onChange={(ent: any) => updateType(i, ent ? String(ent.iri || '') : '')}
              placeholder="Search for class..."
              emptyMessage="No classes found"
              className="flex-1"
            />
            <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => removeType(i)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>

      {/* Annotation Properties */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Annotation Properties</Label>
          <Button type="button" variant="outline" size="sm" onClick={addRow}>
            <Plus className="h-4 w-4 mr-1" />Add
          </Button>
        </div>
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">No annotation properties</p>
        )}
        {rows.map((row, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-4">
              <Label className="text-xs">Property</Label>
              <EntityAutoComplete
                mode="properties"
                value={row.key}
                onChange={(ent) => updateRow(i, 'key', ent ? String(ent.iri || '') : '')}
                placeholder="Select property..."
                className={!row.key.trim() ? 'border-destructive' : ''}
              />
            </div>
            <div className="col-span-4">
              <Label className="text-xs">Value</Label>
              <Input value={row.value} onChange={e => updateRow(i, 'value', e.target.value)} placeholder="Value..." />
            </div>
            <div className="col-span-2">
              <Label className="text-xs">Type</Label>
              <Select value={row.type || DISPLAY_DATATYPE} onValueChange={v => updateRow(i, 'type', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {XSD_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {row.type === DISPLAY_DATATYPE && (
              <div className="col-span-1">
                <Label className="text-xs">Lang</Label>
                <Input value={row.lang} onChange={e => updateRow(i, 'lang', e.target.value)} placeholder="en" />
              </div>
            )}
            <div className="col-span-1">
              <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => removeRow(i)}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-end gap-2 pt-3 border-t">
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit">Apply</Button>
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
