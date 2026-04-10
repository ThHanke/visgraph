import React from 'react';
import type { ReasoningResult } from '../../utils/rdfManager';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { toast } from 'sonner';
import { useAppConfigStore } from '../../stores/appConfigStore';
import { useOntologyStore } from '../../stores/ontologyStore';

interface TopBarProps {
  viewMode: 'abox' | 'tbox';
  onViewModeChange: (mode: 'abox' | 'tbox') => void;
  ontologyCount: number;
  onOpenReasoningReport?: () => void;
  onRunReason?: () => void;
  onClearInferred?: () => void;
  currentReasoning?: ReasoningResult | null;
  isReasoning?: boolean;
  isClustered?: boolean;
  onCluster?: () => void;
  onExpandAll?: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  viewMode,
  onViewModeChange,
  ontologyCount,
  onOpenReasoningReport,
  onRunReason,
  onClearInferred,
  currentReasoning = null,
  isReasoning = false,
  isClustered = false,
  onCluster,
  onExpandAll,
}) => {
  const config = useAppConfigStore((s) => s.config);
  const clusteringAlgorithm = useAppConfigStore(s => s.config.clusteringAlgorithm);
  const setClusteringAlgorithm = useAppConfigStore(s => s.setClusteringAlgorithm);
  const loadedOntologies = useOntologyStore((s) => s.loadedOntologies ?? []);
  const removeLoadedOntology = useOntologyStore((s) => s.removeLoadedOntology);
  const addAdditionalOntology = useAppConfigStore((s) => s.addAdditionalOntology);
  const removeAdditionalOntology = useAppConfigStore((s) => s.removeAdditionalOntology);
  const additionalOntologies = useAppConfigStore((s) => s.config.additionalOntologies ?? []);

  const normalizeOntUrl = (u: string) => {
    try { return new URL(u.trim()).toString().replace(/[/#]+$/, '').replace(/^http:\/\//i, 'https://'); }
    catch { return u.trim().replace(/[/#]+$/, '').replace(/^http:\/\//i, 'https://'); }
  };

  return (
    <div className="reactodia-toolbar" role="toolbar" style={{
      display: 'flex',
      whiteSpace: 'nowrap',
      gap: '4px',
    }}>
      {/* Clustering controls */}
      <div className="reactodia-btn-group reactodia-btn-group-sm">
        <select
          className="reactodia-btn reactodia-btn-default glass-btn"
          style={{ appearance: 'none', WebkitAppearance: 'none', fontSize: 12, lineHeight: 1.5, padding: '5px 24px 5px 10px', cursor: 'pointer', boxSizing: 'border-box', borderRadius: 'unset', borderTopLeftRadius: 'var(--reactodia-button-border-radius)', borderBottomLeftRadius: 'var(--reactodia-button-border-radius)' }}
          value={clusteringAlgorithm}
          title="Clustering algorithm"
          onChange={e => setClusteringAlgorithm(e.target.value as any)}
        >
          <option value="none">No clustering</option>
          <option value="label-propagation">Label Propagation</option>
          <option value="louvain">Louvain</option>
          <option value="kmeans">K-Means</option>
        </select>
        <button
          type="button"
          className={`reactodia-btn reactodia-btn-default glass-btn${isClustered ? ' glass-btn--active' : ''}`}
          style={{ borderRadius: 'unset' }}
          title={isClustered ? 'Already clustered — expand first to re-cluster' : 'Cluster visible nodes'}
          disabled={clusteringAlgorithm === 'none' || isClustered || !onCluster}
          onClick={onCluster}
        >
          Cluster
        </button>
        <button
          type="button"
          className="reactodia-btn reactodia-btn-default glass-btn"
          title={isClustered ? 'Expand all groups' : 'No groups to expand'}
          disabled={!isClustered || !onExpandAll}
          onClick={onExpandAll}
        >
          Expand All
        </button>
      </div>

      {/* A-Box / T-Box group */}
      <div className="reactodia-btn-group reactodia-btn-group-sm">
        <button
          type="button"
          className={`reactodia-btn reactodia-btn-default glass-btn ${viewMode === 'abox' ? 'glass-btn--active' : ''}`}
          onClick={() => onViewModeChange('abox')}
          title="View instance data (A-Box)"
        >
          A-Box
        </button>
        <button
          type="button"
          className={`reactodia-btn reactodia-btn-default glass-btn ${viewMode === 'tbox' ? 'glass-btn--active' : ''}`}
          onClick={() => onViewModeChange('tbox')}
          title="View ontology schema (T-Box)"
        >
          T-Box
        </button>
      </div>

        {/* Ontology count */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="reactodia-btn reactodia-btn-default glass-btn"
              title="Loaded ontologies"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                <circle cx="12" cy="5" r="3"/><line x1="12" y1="8" x2="12" y2="16"/>
                <circle cx="5" cy="19" r="3"/><line x1="12" y1="16" x2="5" y2="16"/>
                <circle cx="19" cy="19" r="3"/><line x1="12" y1="16" x2="19" y2="16"/>
              </svg>
              {ontologyCount}
            </button>
          </PopoverTrigger>
        <PopoverContent align="end" className="w-96 p-3" style={{ zIndex: 100 }}>
          <div className="space-y-2">
            <h4 className="font-medium text-sm">Loaded ontologies</h4>
            {loadedOntologies.length > 0 ? (
              <div className="space-y-2">
                {loadedOntologies.map((ont: any, idx: number) => {
                  const ontologyUrl = ont?.url || ont?.uri;
                  const normUrl = ontologyUrl ? normalizeOntUrl(ontologyUrl) : '';
                  const inAutoloadConfig = normUrl && additionalOntologies.some(
                    (u) => normalizeOntUrl(u) === normUrl
                  );
                  const isAutoSource = ont?.source === 'fetched' || ont?.source === 'auto';
                  const isAutoloaded = !!(inAutoloadConfig || isAutoSource);
                  const isCore = ont?.source === 'auto';
                  return (
                    <div key={idx} className="border-b pb-2 last:border-0">
                      <div className="flex justify-between items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm">{ont?.name || 'Unknown'}</div>
                          <div className="text-xs text-muted-foreground truncate">{ontologyUrl || 'No URI'}</div>
                          <div className="text-xs mt-1 flex items-center gap-1">
                            <span className="text-green-600">Loaded</span>
                            {isAutoloaded && <span className="text-muted-foreground">· autoload</span>}
                            {isCore && <span className="text-muted-foreground">· core</span>}
                          </div>
                        </div>
                        <div className="flex gap-1 shrink-0">
                          {!isCore && ontologyUrl && (
                            isAutoloaded ? (
                              <button
                                className="glass-btn"
                                style={{ fontSize: 12, padding: '3px 8px' }}
                                onClick={() => {
                                  removeAdditionalOntology(ontologyUrl);
                                  toast.success(`Removed ${ont?.name || 'ontology'} from autoload`);
                                }}
                              >
                                Remove from autoload
                              </button>
                            ) : (
                              <button
                                className="glass-btn"
                                style={{ fontSize: 12, padding: '3px 8px' }}
                                onClick={() => {
                                  addAdditionalOntology(ontologyUrl);
                                  toast.success(`Added ${ont?.name || 'ontology'} to autoload`);
                                }}
                              >
                                Add to autoload
                              </button>
                            )
                          )}
                          {config?.persistedAutoload && !isCore && (
                            <button
                              className="glass-btn glass-btn--status-error"
                              style={{ fontSize: 12, padding: '3px 8px' }}
                              onClick={() => {
                                if (ontologyUrl) {
                                  removeLoadedOntology(ontologyUrl);
                                  toast.success(`Unloaded ${ont?.name || 'ontology'}`);
                                }
                              }}
                            >
                              Unload
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No ontologies loaded</p>
            )}
          </div>
        </PopoverContent>
      </Popover>

        {/* Reasoning group */}
        {onOpenReasoningReport && onRunReason && (
          <div className="reactodia-btn-group reactodia-btn-group-sm">
            <button
              type="button"
              className={`reactodia-btn reactodia-btn-default glass-btn ${
                isReasoning ? '' :
                currentReasoning?.errors?.length ? 'glass-btn--status-error' :
                currentReasoning?.warnings?.length ? 'glass-btn--status-warn' :
                currentReasoning ? 'glass-btn--status-ok' : ''
              }`}
              onClick={onOpenReasoningReport}
              title="View reasoning results"
            >
              {isReasoning ? (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}>
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" strokeDasharray="32" strokeLinecap="round" />
                  </svg>
                  Reasoning…
                </>
              ) : currentReasoning ? (
                currentReasoning.errors?.length ? (
                  <span>
                    ⚠ {currentReasoning.errors.length} Error{currentReasoning.errors.length !== 1 ? 's' : ''}
                  </span>
                ) : currentReasoning.warnings?.length ? (
                  <span>
                    ⚠ {currentReasoning.warnings.length} Warning{currentReasoning.warnings.length !== 1 ? 's' : ''}
                  </span>
                ) : (
                  <span>✓ Valid</span>
                )
              ) : (
                'Ready'
              )}
            </button>
            <button
              type="button"
              className="reactodia-btn reactodia-btn-default"
              onClick={onClearInferred}
              disabled={!currentReasoning || isReasoning}
              title="Clear inferred graph"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline', verticalAlign: 'middle' }}>
                <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
              </svg>
            </button>
            <button
              type="button"
              className="reactodia-btn reactodia-btn-default"
              onClick={onRunReason}
              title="Run reasoning"
            >
              ▶
            </button>
          </div>
        )}
    </div>
  );
};
