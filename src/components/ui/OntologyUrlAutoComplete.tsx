import React, { useState, useRef, useLayoutEffect, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom';
import { WELL_KNOWN_PREFIXES } from '../../utils/wellKnownOntologies';
import { cn } from '../../lib/utils';

interface Props {
  value: string;
  onChange: (url: string) => void;
  placeholder?: string;
  className?: string;
}

export default function OntologyUrlAutoComplete({ value, onChange, placeholder, className }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [dropPos, setDropPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return WELL_KNOWN_PREFIXES;
    return WELL_KNOWN_PREFIXES.filter(e =>
      e.prefix.toLowerCase().includes(q) ||
      e.name.toLowerCase().includes(q) ||
      e.url.toLowerCase().includes(q)
    );
  }, [query]);

  useEffect(() => { setActiveIndex(-1); }, [filtered]);

  const measurePos = () => {
    if (!inputRef.current) return;
    const r = inputRef.current.getBoundingClientRect();
    setDropPos({ top: r.bottom + 2, left: r.left, width: r.width });
  };

  useLayoutEffect(() => { if (open) measurePos(); }, [open]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', measurePos, true);
    window.addEventListener('resize', measurePos);
    return () => {
      window.removeEventListener('scroll', measurePos, true);
      window.removeEventListener('resize', measurePos);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || activeIndex < 0 || !listRef.current) return;
    const item = listRef.current.children[activeIndex] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const handleSelect = (url: string) => {
    onChange(url);
    setQuery('');
    setOpen(false);
    setActiveIndex(-1);
  };

  const dropdown = open && dropPos && filtered.length > 0 && ReactDOM.createPortal(
    <ul
      ref={listRef}
      role="listbox"
      style={{ position: 'fixed', top: dropPos.top, left: dropPos.left, width: dropPos.width, zIndex: 9999 }}
      className="max-h-60 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md py-1"
    >
      {filtered.map((e, i) => (
        <li
          key={e.url}
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={ev => { ev.preventDefault(); handleSelect(e.url); }}
          onMouseEnter={() => setActiveIndex(i)}
          className={cn(
            'px-3 py-1.5 text-sm cursor-pointer',
            i === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground'
          )}
        >
          <div className="font-medium leading-tight">{e.prefix} — {e.name}</div>
          <div className="text-xs text-muted-foreground leading-tight truncate">{e.url}</div>
        </li>
      ))}
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
        placeholder={placeholder ?? 'https://example.com/ontology.owl'}
        value={query !== '' ? query : value}
        className={cn(
          'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm',
          'ring-offset-background placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
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
            if (query.trim()) onChange(query.trim());
            setQuery('');
            setActiveIndex(-1);
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
          } else if (e.key === 'Enter') {
            if (activeIndex >= 0 && filtered[activeIndex]) {
              e.preventDefault();
              handleSelect(filtered[activeIndex].url);
            } else {
              setOpen(false);
              setQuery('');
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
            setQuery('');
            setActiveIndex(-1);
          }
        }}
      />
      {dropdown}
    </>
  );
}
