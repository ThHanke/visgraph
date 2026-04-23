import React, { useMemo, useState, useEffect, useLayoutEffect, useContext, useRef } from 'react';
import ReactDOM from 'react-dom';
import { PrefixContext } from '../../providers/PrefixContext';
import { prefixShorten } from '../../providers/prefixShorten';
import { fetchClasses, fetchLinkTypes, scoreLinkTypes, type FatMapEntity } from '../../utils/ontologyQueries';
import type { N3DataProvider } from '../../providers/N3DataProvider';
import { cn } from '../../lib/utils';

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
  refreshToken?: number;
}

const TIER_LABELS: Record<number, string> = { 0: 'Best match', 1: 'Compatible', 2: 'General', 3: 'Other' };

export default function EntityAutoComplete({
  mode,
  entities,
  dataProvider,
  sourceClassIri,
  targetClassIri,
  optionsLimit = 8,
  value,
  onChange,
  placeholder = 'Select…',
  emptyMessage = 'No options found.',
  className,
  autoOpen = false,
  disabled = false,
  refreshToken,
}: Props) {
  const [loadedItems, setLoadedItems] = useState<FatMapEntity[]>([]);
  const prefixes = useContext(PrefixContext);
  const prefixedIri = (iri: string) => prefixShorten(iri, prefixes);

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
  }, [dataProvider, mode, refreshToken]);

  const baseSource = useMemo<FatMapEntity[]>(() => {
    if (Array.isArray(entities) && entities.length > 0) return entities as FatMapEntity[];
    if (dataProvider && mode) return loadedItems;
    return Array.isArray(entities) ? (entities as FatMapEntity[]) : [];
  }, [entities, dataProvider, mode, loadedItems]);

  const source = useMemo<FatMapEntity[]>(() => {
    if (mode === 'properties' && dataProvider && (sourceClassIri || targetClassIri)) {
      return scoreLinkTypes(baseSource, sourceClassIri, targetClassIri, dataProvider);
    }
    return baseSource;
  }, [baseSource, mode, dataProvider, sourceClassIri, targetClassIri]);

  const [open, setOpen] = useState(Boolean(autoOpen));
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dropPos, setDropPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setOpen(Boolean(autoOpen)); }, [autoOpen]);

  const measurePos = () => {
    if (!inputRef.current) return;
    const r = inputRef.current.getBoundingClientRect();
    setDropPos({ top: r.bottom + 2, left: r.left, width: r.width });
  };

  useLayoutEffect(() => {
    if (!open) return;
    measurePos();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', measurePos, true);
    window.addEventListener('resize', measurePos);
    return () => {
      window.removeEventListener('scroll', measurePos, true);
      window.removeEventListener('resize', measurePos);
    };
  }, [open]);

  const displayValue = useMemo(() => {
    if (!value) return '';
    const found = source.find(e => String(e.iri || '') === String(value));
    return found ? prefixedIri(String(found.iri)) : value;
  }, [value, source]);

  const filtered = useMemo<FatMapEntity[]>(() => {
    const q = query.trim();
    if (!q) return optionsLimit > 0 ? source.slice(0, optionsLimit) : source;
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const matched = source.filter(e =>
      rx.test(String(e?.label || '')) ||
      rx.test(String((e as any)?.prefixed || '')) ||
      rx.test(prefixedIri(String(e?.iri || ''))) ||
      rx.test(String(e?.iri || ''))
    );
    return optionsLimit > 0 ? matched.slice(0, optionsLimit) : matched;
  }, [source, query, optionsLimit]);

  useEffect(() => { setActiveIndex(-1); }, [filtered]);

  useLayoutEffect(() => {
    if (!open || activeIndex < 0 || !listRef.current) return;
    const items = listRef.current.querySelectorAll('[role="option"]');
    (items[activeIndex] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const hasTiers = filtered.some(e => typeof e.domainRangeScore === 'number');

  const handleSelect = (ent: FatMapEntity) => {
    onChange?.(ent || null);
    setOpen(false);
    setQuery('');
  };

  const tierGroups = useMemo(() => {
    if (!hasTiers) return [{ label: null, items: filtered }];
    const groups: { label: string | null; items: FatMapEntity[] }[] = [];
    let cur: { label: string | null; items: FatMapEntity[] } | null = null;
    for (const ent of filtered) {
      const score = typeof ent.domainRangeScore === 'number' ? ent.domainRangeScore : -1;
      const label = score >= 0 ? (TIER_LABELS[score] ?? 'Other') : null;
      if (!cur || cur.label !== label) { cur = { label, items: [] }; groups.push(cur); }
      cur.items.push(ent);
    }
    return groups;
  }, [filtered, hasTiers]);

  const dropdown = open && dropPos && ReactDOM.createPortal(
    <ul
      ref={listRef}
      role="listbox"
      style={{ position: 'fixed', top: dropPos.top, left: dropPos.left, width: dropPos.width, zIndex: 9999 }}
      className="max-h-52 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md py-1"
    >
      {filtered.length === 0
        ? <li className="px-2 py-2 text-xs text-muted-foreground text-center">{emptyMessage}</li>
        : (() => {
          let flatIdx = 0;
          return tierGroups.map((group, gi) => (
            <React.Fragment key={gi}>
              {group.label && (
                <li className="px-2 py-0.5 text-[10px] font-medium text-muted-foreground bg-muted/40 select-none">
                  {group.label}
                </li>
              )}
              {group.items.map(ent => {
                const idx = flatIdx++;
                return (
                  <li
                    key={String(ent.iri || ent.label)}
                    role="option"
                    aria-selected={idx === activeIndex}
                    onMouseDown={e => { e.preventDefault(); handleSelect(ent); }}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={cn(
                      'px-2 py-1 text-xs cursor-pointer',
                      idx === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
                    )}
                  >
                    <div className="font-medium leading-tight">{(ent as any).prefixed || prefixedIri(String(ent.iri || ''))}</div>
                    {ent.label && <div className="text-[10px] text-muted-foreground leading-tight">{ent.label}</div>}
                  </li>
                );
              })}
            </React.Fragment>
          ));
        })()
      }
    </ul>,
    document.body
  );

  return (
    <>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        disabled={disabled}
        placeholder={placeholder}
        value={query !== '' ? query : displayValue}
        className={cn(
          'flex h-7 w-full rounded-md border border-input bg-background px-2 py-1 text-xs',
          'ring-offset-background placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        onFocus={() => {
          if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
          setOpen(true);
          setTimeout(() => inputRef.current?.select(), 0);
        }}
        onBlur={() => {
          closeTimer.current = setTimeout(() => {
            setOpen(false);
            if (query.trim() && /^[a-z][a-z0-9+.-]*:/i.test(query.trim())) {
              onChange?.({ iri: query.trim() } as FatMapEntity);
            }
            setQuery('');
          }, 150);
        }}
        onChange={e => { setQuery(e.target.value); setOpen(true); setActiveIndex(-1); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActiveIndex(i => Math.min(i + 1, filtered.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex(i => Math.max(i - 1, -1));
          } else if (e.key === 'Escape') {
            setOpen(false);
            setQuery('');
            setActiveIndex(-1);
          } else if (e.key === 'Enter') {
            if (activeIndex >= 0 && filtered[activeIndex]) {
              e.preventDefault();
              handleSelect(filtered[activeIndex]);
            } else if (query.trim() && filtered.length === 0 && /^[a-z][a-z0-9+.-]*:/i.test(query.trim())) {
              onChange?.({ iri: query.trim() } as FatMapEntity);
              setOpen(false);
              setQuery('');
            }
          }
        }}
      />
      {dropdown}
    </>
  );
}
