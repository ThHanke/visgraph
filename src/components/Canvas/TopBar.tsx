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
  currentReasoning?: ReasoningResult | null;
  isReasoning?: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({
  viewMode,
  onViewModeChange,
  ontologyCount,
  onOpenReasoningReport,
  onRunReason,
  currentReasoning = null,
  isReasoning = false,
}) => {
  const config = useAppConfigStore((s) => s.config);
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
    }}>
      <div className="reactodia-btn-group reactodia-btn-group-sm">
        {/* A-Box / T-Box toggle */}
        <button
          type="button"
          className={`reactodia-btn ${viewMode === 'abox' ? 'reactodia-btn-primary' : 'reactodia-btn-default'}`}
          onClick={() => onViewModeChange('abox')}
          title="View instance data (A-Box)"
        >
          A-Box
        </button>
        <button
          type="button"
          className={`reactodia-btn ${viewMode === 'tbox' ? 'reactodia-btn-primary' : 'reactodia-btn-default'}`}
          onClick={() => onViewModeChange('tbox')}
          title="View ontology schema (T-Box)"
        >
          T-Box
        </button>

        {/* Ontology count */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="reactodia-btn reactodia-btn-default"
              title="Loaded ontologies"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
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
                                className="reactodia-btn reactodia-btn-default reactodia-btn-sm"
                                onClick={() => {
                                  removeAdditionalOntology(ontologyUrl);
                                  toast.success(`Removed ${ont?.name || 'ontology'} from autoload`);
                                }}
                              >
                                Remove from autoload
                              </button>
                            ) : (
                              <button
                                className="reactodia-btn reactodia-btn-default reactodia-btn-sm"
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
                              className="reactodia-btn reactodia-btn-default reactodia-btn-sm"
                              style={{ color: 'var(--reactodia-error-color, #d00)' }}
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

        {/* Reasoning */}
        {onOpenReasoningReport && onRunReason && (
          <>
            <button
              type="button"
              className="reactodia-btn reactodia-btn-default"
              onClick={onOpenReasoningReport}
              title="View reasoning results"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
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
                  <span style={{ color: '#e55' }}>
                    ⚠ {currentReasoning.errors.length} Error{currentReasoning.errors.length !== 1 ? 's' : ''}
                  </span>
                ) : currentReasoning.warnings?.length ? (
                  <span style={{ color: '#ea0' }}>
                    ⚠ {currentReasoning.warnings.length} Warning{currentReasoning.warnings.length !== 1 ? 's' : ''}
                  </span>
                ) : (
                  <span style={{ color: '#4a4' }}>✓ Valid</span>
                )
              ) : (
                'Ready'
              )}
            </button>
            <button
              type="button"
              className="reactodia-btn reactodia-btn-default"
              onClick={onRunReason}
              title="Run reasoning"
            >
              ▶
            </button>
          </>
        )}
      </div>
    </div>
  );
};
