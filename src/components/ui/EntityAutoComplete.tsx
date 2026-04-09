import React, { useMemo, useState, useEffect, useRef, useContext } from 'react';
import { cn } from '../../lib/utils';
import { PrefixContext } from '../../providers/PrefixContext';
import { prefixShorten } from '../../providers/prefixShorten';
import { fetchClasses, fetchLinkTypes, scoreLinkTypes, type FatMapEntity } from '../../utils/ontologyQueries';
import type { N3DataProvider } from '../../providers/N3DataProvider';

// Re-export so existing importers of FatMapEntity from this file keep working
export type { FatMapEntity };

interface Props {
  mode?: 'classes' | 'properties';
  entities?: FatMapEntity[];
  dataProvider?: N3DataProvider;
  sourceClassIri?: string;
  targetClassIri?: string;
  optionsLimit?: number;
  value?: string;
  onChange?: (entity: FatMapEntity | null) => void;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
  autoOpen?: boolean;
  disabled?: boolean;
}

const TIER_LABELS: Record<number, string> = { 0: 'Best match', 1: 'Compatible', 2: 'General', 3: 'Other' };

function escapeRegExp(s: string) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default function EntityAutoComplete({
  mode,
  entities,
  dataProvider,
  sourceClassIri,
  targetClassIri,
  optionsLimit = 8,
  value,
  onChange,
  placeholder = 'Select option...',
  emptyMessage = 'No options found.',
  className,
  autoOpen = false,
  disabled = false,
}: Props) {
  const [loadedItems, setLoadedItems] = useState<FatMapEntity[]>([]);
  const prefixes = useContext(PrefixContext);

  const prefixedIri = (iri: string): string => prefixShorten(iri, prefixes);

  // Async load from DataProvider when mode is set
  useEffect(() => {
    if (!dataProvider || !mode) return;
    let cancelled = false;
    const load = async () => {
      const result = mode === 'classes'
        ? await fetchClasses(dataProvider)
        : await fetchLinkTypes(dataProvider);
      if (!cancelled) setLoadedItems(result);
    };
    load();
    return () => { cancelled = true; };
  }, [dataProvider, mode]);

  // Decide source: explicit entities prop overrides everything
  const baseSource = useMemo<FatMapEntity[]>(() => {
    if (Array.isArray(entities) && entities.length > 0) return entities as FatMapEntity[];
    if (dataProvider && mode) return loadedItems;
    return Array.isArray(entities) ? (entities as FatMapEntity[]) : [];
  }, [entities, dataProvider, mode, loadedItems]);

  // Apply domain/range scoring when context is available
  const source = useMemo<FatMapEntity[]>(() => {
    if (mode === 'properties' && dataProvider && (sourceClassIri || targetClassIri)) {
      return scoreLinkTypes(baseSource, sourceClassIri, targetClassIri, dataProvider);
    }
    return baseSource;
  }, [baseSource, mode, dataProvider, sourceClassIri, targetClassIri]);

  const [open, setOpen] = useState<boolean>(Boolean(autoOpen));
  const [query, setQuery] = useState<string>('');
  const [highlight, setHighlight] = useState<number>(-1);
  const [initialDisplay, setInitialDisplay] = useState<string>('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const isFocusedRef = useRef<boolean>(false);

  useEffect(() => { setOpen(Boolean(autoOpen)); }, [autoOpen]);

  useEffect(() => {
    if (isFocusedRef.current) return;
    if (!value) { setInitialDisplay(''); return; }
    const found = source.find(e => String(e.iri || '') === String(value));
    setInitialDisplay(found ? prefixedIri(String(found.iri)) : value);
  }, [value, source]);

  const filtered = useMemo<FatMapEntity[]>(() => {
    if (!query || String(query).trim() === '') {
      return optionsLimit > 0 ? source.slice(0, optionsLimit) : source;
    }
    const rx = new RegExp(escapeRegExp(String(query).trim()), 'i');
    const matched = source.filter(e => {
      if (rx.test(String(e?.label || ''))) return true;
      if (rx.test(prefixedIri(String(e?.iri || '')))) return true;
      if (rx.test(String(e?.iri || ''))) return true;
      return false;
    });
    return optionsLimit > 0 ? matched.slice(0, optionsLimit) : matched;
  }, [source, query, optionsLimit]);

  const hasTiers = filtered.some(e => typeof e.domainRangeScore === 'number');

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight(h => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight(h => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && highlight >= 0 && highlight < filtered.length) {
        const ent = filtered[highlight];
        onChange?.(ent || null);
        setOpen(false);
        setQuery('');
        try { setInitialDisplay(prefixedIri(String(ent?.iri || ''))); } catch { setInitialDisplay(''); }
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
      setHighlight(-1);
      setQuery('');
      onChange?.(null);
      setInitialDisplay('');
    }
  };

  const handleSelect = (ent: FatMapEntity) => {
    onChange?.(ent || null);
    setOpen(false);
    setQuery('');
    try { setInitialDisplay(prefixedIri(String(ent?.iri || ''))); } catch { setInitialDisplay(''); }
    inputRef.current?.focus();
  };

  const inputValue = query !== '' ? query : initialDisplay;

  // Build list items with tier separators
  const listItems: React.ReactNode[] = [];
  let lastScore: number | undefined = undefined;
  let flatIdx = 0;
  for (const ent of filtered) {
    const score = typeof ent.domainRangeScore === 'number' ? ent.domainRangeScore : undefined;
    if (hasTiers && score !== undefined && score !== lastScore) {
      listItems.push(
        <li key={`sep-${score}`} className="px-3 py-1 text-xs font-semibold text-muted-foreground border-t first:border-t-0 bg-muted/40 select-none">
          {TIER_LABELS[score]}
        </li>
      );
      lastScore = score;
    }
    const idx = flatIdx++;
    const isHighlighted = idx === highlight;
    listItems.push(
      <li
        key={String(ent.iri || idx)}
        role="option"
        aria-selected={isHighlighted}
        onMouseEnter={() => setHighlight(idx)}
        onMouseDown={ev => { ev.preventDefault(); handleSelect(ent); }}
        className={cn(
          'cursor-pointer px-3 py-2',
          isHighlighted ? 'bg-accent text-accent-foreground' : 'bg-transparent text-foreground',
        )}
      >
        <div className="text-sm font-medium">{prefixedIri(String(ent.iri))}</div>
        <div className="text-xs text-muted-foreground">{ent.label || ''}</div>
      </li>
    );
  }

  return (
    <div className={cn(className || 'relative w-full')} style={{ minWidth: 0 }}>
      <div role="combobox" aria-expanded={open} aria-haspopup="listbox" className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          className={cn(
            'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
          )}
          placeholder={placeholder}
          value={inputValue}
          onChange={ev => {
            const v = ev.target.value;
            setQuery(v);
            if (String(v).trim() !== '') { setOpen(true); } else { setInitialDisplay(''); }
            setHighlight(0);
          }}
          onFocus={() => {
            if (!isFocusedRef.current) {
              isFocusedRef.current = true;
              setTimeout(() => inputRef.current?.select(), 0);
            }
            setOpen(true);
          }}
          onBlur={() => { isFocusedRef.current = false; }}
          onKeyDown={onKeyDown}
          disabled={disabled}
          aria-controls="entity-autocomplete-list"
          aria-autocomplete="list"
        />
      </div>

      {open && (
        <ul
          id="entity-autocomplete-list"
          role="listbox"
          ref={listRef}
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded border bg-popover shadow"
        >
          {filtered.length === 0
            ? <li className="px-3 py-2 text-sm text-muted-foreground">{emptyMessage}</li>
            : listItems
          }
        </ul>
      )}
    </div>
  );
}
