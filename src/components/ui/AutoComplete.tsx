import { useState, useRef, useEffect } from 'react';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './command';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Button } from './button';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '../../lib/utils';
import { computeTermDisplay, shortLocalName } from '../../utils/termUtils';
import { useOntologyStore } from '../../stores/ontologyStore';

interface AutoCompleteOption {
  value: string;
  label: string;
  description?: string;
}

interface AutoCompleteProps {
  options: AutoCompleteOption[];
  value?: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
  // When true the dropdown will be opened automatically (useful when embedded in a dialog)
  autoOpen?: boolean;
  disabled?: boolean;
}

export const AutoComplete = ({
  options,
  value,
  onValueChange,
  placeholder = "Select option...",
  emptyMessage = "No options found.",
  className,
  autoOpen = false,
  disabled = false
}: AutoCompleteProps) => {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');

  // If consumer requests the dropdown to auto-open (e.g. when dialog is open),
  // respect that and keep the popover open while autoOpen is true.
  useEffect(() => {
    try {
      setOpen(Boolean(autoOpen));
    } catch (_) {
      /* ignore */
    }
  }, [autoOpen]);

  // Determine the selected option from the provided options first.
  const selectedOption = options.find(option => option.value === value);

  // Derive the final options array: prefer the caller-supplied `options` prop.
  // If empty, fall back to the ontology store (fat-map) to provide sensible defaults
  // for node/link editors that rely on store-driven suggestions.
  const finalOptions = (Array.isArray(options) && options.length > 0) ? options : (() => {
    try {
      const st = useOntologyStore.getState();
      // Prefer entityIndex.suggestions when available (stable suggestions produced by mapping).
      const entityIndex = (st as any).entityIndex;
      if (entityIndex && Array.isArray(entityIndex.suggestions) && entityIndex.suggestions.length > 0) {
        return entityIndex.suggestions.map((s: any) => ({
          value: String(s.iri || s.id || s.key || ""),
          label: String(s.label || s.display || shortLocalName(String(s.iri || s.id || s.key || ""))),
          description: s.display || undefined,
        }));
      }
      // Fallback to availableProperties from the fat-map
      const av = Array.isArray((st as any).availableProperties) ? (st as any).availableProperties : [];
      if (av && av.length > 0) {
        return av.map((p: any) => ({
          value: String(p.iri || p.key || p),
          label: String(p.label || p.name || p.iri || p),
          description: p.namespace ? `From ${p.namespace}` : undefined,
        }));
      }
    } catch (_) {
      /* best-effort only */
    }
    return options;
  })();

  // Ranking: prefer matches by rdfs:label first, then by IRI substring, then description.
  // If no input (empty), return the full finalOptions list.
  const filteredOptions = (() => {
    const q = String(inputValue || "").trim().toLowerCase();
    if (!q) return finalOptions;
    const labelMatches = (finalOptions || []).filter((option) =>
      String(option.label || "").toLowerCase().includes(q),
    );
    const valueMatches = (finalOptions || []).filter(
      (option) =>
        String(option.value || "").toLowerCase().includes(q) &&
        !labelMatches.some((m) => m.value === option.value),
    );
    const descMatches = (finalOptions || []).filter(
      (option) =>
        !labelMatches.some((m) => m.value === option.value) &&
        !valueMatches.some((m) => m.value === option.value) &&
        String(option.description || "").toLowerCase().includes(q),
    );
    return [...labelMatches, ...valueMatches, ...descMatches];
  })();

  return (
    <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className={cn("justify-between", className)}
              disabled={disabled}
            >
              {(() => {
                const mgrState = useOntologyStore.getState();
                const rdfMgr = typeof mgrState.getRdfManager === 'function' ? mgrState.getRdfManager() : mgrState.rdfManager;
                const format = (iri?: string) => {
                  if (!iri) return "";
                  const s = String(iri);
                  if (s.startsWith('_:')) return s;
                  try {
                    const nsMap = rdfMgr && typeof (rdfMgr as any).getNamespaces === 'function'
                      ? (rdfMgr as any).getNamespaces()
                      : (rdfMgr && typeof rdfMgr === 'object' ? (rdfMgr as unknown as Record<string,string>) : undefined);
                    if (nsMap && nsMap[''] && s.startsWith(String(nsMap['']))) {
                      return `:${shortLocalName(s)}`.replace(/^(https?:\/\/)?(www\.)?/, '');
                    }
                  } catch (_) { /* ignore */ }
                  return shortLocalName(s).replace(/^(https?:\/\/)?(www\.)?/, '');
                };
                if (selectedOption) return format(selectedOption.value);
                if (value) return format(value);
                return placeholder;
              })()}
              <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
      <PopoverContent className="w-full p-0" align="start">
        <Command>
          <CommandInput 
            placeholder={`Search ${placeholder.toLowerCase()}...`}
            value={inputValue}
            onValueChange={setInputValue}
          />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {filteredOptions.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  onSelect={() => {
                    onValueChange(option.value);
                    setOpen(false);
                    setInputValue('');
                  }}
                  className="flex items-center justify-between"
                >
                  <div className="flex flex-col">
                    <span>{(() => {
                      const mgrState = useOntologyStore.getState();
                      const rdfMgr = typeof mgrState.getRdfManager === 'function' ? mgrState.getRdfManager() : mgrState.rdfManager;
                      try {
                        if (rdfMgr) {
                          const td = computeTermDisplay(String(option.value), rdfMgr as any);
                          const pref = (td.prefixed || td.short || '').replace(/^(https?:\/\/)?(www\.)?/, '');
                          // Preserve leading ':' so options for the default namespace appear as ':local'
                          return pref;
                        }
                      } catch (_) { /* ignore */ }
                      return shortLocalName(String(option.value)).replace(/^(https?:\/\/)?(www\.)?/, '');
                    })()}</span>
                    {(option.label || option.description) && (
                      <span className="text-xs text-muted-foreground">
                        {option.label ? option.label : option.description}
                      </span>
                    )}
                  </div>
                  <Check
                    className={cn(
                      "ml-auto h-4 w-4",
                      value === option.value ? "opacity-100" : "opacity-0"
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
};
