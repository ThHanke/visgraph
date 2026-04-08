import React from 'react';
import { Layout } from 'lucide-react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Slider } from '../ui/slider';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { toast } from 'sonner';
import { useAppConfigStore } from '../../stores/appConfigStore';
import { useShallow } from 'zustand/react/shallow';

const LAYOUT_OPTIONS = [
  { type: 'horizontal', label: 'Horizontal (Dagre)', description: 'Left-to-right layered layout using Dagre' },
  { type: 'vertical', label: 'Vertical (Dagre)', description: 'Top-to-bottom layered layout using Dagre' },
  { type: 'elk-layered', label: 'Layered (ELK)', description: 'Layered layout for directed graphs, good for hierarchies' },
  { type: 'elk-force', label: 'Force (ELK)', description: 'Force-directed layout, good for general graphs' },
  { type: 'elk-stress', label: 'Stress (ELK)', description: 'Stress minimisation, good for dense or large graphs' },
  { type: 'reactodia-default', label: 'Reactodia Default', description: 'Built-in cola-based layout with overlap removal' },
];

interface LayoutPopoverProps {
  onApplyLayout: (layoutType: string) => void;
}

export const LayoutPopover: React.FC<LayoutPopoverProps> = ({ onApplyLayout }) => {
  const { config, setCurrentLayout, setLayoutSpacing, setAutoApplyLayout } = useAppConfigStore(
    useShallow((s) => ({
      config: s.config,
      setCurrentLayout: s.setCurrentLayout,
      setLayoutSpacing: s.setLayoutSpacing,
      setAutoApplyLayout: s.setAutoApplyLayout,
    })),
  );

  const [tempSpacing, setTempSpacing] = React.useState<number>(config.layoutSpacing ?? 120);

  React.useEffect(() => {
    setTempSpacing(config.layoutSpacing ?? 120);
  }, [config.layoutSpacing]);

  const handleSelectLayout = (type: string) => {
    setCurrentLayout(type);
    onApplyLayout(type);
    toast.success(`Applied ${LAYOUT_OPTIONS.find(l => l.type === type)?.label ?? type} layout`);
  };

  const handleApply = () => {
    setLayoutSpacing(tempSpacing);
    onApplyLayout(config.currentLayout);
  };

  const handleReset = () => {
    setLayoutSpacing(120);
    setTempSpacing(120);
    onApplyLayout(config.currentLayout);
    toast.success('Reset spacing to 120px');
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="rounded-md h-9 border border-border/20">
          <Layout className="h-4 w-4 mr-1" />
          <span className="hidden md:inline text-sm">Layout</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-96 max-h-[80vh] overflow-y-auto rounded-lg border bg-popover p-3 shadow-lg"
      >
        <div className="text-sm font-medium mb-1.5">Layouts</div>

        <div className="space-y-0.5">
          {LAYOUT_OPTIONS.map((layout) => (
            <button
              key={layout.type}
              onClick={() => handleSelectLayout(layout.type)}
              className="w-full flex items-start gap-3 p-2 rounded hover:bg-accent/10 text-left"
            >
              <Layout className="h-5 w-5 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm">{layout.label}</div>
                <div className="text-xs text-muted-foreground">{layout.description}</div>
              </div>
              {config.currentLayout === layout.type && (
                <Badge variant="secondary" className="text-xs">Active</Badge>
              )}
            </button>
          ))}
        </div>

        <div className="space-y-2 pt-3">
          <div className="text-sm font-medium">Spacing</div>
          <div className="flex items-center gap-2 px-2 py-1 bg-card/80 border border-border rounded-md">
            <div className="text-xs text-muted-foreground">Spacing</div>
            <div className="flex-1">
              <Slider
                value={[tempSpacing]}
                onValueChange={([v]) => setTempSpacing(v)}
                min={50}
                max={500}
                step={10}
                className="w-full"
              />
            </div>
            <div className="text-xs font-medium w-12 text-right">{tempSpacing}px</div>
          </div>
        </div>

        <div className="mt-3 pt-2 border-t flex gap-2 items-center">
          <div className="flex-1">
            <div className="text-sm font-medium mb-0.5">Auto layout</div>
            <div className="text-xs text-muted-foreground">Apply layout when new elements are added</div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-1 rounded text-sm bg-muted hover:bg-muted/80"
              onClick={handleApply}
            >
              Apply
            </button>
            <button
              type="button"
              className="px-3 py-1 rounded text-sm bg-muted hover:bg-muted/80"
              onClick={handleReset}
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => {
                const next = !config.autoApplyLayout;
                setAutoApplyLayout(next);
                toast.success(next ? 'Auto layout on' : 'Auto layout off');
              }}
              className={config.autoApplyLayout
                ? 'px-3 py-1 rounded text-sm border bg-primary text-white'
                : 'px-3 py-1 rounded text-sm border bg-card'}
              aria-pressed={config.autoApplyLayout}
            >
              Auto
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
};
