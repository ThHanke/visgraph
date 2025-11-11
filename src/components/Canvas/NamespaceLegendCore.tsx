import React, { memo } from "react";
import { Badge } from "../ui/badge";
import { Trash2 } from "lucide-react";

interface NamespaceLegendCoreProps {
  entries: Array<[string, string]>;
  palette?: Record<string, string> | undefined;
  className?: string;
  onRemoveEntry?: (prefix: string, uri: string) => void;
}

/**
 * NamespaceLegendCore
 *
 * Stateless, pure renderer for a list of namespace entries.
 * - entries: array of [prefix, uri] tuples (sorted/stable order expected)
 * - palette: optional prefix -> color map
 *
 * This component intentionally avoids any store access or side-effects so it
 * can be reused in different wrappers (resizable, non-resizable, test harness).
 */
export const NamespaceLegendCore = memo(function NamespaceLegendCore({
  entries,
  palette,
  className,
  onRemoveEntry,
}: NamespaceLegendCoreProps) {
  if (!entries || entries.length === 0) return null;

  const getColor = (prefix: string) => {
    {
      if (!palette) return undefined;
      const p = String(prefix || "");
      return (
        palette[p] ||
        palette[p.replace(/[:#].*$/, "")] ||
        palette[p.toLowerCase()] ||
        undefined
      );
    }
  };

  return (
    <div className={className}>
      <div className="space-y-2">
        {entries.map(([prefixRaw, uriRaw], index) => {
          const prefix = String(prefixRaw ?? "");
          const uri = String(uriRaw ?? "");
          const label = prefix.length === 0 ? ":" : prefix;
          const color = getColor(prefix);
          const showRemove = typeof onRemoveEntry === "function";
          return (
            <div key={String(prefix) + "-" + index} className="flex items-center gap-2 text-xs">
              <div className="flex items-center gap-1.5 shrink-0">
                <div
                  className="w-3 h-3 rounded-full border border-border/50"
                  style={{ ['--ns-color' as any]: color || "", backgroundColor: color || undefined }}
                  data-ns-dot
                  aria-hidden="true"
                />
                <Badge variant="outline" className="font-mono text-xs px-1.5 py-0.5">
                  {label}
                </Badge>
              </div>
              <span
                className="text-foreground truncate flex-1 text-xs leading-relaxed"
                title={uri}
              >
                {uri}
              </span>
              {showRemove ? (
                <button
                  type="button"
                  className="ml-1 inline-flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => onRemoveEntry(prefix, uri)}
                  aria-label={`Remove namespace ${label}`}
                  title="Remove namespace"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default NamespaceLegendCore;
