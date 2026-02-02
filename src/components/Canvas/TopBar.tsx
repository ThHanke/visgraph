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
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { Slider } from '../ui/slider';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
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
    <div className="absolute top-2 left-4 right-4 z-10 flex items-center gap-1 backdrop-blur-md border border-border/20 px-0 py-0 rounded-lg">
      {/* Add Node */}
      <Button variant="default" size="sm" onClick={onAddNode} className="rounded-l-lg rounded-r-none">
        <Plus className="h-4 w-4 mr-1" />
        <span className="hidden sm:inline text-sm">Add Node</span>
      </Button>

      {/* A-Box/T-Box toggle */}
      <div className="flex items-center border-x">
        <Button
          variant={viewMode === 'abox' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onViewModeChange('abox')}
          className="rounded-none"
        >
          A-Box
        </Button>
        <Button
          variant={viewMode === 'tbox' ? 'default' : 'ghost'}
          size="sm"
          onClick={() => onViewModeChange('tbox')}
          className="rounded-none"
        >
          T-Box
        </Button>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Legend Toggle */}
      <Button
        variant="secondary"
        size="sm"
        onClick={onToggleLegend}
        className="rounded-none border-x"
      >
        {showLegend ? <EyeOff className="h-4 w-4 mr-1" /> : <Eye className="h-4 w-4 mr-1" />}
        <span className="hidden md:inline text-sm">Legend</span>
      </Button>

      {/* Ontology Count Badge/Popover */}
      {ontologyBadgeContent || (
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="rounded-none border-x gap-1"
            >
              <Network className="h-4 w-4" />
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

      {/* Layout Popover */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="rounded-r-lg rounded-l-none border-l gap-1"
          >
            <Layout className="h-4 w-4" />
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
    </div>
  );
};
