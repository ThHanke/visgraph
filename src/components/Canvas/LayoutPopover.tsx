import React from 'react';
import { Layout } from 'lucide-react';
import { Slider } from '../ui/slider';
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover';
import { toast } from 'sonner';
import { useAppConfigStore } from '../../stores/appConfigStore';
import { useShallow } from 'zustand/react/shallow';

const LAYOUT_OPTIONS = [
  { type: 'horizontal',       label: 'Horizontal',       description: 'Left-to-right (Dagre)' },
  { type: 'vertical',         label: 'Vertical',         description: 'Top-to-bottom (Dagre)' },
  { type: 'elk-layered',      label: 'Layered',          description: 'Hierarchy (ELK)' },
  { type: 'elk-force',        label: 'Force',            description: 'Force-directed (ELK)' },
  { type: 'elk-stress',       label: 'Stress',           description: 'Dense graphs (ELK)' },
  { type: 'reactodia-default',label: 'Default',          description: 'Cola with overlap removal' },
];

interface LayoutPopoverProps {
  onApplyLayout: () => void;
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
    onApplyLayout();
    toast.success(`Layout: ${LAYOUT_OPTIONS.find(l => l.type === type)?.label ?? type}`);
  };

  const handleApply = () => {
    setLayoutSpacing(tempSpacing);
    onApplyLayout();
  };

  const handleReset = () => {
    setLayoutSpacing(120);
    setTempSpacing(120);
    onApplyLayout();
    toast.success('Spacing reset to 120px');
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="reactodia-btn reactodia-btn-default glass-btn" title="Layout settings">
          <Layout style={{ width: 14, height: 14 }} />
          <span>Layout</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="glass p-0 rounded-xl"
        style={{ width: 260, border: 'none' }}
      >
        {/* Algorithm list */}
        <div className="px-3 pt-2.5 pb-1">
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.5, marginBottom: 4 }}>
            Algorithm
          </div>
          {LAYOUT_OPTIONS.map((layout) => {
            const active = config.currentLayout === layout.type;
            return (
              <button
                key={layout.type}
                onClick={() => handleSelectLayout(layout.type)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: '5px 6px',
                  borderRadius: 6,
                  border: 'none',
                  background: active ? 'rgba(124, 92, 228, 0.12)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
                className={active ? 'glass-btn--active' : ''}
              >
                <Layout style={{ width: 13, height: 13, flexShrink: 0, opacity: 0.6 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: active ? 600 : 400, color: 'var(--foreground)' }}>
                    {layout.label}
                  </div>
                  <div style={{ fontSize: 11, opacity: 0.5 }}>{layout.description}</div>
                </div>
                {active && (
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--primary)', flexShrink: 0 }} />
                )}
              </button>
            );
          })}
        </div>

        {/* Spacing */}
        <div style={{ borderTop: '1px solid var(--glass-border-color)' }} className="px-3 py-2">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.5, whiteSpace: 'nowrap' }}>
              Spacing
            </div>
            <div
              style={{ flex: 1 }}
              onPointerUp={() => {
                setLayoutSpacing(tempSpacing);
                if (config.autoApplyLayout) onApplyLayout();
              }}
            >
              <Slider
                value={[tempSpacing]}
                onValueChange={([v]) => setTempSpacing(v)}
                min={50}
                max={500}
                step={10}
              />
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.7, width: 36, textAlign: 'right' }}>
              {tempSpacing}
            </div>
          </div>
        </div>

        {/* Footer actions */}
        <div
          style={{ borderTop: '1px solid var(--glass-border-color)', display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px' }}
        >
          <button
            className={`glass-btn${config.autoApplyLayout ? ' glass-btn--active' : ''}`}
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => {
              const next = !config.autoApplyLayout;
              setAutoApplyLayout(next);
              toast.success(next ? 'Auto layout on' : 'Auto layout off');
            }}
            aria-pressed={config.autoApplyLayout}
          >
            Auto
          </button>
          <div style={{ flex: 1 }} />
          <button
            className="glass-btn"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={handleReset}
          >
            Reset
          </button>
          <button
            className="glass-btn glass-btn--active"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={handleApply}
          >
            Apply
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
