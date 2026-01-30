/**
 * SearchOverlay component
 * 
 * Custom search interface that searches ALL nodes including off-screen ones
 * by examining node data directly rather than relying on DOM text.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

interface SearchOverlayProps {
  isOpen: boolean;
  onClose: () => void;
  onSearch: (searchText: string) => void;
  onNext: () => void;
  onPrevious: () => void;
  matchCount: number;
  currentMatchIndex: number;
}

export function SearchOverlay({
  isOpen,
  onClose,
  onSearch,
  onNext,
  onPrevious,
  matchCount,
  currentMatchIndex,
}: SearchOverlayProps) {
  const [searchText, setSearchText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when overlay opens
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isOpen]);

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchText(value);
    onSearch(value);
  }, [onSearch]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        onPrevious();
      } else {
        onNext();
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [onNext, onPrevious, onClose]);

  if (!isOpen) return null;

  const hasMatches = matchCount > 0;
  const displayIndex = hasMatches ? currentMatchIndex + 1 : 0;

  return (
    <div className="fixed top-4 right-4 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
      <div className="bg-background border border-border rounded-lg shadow-lg p-3 min-w-[320px]">
        <div className="flex items-center gap-2">
          {/* Search Icon */}
          <Search className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          
          {/* Search Input */}
          <input
            ref={inputRef}
            type="text"
            value={searchText}
            onChange={handleSearchChange}
            onKeyDown={handleKeyDown}
            placeholder="Search nodes..."
            className={cn(
              "flex-1 bg-transparent border-none outline-none text-sm",
              "placeholder:text-muted-foreground"
            )}
          />
          
          {/* Match Counter */}
          {searchText && (
            <div className={cn(
              "text-xs font-medium px-2 py-1 rounded",
              hasMatches ? "text-foreground bg-muted" : "text-muted-foreground"
            )}>
              {hasMatches ? `${displayIndex}/${matchCount}` : 'No matches'}
            </div>
          )}
          
          {/* Navigation Buttons */}
          {hasMatches && (
            <>
              <button
                onClick={onPrevious}
                className="p-1 hover:bg-muted rounded transition-colors"
                title="Previous match (Shift+Enter)"
              >
                <ChevronUp className="w-4 h-4" />
              </button>
              <button
                onClick={onNext}
                className="p-1 hover:bg-muted rounded transition-colors"
                title="Next match (Enter)"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            </>
          )}
          
          {/* Close Button */}
          <button
            onClick={onClose}
            className="p-1 hover:bg-muted rounded transition-colors"
            title="Close (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        
        {/* Helper Text */}
        <div className="mt-2 text-xs text-muted-foreground">
          Press Enter to find next, Shift+Enter for previous
        </div>
      </div>
    </div>
  );
}
