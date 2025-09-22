import React, { memo } from "react";
import { Badge } from "../ui/badge";

interface NamespaceLegendCoreProps {
  entries: Array<[string, string]>;
  palette?: Record<string, string> | undefined;
  className?: string;
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
}: NamespaceLegendCoreProps) {
  if (!entries || entries.length === 0) return null;

  const getColor = (prefix: string) => {
    try {
      if (!palette) return undefined;
      const p = String(prefix || "");
      return (
        palette[p] ||
        palette[p.replace(/[:#].*$/, "")] ||
        palette[p.toLowerCase()] ||
        undefined
      );
    } catch (_) {
      return undefined;
    }
  };

  return (
    <div className={className}>
      <div className="space-y-2">
        {entries.map(([prefix, uri], index) => (
          <div key={String(prefix) + "-" + index} className="flex items-center gap-2 text-xs">
            <div className="flex items-center gap-1.5 shrink-0">
              <div
                className="w-3 h-3 rounded-full border border-border/50"
                style={{ backgroundColor: getColor(String(prefix)) || undefined }}
                aria-hidden="true"
              />
              <Badge variant="outline" className="font-mono text-xs px-1.5 py-0.5">
                {String(prefix) === "" ? ":" : String(prefix)}
              </Badge>
            </div>
            <span
              className="text-muted-foreground truncate flex-1 text-xs leading-relaxed"
              title={String(uri || "")}
            >
              {String(uri || "")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
});

export default NamespaceLegendCore;
