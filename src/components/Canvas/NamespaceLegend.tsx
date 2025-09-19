import { Badge } from "../ui/badge";
import { useOntologyStore } from "@/stores/ontologyStore";
import { buildPaletteForRdfManager } from "./core/namespacePalette";

/**
 * NamespaceLegend (uses central palette)
 *
 * - Reads namespaces from rdfManager.getNamespaces()
 * - Uses buildPaletteForRdfManager to obtain swatch colors (no local palettes)
 * - Empty-string prefix shown as ":".
 */

export const NamespaceLegend = () => {
  const rdfManager = useOntologyStore((s) => s.rdfManager);
  const ontologiesVersion = useOntologyStore((s) => s.ontologiesVersion);
  if (!rdfManager || typeof rdfManager.getNamespaces !== "function") return null;

  // Recompute namespaces/palette when ontologiesVersion changes so the legend updates
  const nsMap = rdfManager.getNamespaces ? rdfManager.getNamespaces() : {};
  const entries = Object.entries(nsMap)
    .filter(([_, uri]) => uri)
    .sort(([a], [b]) => String(a ?? "").localeCompare(String(b ?? "") ));

  if (!entries || entries.length === 0) return null;

  const palette = buildPaletteForRdfManager(nsMap);

  return (
    <div className="absolute top-4 right-4 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border rounded-lg shadow-lg max-w-sm min-w-64 resize overflow-hidden">
      <div className="p-3 border-b">
        <h3 className="text-sm font-semibold">Namespace Legend</h3>
      </div>
      <div className="p-3 max-h-64 overflow-y-scroll scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent">
        <div className="space-y-1">
          {entries.map(([prefix, uri], index) => (
            <div key={String(prefix) + index} className="flex items-center gap-2 text-xs">
              <div className="flex items-center gap-1">
                <div
                  className="w-3 h-3 rounded-full border border-border/50"
                  style={{
                    backgroundColor:
                      palette[String(prefix)] ||
                      palette[String(prefix).replace(/[:#].*$/, "")] ||
                      "hsl(var(--primary))",
                  }}
                />
                <Badge
                  variant="outline"
                  className="font-mono shrink-0 text-xs px-1 py-0"
                >
                  {String(prefix) === "" ? ":" : String(prefix)}
                </Badge>
              </div>
              <span
                className="text-muted-foreground truncate flex-1 text-xs leading-relaxed"
                title={String(uri)}
              >
                {String(uri)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default NamespaceLegend;
