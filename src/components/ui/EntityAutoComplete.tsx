import React, { useMemo, useState, useEffect, useRef } from "react";
import { useOntologyStore } from "../../stores/ontologyStore";
import { toPrefixed } from "../../utils/termUtils";
import { cn } from "../../lib/utils";

export interface FatMapEntity {
  iri: string;
  label?: string;
  prefixed?: string;
  namespace?: string;
  rdfType?: string;
  [k: string]: any;
}

interface Props {
  mode?: "classes" | "properties";
  entities?: FatMapEntity[]; // optional override; if provided it is used
  optionsLimit?: number;
  value?: string; // selected iri
  onChange?: (entity: FatMapEntity | null) => void;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
  autoOpen?: boolean;
  disabled?: boolean;
}

/* Utility: escape regex special chars */
function escapeRegExp(s: string) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* Minimal, deterministic AutoComplete that reads fat-map entries from the store
   when mode is provided, or uses the supplied entities array. Matching is a
   case-insensitive substring test; extended to match label, prefixed, computed
   prefixed and full IRI. */
export default function EntityAutoComplete({
  mode,
  entities,
  optionsLimit = 8,
  value,
  onChange,
  placeholder = "Select option...",
  emptyMessage = "No options found.",
  className,
  autoOpen = false,
  disabled = false,
}: Props) {
  const storeClasses = useOntologyStore((s) => s.availableClasses);
  const storeProperties = useOntologyStore((s) => s.availableProperties);

  // Decide source array: entities prop takes precedence; otherwise read from store via mode.
  const source = useMemo(() => {
    if (Array.isArray(entities) && entities.length > 0) return entities as FatMapEntity[];
    if (mode === "classes") return Array.isArray(storeClasses) ? (storeClasses as unknown as FatMapEntity[]) : [];
    if (mode === "properties") return Array.isArray(storeProperties) ? (storeProperties as unknown as FatMapEntity[]) : [];
    return Array.isArray(entities) ? (entities as FatMapEntity[]) : [];
  }, [entities, mode, storeClasses, storeProperties]);

  const [open, setOpen] = useState<boolean>(Boolean(autoOpen));
  const [query, setQuery] = useState<string>("");
  const [highlight, setHighlight] = useState<number>(-1);
  const [initialDisplay, setInitialDisplay] = useState<string>("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Resolve selected entity object from value (iri)
  const selectedEntity = useMemo(() => {
    if (!value) return null;
    return source.find((e) => String(e.iri || "") === String(value)) || null;
  }, [value, source]);

  useEffect(() => {
    setOpen(Boolean(autoOpen));
  }, [autoOpen]);

  // Ensure the in-field display reflects the selected entity's prefixed value on init
  // and whenever the resolved selectedEntity or value changes — but only when the user
  // is not actively typing (query is empty).
  useEffect(() => {
    try {
      if (String(query || "").trim() !== "") return;

      if (value) {
        if (selectedEntity && selectedEntity.prefixed && String(selectedEntity.prefixed).trim()) {
          setInitialDisplay(String(selectedEntity.prefixed));
          return;
        }

        try {
          const computed = toPrefixed(String(value));
          // Only accept computed prefixed if it is non-empty and not the same as the input IRI.
          if (computed && String(computed).trim() !== "" && String(computed) !== String(value)) {
            setInitialDisplay(String(computed));
            return;
          }
        } catch (_) {
          // toPrefixed may throw if registry missing; ignore and fall through to clearing display.
        }
      }

      setInitialDisplay("");
    } catch (_) {
      setInitialDisplay("");
    }
  }, [value, selectedEntity, query]);

  // Build filtered list based on query; match against label, prefixed, computed prefixed, and iri
  // IMPORTANT: do not show any suggestions when the query is empty — suggestions are shown only
  // when the user has typed something into the field.
  const filtered = useMemo(() => {
    if (!query || String(query).trim() === "") {
      return [];
    }
    const q = String(query).trim();
    const rx = new RegExp(escapeRegExp(q), "i");
    const matched = source.filter((e) => {
      const lab = String(e?.label || "");
      const pref = String(e?.prefixed || "");
      const iri = String(e?.iri || "");

      // Match label
      if (lab && rx.test(lab)) return true;
      // Match stored prefixed form
      if (pref && rx.test(pref)) return true;
      // Match full IRI
      if (iri && rx.test(iri)) return true;
      // If no stored prefixed, try computing one and match against it (toPrefixed may throw)
      if (!pref && iri) {
        try {
          const computed = String(toPrefixed(iri) || "");
          if (computed && rx.test(computed)) return true;
        } catch (_) {
          // ignore toPrefixed failures
        }
      }
      return false;
    });
    return optionsLimit && optionsLimit > 0 ? matched.slice(0, optionsLimit) : matched;
  }, [source, query, optionsLimit]);

  // Handle keyboard navigation
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && highlight >= 0 && highlight < filtered.length) {
        const ent = filtered[highlight];
        if (typeof onChange === "function") onChange(ent || null);
        setOpen(false);
        setQuery("");
        try {
          setInitialDisplay(ent && ent.prefixed ? String(ent.prefixed) : "");
        } catch (_) {
          setInitialDisplay("");
        }
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      setHighlight(-1);
      setQuery("");
      if (typeof onChange === "function") onChange(null);
      setInitialDisplay("");
    }
  };

  // Click selection handler
  const handleSelect = (ent: FatMapEntity) => {
    if (typeof onChange === "function") onChange(ent || null);
    setOpen(false);
    setQuery("");
    try {
      setInitialDisplay(ent && ent.prefixed ? String(ent.prefixed) : "");
    } catch (_) {
      setInitialDisplay("");
    }
    inputRef.current?.focus();
  };

  // Input displays the current user query while typing. When query is empty,
  // show the selected entity's prefixed form inside the input (so the value
  // appears in-field rather than in a separate overlay). If no selected
  // entity with a prefixed value exists, leave the input empty so the
  // placeholder is visible.
  const inputValue = query !== ""
    ? query
    : initialDisplay;

  return (
    <div className={cn(className || "relative w-full")} style={{ minWidth: 0 }}>
      <div role="combobox" aria-expanded={open} aria-haspopup="listbox" className="flex items-center gap-2">
          <input
          ref={inputRef}
          type="text"
          className={cn(
            "flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
          )}
          placeholder={placeholder}
          value={inputValue}
          onChange={(ev) => {
            const v = ev.target.value;
            setQuery(v);
            // open only when user has typed something — entering text will open suggestions
            if (String(v).trim() !== "") {
              setOpen(true);
            } else {
              // user cleared the field explicitly — keep input empty so placeholder shows
              setInitialDisplay("");
            }
            setHighlight(0);
          }}
          onFocus={() => { if (String(query).trim() !== "") setOpen(true); }}
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
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-sm text-muted-foreground">{emptyMessage}</li>
          ) : (
            filtered.map((ent, idx) => {
              const isHighlighted = idx === highlight;
              return (
                <li
                  key={String(ent.iri || idx)}
                  role="option"
                  aria-selected={isHighlighted}
                  onMouseEnter={() => setHighlight(idx)}
                  onMouseDown={(ev) => {
                    // prevent blur before click
                    ev.preventDefault();
                    handleSelect(ent);
                  }}
                  className={cn(
                    "cursor-pointer px-3 py-2",
                    isHighlighted ? "bg-accent text-accent-foreground" : "bg-transparent text-foreground"
                  )}
                >
                  <div className="text-sm font-medium">{ent.prefixed || String(ent.iri)}</div>
                  <div className="text-xs text-muted-foreground">{ent.label || ""}</div>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
