/**
 * @fileoverview Layout Toolbar Component
 * Provides UI controls for applying different layouts to the knowledge graph
 */

import { useState } from 'react';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Slider } from '../ui/slider';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import {
  GitBranch,
  TreePine,
  Circle,
  Grid3X3,
  Layers,
  TreeDeciduous,
  Layout,
  Settings,
  Sparkles,
  RotateCcw,
  Loader2
} from 'lucide-react';
import { LayoutManager, LayoutType, LayoutOptions, LayoutConfig } from './LayoutManager';
import { toast } from 'sonner';

interface LayoutToolbarProps {
  layoutManager: LayoutManager | null;
  onLayoutChange?: (layoutType: LayoutType, options: LayoutOptions) => void;
  disabled?: boolean;
}

const getLayoutIcon = (iconName: string) => {
  const icons = {
    GitBranch,
    TreePine,
    Circle,
    Grid3X3,
    Layers,
    TreeDeciduous
  };
  const IconComponent = icons[iconName as keyof typeof icons] || Layout;
  return IconComponent;
};

export const LayoutToolbar = ({ layoutManager, onLayoutChange, disabled = false }: LayoutToolbarProps) => {
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [currentLayout, setCurrentLayout] = useState<LayoutType>('horizontal');
  const [layoutOptions, setLayoutOptions] = useState<LayoutOptions>({
    animationDuration: 500,
    animated: true,
    nodeSpacing: 120
  });

  const availableLayouts = layoutManager?.getAvailableLayouts() || [];

  const handleLayoutApply = async (layoutType: LayoutType, options?: LayoutOptions) => {
    if (!layoutManager || disabled) return;

    setIsApplying(true);
    try {
      const finalOptions = { ...layoutOptions, ...options };
      await layoutManager.applyLayout(layoutType, finalOptions);
      setCurrentLayout(layoutType);
      onLayoutChange?.(layoutType, finalOptions);
      
      toast.success(`Applied ${layoutType} layout successfully`, {
        description: `Graph reorganized with ${finalOptions.animated ? 'smooth' : 'instant'} transition`
      });
    } catch (error) {
      console.error('Layout application failed:', error);
      toast.error('Failed to apply layout', {
        description: error instanceof Error ? error.message : 'Unknown error occurred'
      });
    } finally {
      setIsApplying(false);
    }
  };

  const handleAutoLayout = async () => {
    if (!layoutManager || disabled) return;

    const suggested = layoutManager.suggestOptimalLayout();
    
    toast.info(`Applying suggested layout: ${suggested}`, {
      description: 'Based on your graph structure and size'
    });

    await handleLayoutApply(suggested);
  };

  const handleRestorePositions = () => {
    if (!layoutManager || disabled) return;
    
    layoutManager.restoreLastPositions();
    toast.success('Restored previous node positions');
  };

  const handleResetLayout = () => {
    if (!layoutManager || disabled) return;
    
    layoutManager.resetToOriginal();
    toast.success('Reset to original layout');
  };

  const updateLayoutOption = (key: keyof LayoutOptions, value: any) => {
    setLayoutOptions(prev => ({ ...prev, [key]: value }));
  };

  return (
    <div className="flex items-center gap-2">
      {/* Quick Layout Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button 
            variant="outline" 
            size="sm" 
            disabled={disabled || isApplying}
            className="shadow-glass backdrop-blur-sm"
          >
            {isApplying ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Layout className="h-4 w-4 mr-2" />
            )}
            Layout
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuLabel className="flex items-center gap-2">
            <Layout className="h-4 w-4" />
            Choose Layout
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          
          {availableLayouts.map((layout: LayoutConfig) => {
            const IconComponent = getLayoutIcon(layout.icon);
            return (
              <DropdownMenuItem
                key={layout.type}
                onClick={() => handleLayoutApply(layout.type)}
                className="flex items-start gap-3 p-3"
              >
                <IconComponent className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{layout.label}</span>
                    {currentLayout === layout.type && (
                      <Badge variant="secondary" className="text-xs">Active</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {layout.description}
                  </p>
                </div>
              </DropdownMenuItem>
            );
          })}
          
          <DropdownMenuSeparator />
          
          <DropdownMenuItem onClick={handleAutoLayout} className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" />
            Auto Select Layout
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Layout Settings Dialog */}
      <Dialog open={isSettingsOpen} onOpenChange={setIsSettingsOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" disabled={disabled} className="shadow-glass backdrop-blur-sm">
            <Settings className="h-4 w-4" />
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Layout Settings</DialogTitle>
            <DialogDescription>
              Customize how layouts are applied to your graph.
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-6">
            {/* Animation Settings */}
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label htmlFor="animated" className="text-sm font-medium">
                  Smooth Transitions
                </Label>
                <Switch
                  id="animated"
                  checked={layoutOptions.animated}
                  onCheckedChange={(checked) => updateLayoutOption('animated', checked)}
                />
              </div>
              
              {layoutOptions.animated && (
                <div className="space-y-2">
                  <Label className="text-sm">
                    Animation Duration: {layoutOptions.animationDuration}ms
                  </Label>
                  <Slider
                    value={[layoutOptions.animationDuration || 500]}
                    onValueChange={([value]) => updateLayoutOption('animationDuration', value)}
                    min={100}
                    max={2000}
                    step={100}
                    className="w-full"
                  />
                </div>
              )}
            </div>

            {/* Spacing Settings */}
            <div className="space-y-2">
              <Label className="text-sm">
                Node Spacing: {layoutOptions.nodeSpacing}px
              </Label>
              <Slider
                value={[layoutOptions.nodeSpacing || 120]}
                onValueChange={([value]) => updateLayoutOption('nodeSpacing', value)}
                min={50}
                max={300}
                step={10}
                className="w-full"
              />
            </div>

            {/* Current Layout Info */}
            {layoutManager && (
              <div className="space-y-2 p-3 bg-muted rounded-lg">
                <Label className="text-sm font-medium">Current Layout</Label>
                <div className="text-sm text-muted-foreground">
                  {(() => {
                    const info = layoutManager.getCurrentLayoutInfo();
                    return (
                      <div>
                        <div>Type: {info.type}</div>
                        {Object.entries(info.options).length > 0 && (
                          <div className="mt-1">
                            Options: {JSON.stringify(info.options, null, 2)}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}

            {/* Apply Button */}
            <div className="flex gap-2">
              <Button
                onClick={() => handleLayoutApply(currentLayout)}
                disabled={isApplying}
                className="flex-1"
              >
                {isApplying ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Layout className="h-4 w-4 mr-2" />
                )}
                Apply Settings
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reset Actions */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" disabled={disabled} className="shadow-glass backdrop-blur-sm">
            <RotateCcw className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Reset Options</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={handleRestorePositions}>
            Restore Last Positions
          </DropdownMenuItem>
          <DropdownMenuItem onClick={handleResetLayout}>
            Reset to Original Layout
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Current Layout Indicator */}
      {!disabled && (
        <Badge variant="outline" className="text-xs shadow-glass backdrop-blur-sm">
          {currentLayout}
        </Badge>
      )}
    </div>
  );
};
