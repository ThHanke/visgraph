import React, { useMemo, useState } from "react";

type KVItem = { key: string; value: any };

interface PropertyListProps {
  items: KVItem[];
  searchable?: boolean;
  className?: string;
  valueRenderer?: (v: any) => React.ReactNode;
  maxHeight?: string;
  /**
   * CSS width for the key/label column. Example: "120px" or "8rem".
   * This keeps labels left-aligned and prevents the label column from
   * expanding to take excessive space when the parent is wide.
   */
  labelWidth?: string;
}

/**
 * PropertyList
 *
 * Reusable, tailwind-friendly key/value list with optional inline search.
 * - items: array of { key, value }
 * - searchable: show a small search input to filter by key or value
 * - valueRenderer: custom renderer for values
 * - labelWidth: fixed width for the label column (prevents large empty gaps)
 */
export default function PropertyList({
  items,
  searchable = false,
  className = "",
  valueRenderer,
  maxHeight = "max-h-48",
  labelWidth = "120px",
}: PropertyListProps) {
  const [q, setQ] = useState("");

  const normalizedQuery = (q || "").trim().toLowerCase();

  const filtered = useMemo(() => {
    if (!normalizedQuery) return items;
    return items.filter((it) => {
      try {
        const k = String(it.key || "").toLowerCase();
        const v = typeof it.value === "string" ? it.value.toLowerCase() : JSON.stringify(it.value).toLowerCase();
        return k.includes(normalizedQuery) || v.includes(normalizedQuery);
      } catch (_) {
        return false;
      }
    });
  }, [items, normalizedQuery]);

  const renderValue = (v: any) => {
    if (valueRenderer) return valueRenderer(v);
    if (v === null || v === undefined) return <span className="text-muted-foreground">—</span>;
    if (Array.isArray(v)) {
      if (v.length === 0) return <span className="text-muted-foreground">—</span>;
      return (
        <div className="flex flex-wrap gap-1">
          {v.map((x, i) => (
            <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {String(x)}
            </span>
          ))}
        </div>
      );
    }
    if (typeof v === "object") {
      try {
        return <pre className="text-xs whitespace-pre-wrap break-words">{JSON.stringify(v, null, 2)}</pre>;
      } catch (_) {
        return <span className="text-xs">{String(v)}</span>;
      }
    }
    return <span className="text-xs text-foreground break-words">{String(v)}</span>;
  };

  // Create a grid template style so the label column uses a fixed width and the value column flexes.
  const gridTemplate = { gridTemplateColumns: `${labelWidth} 1fr` };

  return (
    <div className={className}>
      {searchable && (
        <div className="mb-2">
          <input
            aria-label="Filter properties"
            placeholder="Filter properties..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="w-full text-xs px-2 py-1 rounded border bg-input text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
        </div>
      )}

      <div className={`space-y-2 overflow-auto ${maxHeight}`}>
        {filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground">No properties</div>
        ) : (
          filtered.map((it, idx) => (
            <div
              key={idx}
              className="grid gap-3 items-start"
              style={gridTemplate}
            >
              <div className="text-xs text-muted-foreground" style={{ textAlign: "left", wordBreak: "break-all" }}>
                {it.key}
              </div>
              <div className="text-xs text-foreground" style={{ textAlign: "left" }}>
                {renderValue(it.value)}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
