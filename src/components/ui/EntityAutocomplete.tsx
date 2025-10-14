import { useState, useRef, useEffect } from 'react';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from './command';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Button } from './button';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '../../lib/utils';


export interface EntityOption {
 iri: string;
  label: string;
  namespace: string;
  description?: string;
  rdfType: string;
}

interface EntityAutocompleteProps {
  entities: EntityOption[];
  value?: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
  disabled?: boolean;
  filterByType?: 'owl:Class' | 'owl:ObjectProperty' | 'owl:AnnotationProperty';
}

export const EntityAutocomplete = ({
  entities,
  value,
  onValueChange,
  placeholder = "Select entity...",
  emptyMessage = "No entities found.",
  className,
  disabled = false,
  filterByType
}: EntityAutocompleteProps) => {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');

  const filteredEntities = entities
    .filter(entity => filterByType ? entity.rdfType === filterByType : true)
    .filter(entity =>
      entity.label.toLowerCase().includes(inputValue.toLowerCase()) ||
      entity.iri.toLowerCase().includes(inputValue.toLowerCase()) ||
      entity.namespace.toLowerCase().includes(inputValue.toLowerCase()) ||
      entity.description?.toLowerCase().includes(inputValue.toLowerCase())
    )
    .slice(0, 5); // Show only top 5 matches

  const selectedEntity = entities.find(entity => entity.iri === value);
  const displayLabel = selectedEntity
    ? selectedEntity.label
    : (value ?? placeholder);

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
          {displayLabel}
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent 
        className="w-full p-0 bg-card border border-border z-[9999]" 
        align="start" 
        sideOffset={4}
      >
        <Command>
          <CommandInput 
            placeholder={`Search ${placeholder.toLowerCase()}...`}
            value={inputValue}
            onValueChange={setInputValue}
          />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {filteredEntities.map((entity) => (
                <CommandItem
                  key={entity.iri}
                  value={entity.iri}
                  onSelect={() => {
                    onValueChange(entity.iri);
                    setOpen(false);
                    setInputValue('');
                  }}
                  className="flex items-center justify-between"
                >
                  <div className="flex flex-col">
                    <span className="font-medium">{entity.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {entity.iri}
                    </span>
                    {entity.description && (
                      <span className="text-xs text-muted-foreground">
                        {entity.description}
                      </span>
                    )}
                  </div>
                  <Check
                    className={cn(
                      "ml-auto h-4 w-4",
                      value === entity.iri ? "opacity-100" : "opacity-0"
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
