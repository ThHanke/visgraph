import React from 'react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import {
  Plus,
  Eye,
  EyeOff,
  Network,
  Layout,
} from 'lucide-react';
import { ReasoningIndicator } from './ReasoningIndicator';
import type { ReasoningResult } from '../../utils/rdfManager';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { Slider } from '../ui/slider';
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { toast } from 'sonner';
import { useAppConfigStore } from '../../stores/appConfigStore';
import { useShallow } from 'zustand/react/shallow';
import { LayoutManager } from './LayoutManager';
import { useOntologyStore } from '../../stores/ontologyStore';

interface TopBarProps {
  onAddNode: () => void;
  onToggleLegend: () => void;
  showLegend: boolean;
  viewMode: 'abox' | 'tbox';
  onViewModeChange: (mode: 'abox' | 'tbox') => void;
  ontologyCount: number;
  ontologyBadgeContent?: React.ReactNode;
  onLayoutChange?: (layoutType: string, force?: boolean, options?: { nodeSpacing?: number }) => void;
  currentLayout?: string;
  layoutEnabled?: boolean;
  onToggleLayoutEnabled?: (enabled: boolean) => void;
  // Reasoning indicator props
  onOpenReasoningReport?: () => void;
  onRunReason?: () => void;
  currentReasoning?: ReasoningResult | null;
  isReasoning?: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({
  onAddNode,
  onToggleLegend,
  showLegend,
  viewMode,
  onViewModeChange,
  ontologyCount,
  ontologyBadgeContent,
  onLayoutChange,
  currentLayout = 'horizontal',
  layoutEnabled = false,
  onToggleLayoutEnabled,
  onOpenReasoningReport,
  onRunReason,
  currentReasoning = null,
  isReasoning = false,
}) => {
  const { config, setLayoutSpacing } = useAppConfigStore(
    useShallow((state) => ({
      config: state.config,
      setLayoutSpacing: state.setLayoutSpacing,
    })),
  );

  const loadedOntologies = useOntologyStore((s) => s.loadedOntologies ?? []);
  const removeLoadedOntology = useOntologyStore((s) => s.removeLoadedOntology);

  const [tempLayoutSpacing, setTempLayoutSpacing] = React.useState<number>(
    config.layoutSpacing ?? 120
  );

  React.useEffect(() => {
    setTempLayoutSpacing(config.layoutSpacing ?? 120);
  }, [config.layoutSpacing]);

  const layoutManager = new LayoutManager();
  const layoutOptions = layoutManager.getAvailableLayouts();

  const getLayoutIcon = (iconName?: string) => {
    const icons: Record<string, any> = {
      GitBranch: Layout,
      TreePine: Layout,
      Circle: Layout,
      Grid3X3: Layout,
      Layers: Layout,
      TreeDeciduous: Layout,
    };
    return icons[iconName || ''] || Layout;
  };

  return (
    <TooltipPrimitive.Provider delayDuration={0} skipDelayDuration={0}>
      <div className="absolute top-2 left-4 right-4 z-10 flex items-center backdrop-blur-md border border-border/20 rounded-lg overflow-hidden">
        {/* Primary Action Button - Add Node */}
        <TooltipPrimitive.Root>
          <TooltipPrimitive.Trigger asChild>
            <Button variant="default" size="sm" onClick={onAddNode} className="rounded-none h-9 border-r">
              <Plus className="h-4 w-4 mr-1" />
              <span className="hidden sm:inline text-sm">Add Node</span>
            </Button>
          </TooltipPrimitive.Trigger>
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
              className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
              sideOffset={5}
            >
              Add a new node to the canvas
              <TooltipPrimitive.Arrow className="fill-popover" />
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>

        {/* Toggle Buttons - A-Box/T-Box */}
        <TooltipPrimitive.Root>
          <TooltipPrimitive.Trigger asChild>
            <Button
              variant={viewMode === 'abox' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => onViewModeChange('abox')}
              className="rounded-none h-9 border-r"
            >
              A-Box
            </Button>
          </TooltipPrimitive.Trigger>
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
              className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
              sideOffset={5}
            >
              View instance data (individuals)
              <TooltipPrimitive.Arrow className="fill-popover" />
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>
        <TooltipPrimitive.Root>
          <TooltipPrimitive.Trigger asChild>
            <Button
              variant={viewMode === 'tbox' ? 'default' : 'ghost'}
              size="sm"
              onClick={() => onViewModeChange('tbox')}
              className="rounded-none h-9 border-r"
            >
              T-Box
            </Button>
          </TooltipPrimitive.Trigger>
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
              className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
              sideOffset={5}
            >
              View ontology schema (classes & properties)
              <TooltipPrimitive.Arrow className="fill-popover" />
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Secondary Buttons with Icons */}
        <TooltipPrimitive.Root>
          <TooltipPrimitive.Trigger asChild>
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggleLegend}
              className="rounded-none h-9 border-l"
            >
              {showLegend ? <EyeOff className="h-4 w-4 mr-1" /> : <Eye className="h-4 w-4 mr-1" />}
              <span className="hidden md:inline text-sm">Legend</span>
            </Button>
          </TooltipPrimitive.Trigger>
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
              className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
              sideOffset={5}
            >
              {showLegend ? 'Hide' : 'Show'} namespace legend
              <TooltipPrimitive.Arrow className="fill-popover" />
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>

        {/* Ontology Count Popover Button */}
        {ontologyBadgeContent || (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="rounded-none h-9 border-l"
              >
                <Network className="h-4 w-4 mr-1" />
                <span className="text-sm">
                  {ontologyCount} {ontologyCount === 1 ? 'ontology' : 'ontologies'}
                  {config?.persistedAutoload && ` (${loadedOntologies.length} configured)`}
                </span>
              </Button>
            </PopoverTrigger>
          <PopoverContent align="end" className="w-96 p-3">
            <div className="space-y-2">
              <h4 className="font-medium text-sm">Loaded ontologies and auto-load status</h4>
              {loadedOntologies.length > 0 ? (
                <div className="space-y-2">
                  {loadedOntologies.map((ont: any, idx: number) => (
                    <div key={idx} className="border-b pb-2 last:border-0">
                      <div className="flex justify-between items-start gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm">{ont?.name || 'Unknown'}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {ont?.uri || ont?.url || 'No URI'}
                          </div>
                          <div className="text-xs text-green-600 mt-1">Loaded</div>
                        </div>
                        {config?.persistedAutoload && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 text-xs shrink-0"
                            onClick={() => {
                              const ontologyUrl = ont?.url || ont?.uri;
                              if (ontologyUrl) {
                                removeLoadedOntology(ontologyUrl);
                                toast.success(`Removed ${ont?.name || 'ontology'} from autoload`);
                              } else {
                                toast.error('Could not remove ontology: URL not found');
                              }
                            }}
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No ontologies loaded</p>
              )}
            </div>
            </PopoverContent>
          </Popover>
        )}

        {/* Layout Popover Button */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-none h-9 border-l"
            >
              <Layout className="h-4 w-4 mr-1" />
              <span className="hidden md:inline text-sm">Layout</span>
            </Button>
          </PopoverTrigger>

        <PopoverContent
          align="end"
          sideOffset={8}
          className="w-96 max-h-[80vh] overflow-y-auto rounded-lg border bg-popover p-3 shadow-lg"
        >
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-sm font-medium">Layouts</div>
          </div>

          <div className="space-y-0.5">
            {layoutOptions.map((layout) => {
              const IconComponent = getLayoutIcon(layout.icon as any);
              return (
                <button
                  key={layout.type}
                  onClick={() => {
                    onLayoutChange?.(layout.type, true, {
                      nodeSpacing: config.layoutSpacing,
                    });
                    toast.success(`Applied ${layout.label} layout`);
                  }}
                  className="w-full flex items-start gap-3 p-2 rounded hover:bg-accent/10 text-left"
                >
                  <IconComponent className="h-5 w-5 mt-0.5 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm">{layout.label}</div>
                    <div className="text-xs text-muted-foreground">
                      {layout.description}
                    </div>
                  </div>
                  {currentLayout === layout.type && (
                    <Badge variant="secondary" className="text-xs">
                      Active
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>

          <div className="space-y-3 mb-2 pt-2">
            <div className="text-sm font-medium">Spacing</div>
            <div
              className="flex items-center gap-2 px-2 py-1 bg-card/80 border border-border rounded-md"
              onPointerUp={() => {
                const v = tempLayoutSpacing;
                setLayoutSpacing(v);
                onLayoutChange?.(currentLayout || 'horizontal', true, {
                  nodeSpacing: v,
                });
                toast.success(`Saved spacing: ${v}px`);
              }}
            >
              <div className="text-xs text-muted-foreground">Spacing</div>
              <div className="w-56">
                <Slider
                  value={[tempLayoutSpacing]}
                  onValueChange={([v]) => {
                    setTempLayoutSpacing(v);
                    useAppConfigStore.getState().setLayoutSpacing(v);
                    onLayoutChange?.(currentLayout || 'horizontal', true, {
                      nodeSpacing: v,
                    });
                  }}
                  min={50}
                  max={500}
                  step={10}
                  className="w-full"
                />
              </div>
              <div className="text-xs font-medium">{tempLayoutSpacing}px</div>
            </div>
          </div>

          <div className="mt-3 pt-2 border-t flex gap-2 items-center">
            <div className="flex-1">
              <div className="text-sm font-medium mb-1">Auto layout</div>
              <div className="text-xs text-muted-foreground">
                Enable programmatic layout application
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                className="px-3 py-1 rounded text-sm bg-muted hover:bg-muted/80"
                onClick={() => {
                  const v = tempLayoutSpacing;
                  useAppConfigStore.getState().setLayoutSpacing(v);
                  onLayoutChange?.(currentLayout || 'horizontal', true, {
                    nodeSpacing: v,
                  });
                }}
              >
                Apply
              </button>

              <button
                type="button"
                className="px-3 py-1 rounded text-sm bg-muted hover:bg-muted/80"
                onClick={() => {
                  useAppConfigStore.getState().setLayoutSpacing(120);
                  setTempLayoutSpacing(120);
                  onLayoutChange?.(currentLayout || 'horizontal', true, {
                    nodeSpacing: 120,
                  });
                  toast.success('Reset spacing to 120px');
                }}
              >
                Reset
              </button>

              <button
                type="button"
                onClick={() => {
                  const enabled = !layoutEnabled;
                  onToggleLayoutEnabled?.(enabled);
                  toast.success(enabled ? 'Layout toggled ON' : 'Layout toggled OFF');
                }}
                className={
                  layoutEnabled
                    ? 'px-3 py-1 rounded text-sm border bg-primary text-white'
                    : 'px-3 py-1 rounded text-sm border bg-card'
                }
                aria-pressed={layoutEnabled}
              >
                Auto
              </button>
            </div>
          </div>
        </PopoverContent>
        </Popover>

        {/* Reasoning Buttons - Status and Run */}
        {onOpenReasoningReport && onRunReason && (
          <>
            {/* Reasoning Status Button */}
            <TooltipPrimitive.Root>
              <TooltipPrimitive.Trigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onOpenReasoningReport}
                  className="rounded-none h-9 border-l"
                >
            {isReasoning ? (
              <>
                <div className="w-4 h-4 border-2 border-t-2 border-t-primary rounded-full animate-spin mr-2" />
                <span className="font-medium">Reasoning...</span>
              </>
            ) : currentReasoning ? (
              currentReasoning.errors && currentReasoning.errors.length > 0 ? (
                <>
                  <svg className="w-4 h-4 mr-2 text-destructive" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span className="font-medium">{currentReasoning.errors.length} Error{currentReasoning.errors.length !== 1 ? 's' : ''}</span>
                </>
              ) : currentReasoning.warnings && currentReasoning.warnings.length > 0 ? (
                <>
                  <svg className="w-4 h-4 mr-2 text-warning" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <span className="font-medium">{currentReasoning.warnings.length} Warning{currentReasoning.warnings.length !== 1 ? 's' : ''}</span>
                </>
              ) : (
                <>
                  <svg className="w-4 h-4 mr-2 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className="font-medium">Valid</span>
                  {currentReasoning.duration && (
                    <span className="ml-2 text-xs text-muted-foreground">{currentReasoning.duration}ms</span>
                  )}
                </>
              )
            ) : (
              <>
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                </svg>
                <span className="font-medium">Ready</span>
                  </>
                )}
              </Button>
            </TooltipPrimitive.Trigger>
            <TooltipPrimitive.Portal>
              <TooltipPrimitive.Content
                className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
                sideOffset={5}
              >
                View reasoning results and validation report
                <TooltipPrimitive.Arrow className="fill-popover" />
              </TooltipPrimitive.Content>
            </TooltipPrimitive.Portal>
          </TooltipPrimitive.Root>

            {/* Run Reasoning Button - Icon Only */}
            <TooltipPrimitive.Root>
              <TooltipPrimitive.Trigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    try {
                      if (typeof onRunReason === 'function') onRunReason();
                    } catch (e) {
                      console.warn('Failed to invoke run reasoning', e);
                    }
                  }}
                  className="rounded-none h-9 w-9 p-0 border-l"
                  aria-label="Run reasoning"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </Button>
              </TooltipPrimitive.Trigger>
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content
                  className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
                  sideOffset={5}
                >
                  Run reasoning and validation
                  <TooltipPrimitive.Arrow className="fill-popover" />
                </TooltipPrimitive.Content>
              </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
          </>
        )}
      </div>
    </TooltipPrimitive.Provider>
  );
};
