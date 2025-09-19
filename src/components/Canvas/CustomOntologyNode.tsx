import React, { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, NodeProps } from '@xyflow/react';
import { cn } from '../../lib/utils';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Edit3, AlertTriangle, Info } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '../ui/popover';
import { useOntologyStore } from '../../stores/ontologyStore';
import { buildPaletteForRdfManager, usePaletteFromRdfManager } from './core/namespacePalette';
import { getNamespaceColorFromPalette, normalizeNamespaceKey } from './helpers/namespaceHelpers';
import { computeTermDisplay, shortLocalName } from '../../utils/termUtils';
import { computeBadgeText, computeDisplayInfo } from './core/nodeDisplay';
import { debug } from '../../utils/startupDebug';

/**
 * A tighter-typed node data payload that mirrors the shapes used across the canvas.
 * Keep this conservative and expand fields only as needed.
 */
interface CustomOntologyNodeData {
  iri?: string;
  classType?: string;
  individualName?: string;
  namespace?: string;
  displayType?: string;
  rdfTypes?: string[] | null;
  properties?: Record<string, unknown>;
  annotationProperties?: Array<{ property?: string; value?: unknown }>;
  errors?: string[];
  // keep extension point for other stores (BUT avoid "any")
  [key: string]: unknown;
}


// module-scope fingerprint set to avoid noisy repeated logs
const _loggedFingerprints = new Set<string>();

function CustomOntologyNodeInner(props: NodeProps) {
  const { data, selected } = props;
  const nodeData = (data ?? {}) as CustomOntologyNodeData;
  const individualNameInitial = String(nodeData.individualName ?? nodeData.iri ?? '');

  const [isEditing, setIsEditing] = useState(false);
  const [individualName, setIndividualName] = useState(individualNameInitial);

  // stable accessors from the ontology store (subscribe to ontologiesVersion so node updates when namespaces change)
  const rdfManager = useOntologyStore((s) => s.rdfManager);
  const ontologiesVersion = useOntologyStore((s) => s.ontologiesVersion);
  const availableClasses = useOntologyStore((s) => s.availableClasses);

  // debug fingerprint - emit only on meaningful changes and avoid duplicates
  const lastFp = useRef<string | null>(null);
  const rdfTypesKey = Array.isArray(nodeData.rdfTypes) ? nodeData.rdfTypes.join('|') : '';
  useEffect(() => {
    try {
      const uri = (nodeData.iri || nodeData.iri || '') as string;
      const types = rdfTypesKey;
      const fp = `${uri}|${String(nodeData.classType ?? '')}|${types}|${String(nodeData.displayType ?? '')}`;

      if (lastFp.current === fp) return;
      lastFp.current = fp;

      if (_loggedFingerprints.has(fp)) return;
      _loggedFingerprints.add(fp);

      const payload = {
        uri,
        classType: nodeData.classType,
        rdfTypes: nodeData.rdfTypes,
        displayType: nodeData.displayType,
      };

      if (typeof window !== 'undefined' && (window as any).__VG_DEBUG__) {
        try { debug('CustomOntologyNode.displayInfo', payload); } catch (_) { /* ignore */ }
      }
    } catch (_) { /* ignore */ }
  }, [nodeData.iri, nodeData.iri, nodeData.classType, rdfTypesKey, nodeData.displayType, nodeData.rdfTypes]);

  // Use canonical label persisted on the node (mapping is authoritative)
  const displayedTypeShort = String(nodeData.label || nodeData.classType || shortLocalName(nodeData.iri || ''));
  // Compute badge text (prefer a prefixed meaningful type) and a list of all rdf:type displays.
  let badgeText = displayedTypeShort;
  let typesList: string[] = [];
  try {
    if (rdfManager) {
      try {
        // Compute badge text from the first meaningful type deterministically and
        // ensure we preserve any leading ':' that indicates the default namespace.
        const candidates: string[] = [
          ...(nodeData.displayType ? [String(nodeData.displayType)] : []),
          ...(nodeData.classType ? [String(nodeData.classType)] : []),
          ...(Array.isArray(nodeData.rdfTypes) ? (nodeData.rdfTypes as string[]).map(String) : []),
          ...((nodeData as any)?.types ? (nodeData as any).types.map(String) : []),
        ].filter(Boolean);

        const chosenType = candidates.find(t => t && !/NamedIndividual\b/i.test(String(t)));

        if (chosenType) {
          try {
            // Use computeTermDisplay directly so we keep the prefixed form (including leading ':').
            const td = computeTermDisplay(String(chosenType), rdfManager as any);
            if (td && td.prefixed && String(td.prefixed).trim() !== "") {
              badgeText = td.prefixed;
            } else if (td && td.short) {
              badgeText = td.short;
            }
          } catch (_) {
            // Fallback to the previous helper if strict display computation fails.
            try {
              const bt = computeBadgeText(nodeData as any, rdfManager as any, availableClasses as any);
              if (bt && String(bt).trim() !== "") badgeText = String(bt);
            } catch (_) {
              /* ignore */
            }
          }
        } else {
          // No meaningful type found — try the generic helper as last resort.
          try {
            const bt = computeBadgeText(nodeData as any, rdfManager as any, availableClasses as any);
            if (bt && String(bt).trim() !== "") badgeText = String(bt);
          } catch (_) {
            /* ignore */
          }
        }
      } catch (_) {
        // ignore failures computing badge text
      }

      if (Array.isArray(nodeData.rdfTypes) && nodeData.rdfTypes.length > 0) {
        typesList = nodeData.rdfTypes.map((t: any) => {
          try {
            const td = computeTermDisplay(String(t), rdfManager as any);
            return td.prefixed || td.short || String(t);
          } catch (_) {
            // fallback to raw string
            return String(t);
          }
        }).filter(Boolean);
      }
    }
  } catch (_) { /* ignore overall */ }

  const namespace = String(nodeData.namespace ?? '');

  // Use the central palette hook (single source of truth). Prefer a color explicitly
  // attached to node.data.paletteColor by the mapping step; otherwise attempt to
  // resolve the badge prefix against the palette map. If the palette does NOT
  // contain a mapping for the node's prefix, we intentionally surface a visible
  // error (no silent neutral fallback).
  const paletteMap = usePaletteFromRdfManager();
  const nodePaletteColor = (nodeData as any).paletteColor as string | undefined;
  let badgePrefixKey: string | null = null;
  let effectiveColor: string | undefined = undefined;
  let paletteMissing = false;

  try {
    // Recompute candidate type deterministically (same rules as above) so we can derive its prefix.
    const candidates: string[] = [
      ...(nodeData.displayType ? [String(nodeData.displayType)] : []),
      ...(nodeData.classType ? [String(nodeData.classType)] : []),
      ...(Array.isArray(nodeData.rdfTypes) ? (nodeData.rdfTypes as string[]).map(String) : []),
      ...((nodeData as any)?.types ? (nodeData as any).types.map(String) : []),
    ].filter(Boolean);
    const chosenType = candidates.find(t => t && !/NamedIndividual\b/i.test(String(t)));

    if (chosenType && rdfManager) {
      try {
        const td = computeTermDisplay(String(chosenType), rdfManager as any);
        const pref = td && td.prefixed ? String(td.prefixed) : '';
        if (pref) {
          // prefix is text before the first colon (':' ), empty string represents default prefix
          badgePrefixKey = pref.split(':', 1)[0];
        }
      } catch (_) {
        // ignore computeTermDisplay failures here; we'll surface missing palette below
      }
    }
  } catch (_) {
    // ignore prefix detection failures
  }

  // Determine authoritative color: mapping-time color wins, otherwise use paletteMap for badge prefix
  if (nodePaletteColor) {
    effectiveColor = nodePaletteColor;
  } else if (badgePrefixKey !== null && typeof paletteMap === 'object') {
    const rawKey = String(badgePrefixKey || '');
    effectiveColor = (paletteMap as Record<string,string>)[rawKey] || (paletteMap as Record<string,string>)[rawKey.replace(/[:#].*$/, '')];
  }

  if (!effectiveColor) {
    paletteMissing = true;
    // Surface an explicit, discoverable error for developers so missing palette mappings are visible.
    try {
      console.error('[VG] palette missing for node', {
        iri: nodeData.iri,
        badgePrefixKey,
        namespace,
      });
    } catch (_) { /* ignore console failures */ }
  }

  // Final badge color (visible). When paletteMissing is true we intentionally use a
  // clear error color so the UI makes the problem obvious instead of hiding it.
  const badgeColor = effectiveColor || '#FF4D4F';

  // Authoritative left-bar color: prefer mapping-time paletteColor, then effectiveColor derived from paletteMap.
  // When paletteMissing is true we render a visible error color instead of silently falling back.
  const leftColor = !paletteMissing
    ? ((nodeData as any).paletteColor as string | undefined) || effectiveColor
    : '#FF4D4F';

  const themeBg = (typeof document !== 'undefined')
    ? (getComputedStyle(document.documentElement).getPropertyValue('--node-bg') || '').trim() || '#ffffff'
    : '#ffffff';
  const hasErrors = Array.isArray(nodeData.errors) && nodeData.errors.length > 0;

  // Annotations: prefer annotationProperties (array) then properties (map)
  // Display-only: shorten predicate IRIs for labels. Persisted shape uses `propertyUri`.
  const annotations: Array<{ term: string; value: string }> = [];
  if (Array.isArray(nodeData.annotationProperties) && nodeData.annotationProperties.length > 0) {
    nodeData.annotationProperties.forEach((ap) => {
      // Read canonical property IRI first (propertyUri), then fall back to legacy fields.
      const propertyIri = String(
        (ap && (ap as any).propertyUri) ||
          (ap && (ap as any).property) ||
          (ap && (ap as any).term) ||
          (ap && (ap as any).key) ||
          '',
      );
      const rawValue = (ap && (ap as any).value);
      // Skip entries without a property IRI or without a non-empty value
      if (!propertyIri) return;
      if (rawValue === undefined || rawValue === null) return;
      const valueStr = String(rawValue);
      if (valueStr.trim() === '') return;
      // For display, shorten IRIs but leave blank-node labels (starting with "_:") unchanged.
      const term = (() => {
        if (propertyIri.startsWith('_:')) return propertyIri;
        if (!rdfManager) throw new Error(`computeTermDisplay requires rdfManager to resolve '${propertyIri}'`);
        const td = computeTermDisplay(propertyIri, rdfManager as any);
        return td.prefixed || td.short || '';
      })();
      annotations.push({ term, value: valueStr });
    });
  } else if (nodeData.properties && typeof nodeData.properties === 'object') {
    Object.entries(nodeData.properties).slice(0, 6).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      const valueStr = String(v);
      if (valueStr.trim() === '') return;
      const term = (() => {
        const keyStr = String(k);
        if (keyStr.startsWith('_:')) return keyStr;
        if (!rdfManager) throw new Error(`computeTermDisplay requires rdfManager to resolve '${keyStr}'`);
        const td = computeTermDisplay(keyStr, rdfManager as any);
        return td.prefixed || td.short || '';
      })();
      annotations.push({ term, value: valueStr });
    });
  }

  // detect if rdf:type triples are present but class definitions not loaded (informational)
  const typePresentButNotLoaded = !nodeData.classType && Array.isArray(nodeData.rdfTypes) && nodeData.rdfTypes.some((t) => Boolean(t) && !/NamedIndividual/i.test(String(t)));

  // keep local edit state in sync if incoming props change externally
  useEffect(() => {
    setIndividualName(individualNameInitial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeData.iri, nodeData.individualName]);

  // Measure DOM size and report back to the canvas so dagre can use real node sizes.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const lastMeasuredRef = useRef<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;

    const report = (w: number, h: number) => {
      try {
        const cb = (data as any)?.onSizeMeasured;
        const last = lastMeasuredRef.current;
        if (last && Math.abs(last.w - w) < 2 && Math.abs(last.h - h) < 2) {
          return;
        }
        lastMeasuredRef.current = { w, h };
        if (typeof cb === 'function') {
          try { cb(Math.round(w), Math.round(h)); } catch (_) { /* ignore callback errors */ }
        }
      } catch (_) { /* ignore */ }
    };

    // Initial report
    report(el.offsetWidth, el.offsetHeight);

    // Use ResizeObserver to detect size changes
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const cr = entry.contentRect;
          report(cr.width, cr.height);
        }
      });
      ro.observe(el);
    } catch (_) {
      // ResizeObserver might not be available in some environments; fallback to window resize
      const onWin = () => report(el.offsetWidth, el.offsetHeight);
      window.addEventListener('resize', onWin);
      return () => {
        window.removeEventListener('resize', onWin);
      };
    }

    return () => {
      try { if (ro) ro.disconnect(); } catch (_) { /* ignore */ }
    };
    // Intentionally exclude data.onSizeMeasured from deps to avoid reattaching observer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootRef]);

  // Sync the outer React Flow wrapper left-bar color with the authoritative badge/ palette color.
  // We run this after the ResizeObserver effect so `rootRef` is available. This ensures the
  // wrapper pseudo-element (::before) uses the exact same color as the badge.
  useEffect(() => {
    try {
      const el = rootRef.current;
      if (!el) return;
      const wrapper: HTMLElement | null =
        typeof el.closest === "function" ? (el as any).closest(".react-flow__node") : (el.parentElement || null);
      if (!wrapper || !wrapper.style) return;
      const colorToApply = badgeColor || leftColor;
      // Debug: log before/after applying to help trace why wrapper/ badge differ
      try {
        if (typeof console !== 'undefined' && typeof console.debug === 'function') {
          try {
            console.debug('[VG_DEBUG] CustomOntologyNode.syncWrapperColor', {
              id: (nodeData as any)?.iri || (nodeData as any)?.key,
              badgeColor,
              leftColor,
              wrapperCurrentVar: wrapper.style.getPropertyValue('--node-leftbar-color'),
            });
          } catch (_) { /* ignore logging failures */ }
        }
      } catch (_) { /* ignore */ }

      if (colorToApply) {
        try {
          wrapper.style.setProperty("--node-leftbar-color", String(colorToApply));
        } catch (_) {
          try { wrapper.style.setProperty("--node-leftbar-color", String(colorToApply)); } catch (_) { /* ignore */ }
        }
        // Log after applying
        try {
          if (typeof console !== 'undefined' && typeof console.debug === 'function') {
            try {
              console.debug('[VG_DEBUG] CustomOntologyNode.syncWrapperColor.applied', {
                id: (nodeData as any)?.iri || (nodeData as any)?.key,
                applied: String(colorToApply),
                wrapperNow: wrapper.style.getPropertyValue('--node-leftbar-color'),
              });
            } catch (_) { /* ignore */ }
          }
        } catch (_) { /* ignore */ }
      } else {
        try { wrapper.style.removeProperty("--node-leftbar-color"); } catch (_) { /* ignore */ }
      }
    } catch (_) {
      /* ignore */
    }
  }, [badgeColor, leftColor]);

  const canonicalIri = String(nodeData.iri ?? '');
  const headerTitle = canonicalIri;
  const headerDisplay = (() => {
    if (!canonicalIri) return '';
    if (canonicalIri.startsWith('_:')) return canonicalIri;
    if (!rdfManager) throw new Error(`computeTermDisplay requires rdfManager to resolve '${canonicalIri}'`);
    const td = computeTermDisplay(canonicalIri, rdfManager as any);
    return (td.prefixed || td.short || '').replace(/^(https?:\/\/)?(www\.)?/, '');
  })();

  return (
    <div
      ref={rootRef}
      className={cn('inline-flex overflow-hidden', selected ? 'ring-2 ring-primary' : '', paletteMissing ? 'ring-2 ring-destructive' : '')}
    >
      {/* Main body (autosize). */}
      <div className="px-4 py-3 min-w-0 flex-1 w-auto" style={{ background: themeBg }}>
        {/* Header */}
        <div className="flex items-center gap-3 mb-2">
          <div className="text-sm font-bold text-foreground truncate" title={headerTitle}>
            {headerDisplay}
          </div>

          <div
            className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold text-black flex items-center gap-1"
            title={paletteMissing ? 'Palette mapping missing for this node prefix' : undefined}
            style={{ background: `var(--node-leftbar-color, ${badgeColor})`, border: `1px solid ${darken(badgeColor, 0.12)}` }}
          >
            <span className="truncate">{badgeText || displayedTypeShort || nodeData.classType || (namespace ? namespace : 'unknown')}</span>
            {paletteMissing && (
              <span title="Palette mapping missing" className="text-red-600" aria-hidden>
                <AlertTriangle className="h-3 w-3" />
              </span>
            )}
          </div>

          {/* Error indicator */}
          {hasErrors && (
            <div className="ml-auto">
              <Popover>
                <PopoverTrigger asChild>
                  <button className="h-6 w-6 p-0 text-destructive flex items-center justify-center" aria-label="Errors">
                    <AlertTriangle className="h-4 w-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-64">
                  <div className="space-y-2 text-sm">
                    <div className="font-medium">Validation Errors</div>
                    <ul className="text-xs text-muted-foreground space-y-1">
                      {nodeData.errors?.map((e, idx) => (
                        <li key={idx}>{String(e)}</li>
                      ))}
                    </ul>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>

        {/* Type (human-friendly) + list of type definitions */}
        <div className="text-sm text-muted-foreground mb-3">
          {typesList && typesList.length > 0 && (
            <div className="text-xs text-muted-foreground mt-1 truncate">
              {typesList.join(', ')}
            </div>
          )}
        </div>

        {/* Annotations */}
        <div className="pt-2 border-t border-gray-100">
          {annotations.length === 0 ? (
            <div className="text-xs text-muted-foreground">No annotations</div>
          ) : (
            <div className="space-y-2">
              {annotations.map((a, idx) => (
                <div key={idx} className="grid grid-cols-[110px_1fr] gap-2 text-sm">
                  <div className="font-medium text-xs text-muted-foreground truncate">{a.term}</div>
                  <div className="text-xs text-foreground truncate">{a.value}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Informational note */}
        {typePresentButNotLoaded && (
          <div className="mt-2 text-xs text-muted-foreground">
            Type present but ontology not loaded
          </div>
        )}
      </div>

      {/* Handles: put them visually outside via React Flow but keep them here for connection points */}
      <Handle
        type="target"
        position={Position.Top}
        className="!bg-transparent !border-0"
        style={{ right: 12, top: -6 }}
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!bg-transparent !border-0"
        style={{ right: 12, bottom: -6 }}
      />
    </div>
  );
}

/**
 * Small color utility to darken a hex color by a factor (0-1).
 * Not perfect but good enough for borders.
 */
function darken(hex: string, amount: number) {
  try {
    const c = hex.replace('#', '');
    const num = parseInt(c.length === 3 ? c.split('').map(s => s + s).join('') : c, 16);
    let r = (num >> 16) & 0xff;
    let g = (num >> 8) & 0xff;
    let b = num & 0xff;
    r = Math.max(0, Math.min(255, Math.round(r * (1 - amount))));
    g = Math.max(0, Math.min(255, Math.round(g * (1 - amount))));
    b = Math.max(0, Math.min(255, Math.round(b * (1 - amount))));
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  } catch (_) {
    return hex;
  }
}

export const CustomOntologyNode = memo(CustomOntologyNodeInner);
CustomOntologyNode.displayName = 'CustomOntologyNode';
