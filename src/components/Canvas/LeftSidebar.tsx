/**
 * @fileoverview Left Sidebar Component
 * Collapsible sidebar with file operations and workflow templates
 */

import React, { useState, useEffect } from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { Button } from '../ui/button';
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Upload,
  Trash2,
  Download,
  Settings,
  Sparkles,
} from 'lucide-react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../ui/accordion';
import { WorkflowTemplateCard } from './WorkflowTemplateCard';
import { getWorkflowTemplates, type WorkflowTemplate } from '../../utils/workflowInstantiator';
import { useAppConfigStore } from '../../stores/appConfigStore';
import { cn } from '../../lib/utils';

interface LeftSidebarProps {
  isExpanded: boolean;
  onToggle: () => void;
  onLoadOntology: () => void;
  onLoadFile: () => void;
  onClearData: () => void;
  onExport: () => void;
  onSettings: () => void;
}

export const LeftSidebar: React.FC<LeftSidebarProps> = ({
  isExpanded,
  onToggle,
  onLoadOntology,
  onLoadFile,
  onClearData,
  onExport,
  onSettings,
}) => {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workflowCatalogEnabled = useAppConfigStore((s) => s.config.workflowCatalogEnabled);

  useEffect(() => {
    if (isExpanded && workflowCatalogEnabled) {
      loadTemplates();
    }
  }, [isExpanded, workflowCatalogEnabled]);

  const loadTemplates = async () => {
    setLoading(true);
    setError(null);
    try {
      const fetchedTemplates = await getWorkflowTemplates();
      setTemplates(fetchedTemplates);
      if (fetchedTemplates.length === 0) {
        setError('No workflow templates found. Load the catalog from Settings > Workflows.');
      }
    } catch (err) {
      console.error('[LeftSidebar] Failed to load templates:', err);
      setError('Failed to load workflow templates');
    } finally {
      setLoading(false);
    }
  };

  const handleDragStart = (template: WorkflowTemplate) => {
    console.log('[LeftSidebar] Drag started:', template.label);
  };

  return (
    <TooltipPrimitive.Provider delayDuration={0} skipDelayDuration={0}>
      <div
        className={cn(
          'h-full z-10',
          'transition-all duration-300 ease-in-out',
          isExpanded ? 'w-72' : 'w-4'
        )}
      >
        {/* Collapsed state - thin vertical bar */}
        {!isExpanded && (
          <div className="h-full w-full backdrop-blur-md bg-background/60 border-r border-border/20 flex flex-col items-center pt-2">
            <TooltipPrimitive.Root>
              <TooltipPrimitive.Trigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onToggle}
                  className="h-8 w-8 p-0 hover:bg-accent"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </TooltipPrimitive.Trigger>
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content
                  className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
                  sideOffset={5}
                  side="right"
                >
                  Expand sidebar
                  <TooltipPrimitive.Arrow className="fill-popover" />
                </TooltipPrimitive.Content>
              </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
          </div>
        )}

        {/* Expanded state - full sidebar */}
        {isExpanded && (
          <div className="h-full w-full backdrop-blur-md bg-background/80 border-r border-border/20 shadow-lg flex flex-col">
          {/* Toggle button at top */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
            <span className="text-sm font-medium text-foreground">Menu</span>
            <TooltipPrimitive.Root>
              <TooltipPrimitive.Trigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onToggle}
                  className="h-8 w-8 p-0 hover:bg-accent"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              </TooltipPrimitive.Trigger>
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content
                  className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
                  sideOffset={5}
                  side="right"
                >
                  Collapse sidebar
                  <TooltipPrimitive.Arrow className="fill-popover" />
                </TooltipPrimitive.Content>
              </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
          </div>

          {/* Compact file operations row - 5 columns */}
          <div className="px-2 py-3 border-b border-border/40">
            <div className="grid grid-cols-5 gap-1">
              <TooltipPrimitive.Root>
                <TooltipPrimitive.Trigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-14 flex flex-col items-center justify-center gap-1 p-1 text-foreground hover:bg-accent hover:text-accent-foreground"
                    onClick={onLoadOntology}
                  >
                    <Database className="h-4 w-4" />
                    <span className="text-xs">Onto</span>
                  </Button>
                </TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                  <TooltipPrimitive.Content
                    className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
                    sideOffset={5}
                  >
                    Load Ontology
                    <TooltipPrimitive.Arrow className="fill-popover" />
                  </TooltipPrimitive.Content>
                </TooltipPrimitive.Portal>
              </TooltipPrimitive.Root>

              <TooltipPrimitive.Root>
                <TooltipPrimitive.Trigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-14 flex flex-col items-center justify-center gap-1 p-1 text-foreground hover:bg-accent hover:text-accent-foreground"
                    onClick={onLoadFile}
                  >
                    <Upload className="h-4 w-4" />
                    <span className="text-xs">File</span>
                  </Button>
                </TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                  <TooltipPrimitive.Content
                    className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
                    sideOffset={5}
                  >
                    Load File
                    <TooltipPrimitive.Arrow className="fill-popover" />
                  </TooltipPrimitive.Content>
                </TooltipPrimitive.Portal>
              </TooltipPrimitive.Root>

              <TooltipPrimitive.Root>
                <TooltipPrimitive.Trigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-14 flex flex-col items-center justify-center gap-1 p-1 text-foreground hover:bg-accent hover:text-accent-foreground"
                    onClick={onClearData}
                  >
                    <Trash2 className="h-4 w-4" />
                    <span className="text-xs">Clear</span>
                  </Button>
                </TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                  <TooltipPrimitive.Content
                    className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
                    sideOffset={5}
                  >
                    Clear Data
                    <TooltipPrimitive.Arrow className="fill-popover" />
                  </TooltipPrimitive.Content>
                </TooltipPrimitive.Portal>
              </TooltipPrimitive.Root>

              <TooltipPrimitive.Root>
                <TooltipPrimitive.Trigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-14 flex flex-col items-center justify-center gap-1 p-1 text-foreground hover:bg-accent hover:text-accent-foreground"
                    onClick={onExport}
                  >
                    <Download className="h-4 w-4" />
                    <span className="text-xs">Export</span>
                  </Button>
                </TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                  <TooltipPrimitive.Content
                    className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
                    sideOffset={5}
                  >
                    Export
                    <TooltipPrimitive.Arrow className="fill-popover" />
                  </TooltipPrimitive.Content>
                </TooltipPrimitive.Portal>
              </TooltipPrimitive.Root>

              <TooltipPrimitive.Root>
                <TooltipPrimitive.Trigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-14 flex flex-col items-center justify-center gap-1 p-1 text-foreground hover:bg-accent hover:text-accent-foreground"
                    onClick={onSettings}
                  >
                    <Settings className="h-4 w-4" />
                    <span className="text-xs">Settings</span>
                  </Button>
                </TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                  <TooltipPrimitive.Content
                    className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
                    sideOffset={5}
                  >
                    Settings
                    <TooltipPrimitive.Arrow className="fill-popover" />
                  </TooltipPrimitive.Content>
                </TooltipPrimitive.Portal>
              </TooltipPrimitive.Root>
            </div>
          </div>

          {/* Workflows accordion - scrollable */}
          {workflowCatalogEnabled && (
            <div className="flex-1 overflow-y-auto">
              <Accordion type="single" collapsible defaultValue="workflows">
                <AccordionItem value="workflows" className="border-none">
                  <AccordionTrigger className="px-3 py-2 hover:bg-accent/5">
                    <div className="flex items-center gap-2 text-foreground">
                      <Sparkles className="h-4 w-4 text-primary" />
                      <span className="text-sm font-medium">Workflows</span>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="px-2 pb-2">
                    {loading && (
                      <div className="text-sm text-muted-foreground text-center py-8">
                        Loading templates...
                      </div>
                    )}

                    {error && (
                      <div className="text-sm text-destructive text-center py-4 px-2">
                        {error}
                      </div>
                    )}

                    {!loading && !error && templates.length === 0 && (
                      <div className="text-sm text-muted-foreground text-center py-8 px-2">
                        <p className="mb-2">No templates available</p>
                        <p className="text-xs">
                          Load the catalog from Settings → Workflows
                        </p>
                      </div>
                    )}

                    {!loading && !error && templates.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground mb-3 px-1">
                          Drag a template onto the canvas to create a workflow instance
                        </p>
                        {templates.map((template) => (
                          <WorkflowTemplateCard
                            key={template.iri}
                            template={template}
                            onDragStart={handleDragStart}
                          />
                        ))}
                      </div>
                    )}
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </div>
          )}

          {/* If workflows not enabled, show placeholder */}
          {!workflowCatalogEnabled && (
            <div className="flex-1 flex items-center justify-center p-4">
              <div className="text-center text-sm text-muted-foreground">
                <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>Workflow catalog disabled</p>
                <p className="text-xs mt-1">Enable in Settings</p>
              </div>
            </div>
          )}
          </div>
        )}
      </div>
    </TooltipPrimitive.Provider>
  );
};
