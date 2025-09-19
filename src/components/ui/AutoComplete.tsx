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

  const selectedOption = options.find(option => option.value === value);

  // Ranking: prefer matches by rdfs:label first, then by IRI substring, then description.
  // If no input (empty), return full options list.
  const filteredOptions = (() => {
    const q = String(inputValue || "").trim().toLowerCase();
    if (!q) return options;
    const labelMatches = options.filter((option) =>
      String(option.label || "").toLowerCase().includes(q),
    );
    const valueMatches = options.filter(
      (option) =>
        String(option.value || "").toLowerCase().includes(q) &&
        !labelMatches.some((m) => m.value === option.value),
    );
    const descMatches = options.filter(
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
                    if (rdfMgr) {
                      const td = computeTermDisplay(s, rdfMgr as any);
                      const pref = (td.prefixed || td.short || '').replace(/^(https?:\/\/)?(www\.)?/, '');
                      // Preserve any leading ':' so autocomplete shows default-namespace entries as ':local'
                      return pref;
                    }
                  } catch (_) { /* ignore */ }
                  // Fallback: if rdfMgr exposes namespaces and the value belongs to the default namespace (empty prefix),
                  // render with a leading ':' to match UI expectations in tests.
                  try {
                    const nsMap = rdfMgr && typeof (rdfMgr as any).getNamespaces === 'function'
                      ? (rdfMgr as any).getNamespaces()
                      : (rdfMgr && typeof rdfMgr === 'object' ? rdfMgr as Record<string,string> : undefined);
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
                      // Fallback: if rdfMgr exposes namespaces and the value belongs to the default namespace (empty prefix),
                      // render with a leading ':' so tests expecting ':local' succeed.
                      try {
                        const nsMap = rdfMgr && typeof (rdfMgr as any).getNamespaces === 'function'
                          ? (rdfMgr as any).getNamespaces()
                          : (rdfMgr && typeof rdfMgr === 'object' ? rdfMgr as Record<string,string> : undefined);
                        if (nsMap && nsMap[''] && String(option.value).startsWith(String(nsMap['']))) {
                          return `:${shortLocalName(String(option.value))}`.replace(/^(https?:\/\/)?(www\.)?/, '');
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
