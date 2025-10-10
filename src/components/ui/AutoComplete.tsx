import { useState, useRef, useEffect, useMemo } from 'react';
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
    {
      setOpen(Boolean(autoOpen));
    }
  }, [autoOpen]);

  // Subscribe to store slices individually so Zustand can optimize snapshots and avoid
  // creating a new object on every render (this prevents infinite update warnings).
  const availableProperties = useOntologyStore((s) => s.availableProperties);
  const availableClasses = useOntologyStore((s) => s.availableClasses);
  const namespaceRegistry = useOntologyStore((s) => s.namespaceRegistry);
  const entityIndex = useOntologyStore((s) => (s as any).entityIndex);

  // Determine the selected option from the provided options first.
  const selectedOption = options.find(option => option.value === value);

  // Derive the final options array: prefer the caller-supplied `options` prop.
  // If empty, fall back to the ontology store but do NOT snapshot labels/descriptions —
  // rely on computeTermDisplay for formatting.
  const finalOptions: AutoCompleteOption[] = (Array.isArray(options) && options.length > 0) ? options : (() => {
    // Fallback to availableProperties from the fat-map (produce minimal entries)
    const av = Array.isArray(availableProperties) ? availableProperties : [];
    if (av && av.length > 0) {
      return av.map((p: any) => ({
        value: String(p.iri || p.key || p),
        label: "",
        description: "",
      }));
    }
    return [];
  })();

  // Precompute display info (computeTermDisplay) once per option and memoize.
  // Recompute when finalOptions or the store slices (fat-map/registry) change.
  const cachedOptions = useMemo(() => {
    return (finalOptions || []).map((opt) => {
      const val = String(opt.value || "");
      const td = computeTermDisplay(val);
      return { opt, td };
    });
    // Recompute when options or the store slices used by computeTermDisplay change.
  }, [finalOptions, availableProperties, availableClasses, namespaceRegistry]);

  // Ranking: prefer matches by label (from computeTermDisplay) first, then by IRI substring, then description.
  // If no input (empty), return the full cachedOptions list.
  const filteredOptions = (() => {
    const q = String(inputValue || "").trim().toLowerCase();
    if (!q) return cachedOptions;
    const labelMatches = (cachedOptions || []).filter(({ opt, td }) =>
      String(td && (td.label || td.prefixed || td.short) || "").toLowerCase().includes(q),
    );
    const valueMatches = (cachedOptions || []).filter(
      ({ opt }) =>
        String(opt.value || "").toLowerCase().includes(q) &&
        !labelMatches.some((m) => m.opt.value === opt.value),
    );
    const descMatches = (cachedOptions || []).filter(
      ({ opt }) =>
        !labelMatches.some((m) => m.opt.value === opt.value) &&
        !valueMatches.some((m) => m.opt.value === opt.value) &&
        String(opt.description || "").toLowerCase().includes(q),
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
                  // Prefer selectedOption.value, then value prop. Use computeTermDisplay (store-first) for formatting.
                  const sel = selectedOption ? selectedOption.value : value;
                  if (!sel) return placeholder;
                  try {
                    const td = computeTermDisplay(String(sel));
                    return td.prefixed;
                  } catch (e) {
                    // If computeTermDisplay fails for any reason, fall back to shortLocalName
                    return shortLocalName(String(sel));
                  }
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
              {filteredOptions.map(({ opt, td }) => (
                <CommandItem
                  key={opt.value}
                  value={opt.value}
                  onSelect={() => {
                    onValueChange(opt.value);
                    setOpen(false);
                    setInputValue('');
                  }}
                  className="flex items-center justify-between"
                >
                  <div className="flex flex-col">
                    <span>{td.prefixed}</span>
                    {(td.label && td.labelSource === "fatmap") ? (
                      <span className="text-xs text-muted-foreground">
                        {td.label}
                      </span>
                    ) : null}
                  </div>
                  <Check
                    className={cn(
                      "ml-auto h-4 w-4",
                      value === opt.value ? "opacity-100" : "opacity-0"
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
