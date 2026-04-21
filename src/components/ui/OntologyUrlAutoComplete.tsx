import React, { useState, useRef, useLayoutEffect, useEffect } from 'react';
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
  const [dropPos, setDropPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filtered = React.useMemo(() => {
    const q = (query || value).trim().toLowerCase();
    if (!q) return WELL_KNOWN_PREFIXES;
    return WELL_KNOWN_PREFIXES.filter(e =>
      e.prefix.toLowerCase().includes(q) ||
      e.name.toLowerCase().includes(q) ||
      e.url.toLowerCase().includes(q)
    );
  }, [query, value]);

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

  const handleSelect = (url: string) => {
    onChange(url);
    setQuery('');
    setOpen(false);
  };

  const dropdown = open && dropPos && filtered.length > 0 && ReactDOM.createPortal(
    <ul
      role="listbox"
      style={{ position: 'fixed', top: dropPos.top, left: dropPos.left, width: dropPos.width, zIndex: 9999 }}
      className="max-h-60 overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md py-1"
    >
      {filtered.map(e => (
        <li
          key={e.url}
          role="option"
          onMouseDown={ev => { ev.preventDefault(); handleSelect(e.url); }}
          className="px-3 py-1.5 text-sm cursor-pointer hover:bg-accent hover:text-accent-foreground"
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
          }, 150);
        }}
        onChange={e => { setQuery(e.target.value); onChange(e.target.value); setOpen(true); }}
        onKeyDown={e => {
          if (e.key === 'Escape') { setOpen(false); setQuery(''); }
          if (e.key === 'Enter') { setOpen(false); setQuery(''); }
        }}
      />
      {dropdown}
    </>
  );
}
