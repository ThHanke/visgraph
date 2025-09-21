import React, { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, NodeProps, useConnection, useUpdateNodeInternals } from '@xyflow/react';
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
  [key: string]: unknown;
}

const _loggedFingerprints = new Set<string>();

function CustomOntologyNodeInner(props: NodeProps) {
  const { data, selected, id } = props;
  // Use React Flow's built-in connection hook so the node can render conditional handles
  // and participate in native "connection in progress" state (shows "Drop here" targets etc).
  const connection = useConnection();
  const updateNodeInternals = useUpdateNodeInternals();
  // Ensure React Flow knows about conditional handles when connection state changes.
  // This mirrors the example note: "If handles are conditionally rendered and not present initially,
  // you need to update the node internals".
  useEffect(() => {
    try {
      if (typeof id === 'string') updateNodeInternals(String(id));
    } catch (_) {
      /* ignore */
    }
  }, [updateNodeInternals, connection?.inProgress, id]);

  const isTarget =
    !!(connection && (connection as any).inProgress && (connection as any).fromNode && String((connection as any).fromNode.id) !== String(id));
  const nodeData = (data ?? {}) as CustomOntologyNodeData;
  const individualNameInitial = String(nodeData.individualName ?? nodeData.iri ?? '');

  const [isEditing, setIsEditing] = useState(false);
  const [individualName, setIndividualName] = useState(individualNameInitial);

  const rdfManager = useOntologyStore((s) => s.rdfManager);
  const ontologiesVersion = useOntologyStore((s) => s.ontologiesVersion);
  const availableClasses = useOntologyStore((s) => s.availableClasses);

  const lastFp = useRef<string | null>(null);
  const rdfTypesKey = Array.isArray(nodeData.rdfTypes) ? nodeData.rdfTypes.join('|') : '';
  useEffect(() => {
    try {
      const uri = String(nodeData.iri || '');
      const fp = `${uri}|${String(nodeData.classType ?? '')}|${rdfTypesKey}|${String(nodeData.displayType ?? '')}`;
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
  }, [nodeData.iri, nodeData.classType, rdfTypesKey, nodeData.displayType, nodeData.rdfTypes]);

  // Display helpers
  const displayedTypeShort = String(nodeData.label || shortLocalName(nodeData.iri || ''));
  let badgeText = displayedTypeShort;
  let typesList: string[] = [];

  // Compute badgeText and typesList strictly:
  // - Prefer expanded rdfTypes (full IRIs) when available.
  // - Otherwise, try prefixed/displayType/classType candidates via rdfManager (no synthesis).
  try {
    const rdfTypesArr: string[] = Array.isArray(nodeData.rdfTypes)
      ? (nodeData.rdfTypes as string[]).map(String).filter(Boolean)
      : [];

    if (rdfTypesArr.length > 0 && rdfManager) {
      try {
        // Prefer the first meaningful (non-NamedIndividual) rdf:type for the badge.
        const primaryCandidate =
          rdfTypesArr.find((t) => t && !/NamedIndividual\b/i.test(String(t))) || rdfTypesArr[0];

        try {
          const tdPrimary = computeTermDisplay(String(primaryCandidate), rdfManager as any);
          if (tdPrimary && tdPrimary.prefixed && String(tdPrimary.prefixed).trim() !== "") {
            badgeText = tdPrimary.prefixed;
          } else if (tdPrimary && tdPrimary.short) {
            badgeText = tdPrimary.short;
          }
        } catch (_) {
          // fall through to best-effort below
        }

        // Order typesList to show the preferred candidate first, then the rest.
        const ordered = [primaryCandidate, ...rdfTypesArr.filter((t) => t !== primaryCandidate)];
        typesList = ordered.map((t) => {
          try {
            const td = computeTermDisplay(String(t), rdfManager as any);
            return td.prefixed || td.short || String(t);
          } catch (_) {
            return String(t);
          }
        }).filter(Boolean);
      } catch (_) {
        // fall through to best-effort below
      }
    } else {
      // No expanded rdfTypes available -> conservative candidate handling
      const candidates: string[] = [
        ...(nodeData.displayType ? [String(nodeData.displayType)] : []),
        ...(nodeData.classType ? [String(nodeData.classType)] : []),
        ...((nodeData as any)?.types ? (nodeData as any).types.map(String) : []),
      ].filter(Boolean);

      const chosenType = candidates.find(t => t && !/NamedIndividual\b/i.test(String(t)));

      if (chosenType && rdfManager) {
        try {
          const td = computeTermDisplay(String(chosenType), rdfManager as any);
          if (td && td.prefixed && String(td.prefixed).trim() !== "" && String(td.prefixed).includes(':')) {
            badgeText = td.prefixed;
          } else if (td && td.short) {
            badgeText = td.short;
          }
        } catch (_) {
          // fallback to generic helper
          try {
            const bt = computeBadgeText(nodeData as any, rdfManager as any, availableClasses as any);
            if (bt && String(bt).trim() !== "") badgeText = String(bt);
          } catch (_) { /* ignore */ }
        }
      } else {
        // last-resort: use existing helper which applies minimal heuristics for display
        try {
          const bt = computeBadgeText(nodeData as any, rdfManager as any, availableClasses as any);
          if (bt && String(bt).trim() !== "") badgeText = String(bt);
        } catch (_) { /* ignore */ }
      }

      // Build typesList conservatively from candidates
      typesList = candidates.map((t: any) => {
        try {
          if (rdfManager) {
            const td = computeTermDisplay(String(t), rdfManager as any);
            return td.prefixed || td.short || String(t);
          }
        } catch (_) { /* ignore per-item */ }
        return String(t);
      }).filter(Boolean);

      // If rdfTypes were present but ignored earlier, still try to render them
      if (Array.isArray(nodeData.rdfTypes) && nodeData.rdfTypes.length > 0) {
        typesList = typesList.concat(
          nodeData.rdfTypes.map((t: any) => {
            try {
              if (rdfManager) {
                const td = computeTermDisplay(String(t), rdfManager as any);
                return td.prefixed || td.short || String(t);
              }
            } catch (_) { /* ignore */ }
            return String(t);
          })
        ).filter(Boolean);
      }
    }
  } catch (_) {
    // ignore overall failure
  }

  const namespace = String(nodeData.namespace ?? '');

  // Color/palette resolution
  const nodePaletteColor = (nodeData as any).paletteColor as string | undefined;
  let badgeTextColor: string | undefined = undefined;
  let paletteMissing = false;

  try {
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
        if (td && td.color) badgeTextColor = td.color;
      } catch (_) {
        badgeTextColor = undefined;
      }
    }
  } catch (_) { /* ignore */ }

  const effectiveColor = nodePaletteColor || badgeTextColor;
  if (!effectiveColor) {
    paletteMissing = true;
    try {
      console.error('[VG] palette missing for node', {
        iri: nodeData.iri,
        displayType: nodeData.displayType,
        classType: nodeData.classType,
      });
    } catch (_) { /* ignore */ }
  }

  const badgeColor = effectiveColor || '#FF4D4F';
  const leftColor = (nodeData as any).paletteColor as string | undefined || effectiveColor || '#FF4D4F';

  const themeBg = (typeof document !== 'undefined')
    ? (getComputedStyle(document.documentElement).getPropertyValue('--node-bg') || '').trim() || '#ffffff'
    : '#ffffff';
  const hasErrors = Array.isArray(nodeData.errors) && nodeData.errors.length > 0;

  const annotations: Array<{ term: string; value: string }> = [];
  if (Array.isArray(nodeData.annotationProperties) && nodeData.annotationProperties.length > 0) {
    nodeData.annotationProperties.forEach((ap) => {
      const propertyIri = String(
        (ap && (ap as any).propertyUri) ||
          (ap && (ap as any).property) ||
          (ap && (ap as any).term) ||
          (ap && (ap as any).key) ||
          '',
      );
      const rawValue = (ap && (ap as any).value);
      if (!propertyIri) return;
      if (rawValue === undefined || rawValue === null) return;
      const valueStr = String(rawValue);
      if (valueStr.trim() === '') return;
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

  const typePresentButNotLoaded = !nodeData.classType && Array.isArray(nodeData.rdfTypes) && nodeData.rdfTypes.some((t) => Boolean(t) && !/NamedIndividual/i.test(String(t)));

  useEffect(() => {
    setIndividualName(individualNameInitial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeData.iri, nodeData.individualName]);

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
    report(el.offsetWidth, el.offsetHeight);
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
      const onWin = () => report(el.offsetWidth, el.offsetHeight);
      window.addEventListener('resize', onWin);
      return () => {
        window.removeEventListener('resize', onWin);
      };
    }
    return () => {
      try { if (ro) ro.disconnect(); } catch (_) { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootRef]);

  useEffect(() => {
    try {
      const el = rootRef.current;
      if (!el) return;
      const wrapper: HTMLElement | null =
        typeof el.closest === "function" ? (el as any).closest(".react-flow__node") : (el.parentElement || null);
      if (!wrapper || !wrapper.style) return;
      const colorToApply = badgeColor || leftColor;
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

  // Use the node id (IRI) directly as the handle id per project convention.
  const handleId = String(id || '');

  // Connection helpers removed — canvas now relies on React Flow native handle drag.
  // Click-to-connect bridge (vg:start-connection / vg:end-connection) was removed to
  // simplify behavior and rely on React Flow's built-in connection lifecycle.

  // When the user interacts with the node, use pointer events for more reliable behavior.
  // onPointerDown starts a pending connection; onPointerUp ends it (if pending). We stop propagation
  // so inner interactive elements don't swallow the gesture. Also emit lightweight debug logs.
  return (
    <div
      ref={rootRef}
      className={cn('inline-flex overflow-hidden', selected ? 'ring-2 ring-primary' : '', paletteMissing ? 'ring-2 ring-destructive' : '')}
    >
      <div className="px-4 py-3 min-w-0 flex-1 w-auto" style={{ background: themeBg }}>
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

        <div className="text-sm text-muted-foreground mb-3">
          {typesList && typesList.length > 0 && (
            <div className="text-xs text-muted-foreground mt-1 truncate">
              {typesList.join(', ')}
            </div>
          )}
        </div>

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

        {typePresentButNotLoaded && (
          <div className="mt-2 text-xs text-muted-foreground">
            Type present but ontology not loaded
          </div>
        )}
      </div>

        {/* Match example: render source on the Right and target on the Left, with the same conditional logic.
            This mirrors the provided example so native handle-drag shows the live connection correctly. */}
          <Handle
            id={handleId}
            type="source"
            position={Position.Right}
            className="!bg-transparent !border-0"
            isConnectable={true}
          />
        {(!((connection as any)?.inProgress) || isTarget) && (
          <Handle
            id={handleId}
            type="target"
            position={Position.Left}
            className="!bg-transparent !border-0"
            isConnectable={true}
          />
        )}
    </div>
  );
}

/**
 * Small color utility to darken a hex color by a factor (0-1).
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
