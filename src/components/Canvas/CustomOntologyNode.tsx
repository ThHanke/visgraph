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
  const individualNameInitial = String(nodeData.individualName ?? nodeData.uri ?? '');

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
      const uri = (nodeData.uri || nodeData.iri || '') as string;
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
  }, [nodeData.uri, nodeData.iri, nodeData.classType, rdfTypesKey, nodeData.displayType, nodeData.rdfTypes]);

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
  const annotations: Array<{ term: string; value: string }> = [];
  if (Array.isArray(nodeData.annotationProperties) && nodeData.annotationProperties.length > 0) {
    nodeData.annotationProperties.forEach((ap) => {
      const term = String((ap && (ap as any).property) || 'property');
      const value = String((ap && (ap as any).value) ?? '');
      annotations.push({ term, value });
    });
  } else if (nodeData.properties && typeof nodeData.properties === 'object') {
    Object.entries(nodeData.properties).slice(0, 6).forEach(([k, v]) => {
      annotations.push({ term: k, value: String(v) });
    });
  }

  // detect if rdf:type triples are present but class definitions not loaded (informational)
  const typePresentButNotLoaded = !nodeData.classType && Array.isArray(nodeData.rdfTypes) && nodeData.rdfTypes.some((t) => Boolean(t) && !/NamedIndividual/i.test(String(t)));

  // keep local edit state in sync if incoming props change externally
  useEffect(() => {
    setIndividualName(individualNameInitial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeData.uri, nodeData.individualName]);

  return (
    <div className={cn('inline-flex overflow-hidden', selected && 'ring-2 ring-primary')}>
      {/* Main body (autosize). Left color bar is provided by the outer React Flow node wrapper via CSS variable (--node-leftbar-color). */}
      <div className="px-4 py-3 min-w-0 flex-1 w-auto" style={{ background: themeBg }}>
        {/* Header */}
        <div className="flex items-center gap-3 mb-2">
          <div className="text-sm font-bold text-foreground truncate" title={String(nodeData.uri || nodeData.iri || '')}>
            {String(nodeData.uri || nodeData.iri || '').replace(/^(https?:\/\/)?(www\.)?/, '')}
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
