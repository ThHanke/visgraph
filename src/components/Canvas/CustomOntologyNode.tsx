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
import { computeBadgeText } from './core/nodeDisplay';
import { buildPaletteForRdfManager } from './core/namespacePalette';
import { getNamespaceColorFromPalette, normalizeNamespaceKey } from './helpers/namespaceHelpers';
import { defaultURIShortener } from '../../utils/uriShortener';
import { debug } from '../../utils/startupDebug';

/**
 * A tighter-typed node data payload that mirrors the shapes used across the canvas.
 * Keep this conservative and expand fields only as needed.
 */
interface CustomOntologyNodeData {
  uri?: string;
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

/**
 * Small namespace -> color default map to provide sane visuals when palette isn't available.
 */
const namespaceColors: Record<string, string> = {
  foaf: '#4CAF50',
  org: '#4CAF50',
  rdfs: '#FF9800',
  owl: '#2196F3',
  default: '#4CAF50',
};

// module-scope fingerprint set to avoid noisy repeated logs
const _loggedFingerprints = new Set<string>();

function CustomOntologyNodeInner(props: NodeProps) {
  const { data, selected } = props;
  const nodeData = (data ?? {}) as CustomOntologyNodeData;
  const individualNameInitial = String(nodeData.individualName ?? nodeData.iri ?? nodeData.iri ?? '');

  const [isEditing, setIsEditing] = useState(false);
  const [individualName, setIndividualName] = useState(individualNameInitial);

  // stable accessors from the ontology store (avoid prop identity churn)
  const rdfManager = useOntologyStore.getState().rdfManager;
  const availableClasses = useOntologyStore.getState().availableClasses;

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

  // computed short type text (badge)
  const displayedTypeShort = computeBadgeText(nodeData as unknown as Record<string, unknown>, rdfManager, availableClasses);

  const namespace = String(nodeData.namespace ?? '');
  const paletteLocal = (() => {
    try { return buildPaletteForRdfManager(rdfManager); } catch (_) { return undefined; }
  })();
  const derivedColor = getNamespaceColorFromPalette(paletteLocal as Record<string, string> | undefined, namespace);

  // Badge/leftbar color: prefer explicit node color (set during mapping), otherwise palette-derived, otherwise fallback.
  const badgeFallback = (nodeData && (nodeData as any).color)
    ? String((nodeData as any).color)
    : (derivedColor || (namespaceColors[namespace] || namespaceColors.default));

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
      const term =
        propertyIri.startsWith('_:') ? propertyIri : defaultURIShortener.shortenURI(propertyIri);
      annotations.push({ term, value: valueStr });
    });
  } else if (nodeData.properties && typeof nodeData.properties === 'object') {
    Object.entries(nodeData.properties).slice(0, 6).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      const valueStr = String(v);
      if (valueStr.trim() === '') return;
      const term = String(k).startsWith('_:') ? String(k) : defaultURIShortener.shortenURI(String(k));
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

  const canonicalIri = String(nodeData.iri ?? nodeData.iri ?? '');
  const headerTitle = canonicalIri;
  const headerDisplay = canonicalIri.startsWith('_:') ? canonicalIri : defaultURIShortener.shortenURI(canonicalIri).replace(/^(https?:\/\/)?(www\.)?/, '');

    return (
      <div ref={rootRef} className={cn('inline-flex overflow-hidden', selected ? 'ring-2 ring-primary' : '')}>
      {/* Main body (autosize). Left color bar is provided by the outer React Flow node wrapper via CSS variable (--node-leftbar-color). */}
      <div className="px-4 py-3 min-w-0 flex-1 w-auto" style={{ background: themeBg }}>
        {/* Header */}
        <div className="flex items-center gap-3 mb-2">
          <div className="text-sm font-bold text-foreground truncate" title={headerTitle}>
            {headerDisplay}
          </div>

          <div
            className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold text-white"
            style={{ background: badgeFallback, border: `1px solid ${darken(badgeFallback, 0.12)}` }}
          >
            {displayedTypeShort || nodeData.classType || (namespace ? namespace : 'unknown')}
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

        {/* Type (human-friendly) */}
        <div className="text-sm text-muted-foreground mb-3">
          {nodeData.classType ?? displayedTypeShort ?? 'Unknown'}
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
