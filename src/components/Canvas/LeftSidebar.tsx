/**
 * @fileoverview Left Sidebar Component
 * Collapsible sidebar with file operations and workflow templates
 */

import React, { useState, useEffect, useCallback } from 'react';
import { rdfManager } from '../../utils/rdfManager';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
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

  const loadTemplates = useCallback(async () => {
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
  }, []);

  // Re-load when the workflows graph changes (e.g. catalog loaded from Settings)
  useEffect(() => {
    const handler = (_subjects: string[], _quads?: unknown, _snapshot?: unknown, meta?: Record<string, unknown> | null) => {
      const graphName = meta && typeof meta.graphName === 'string' ? meta.graphName : null;
      if (graphName === 'urn:vg:workflows' && workflowCatalogEnabled) {
        loadTemplates();
      }
    };
    rdfManager.onSubjectsChange(handler as any);
    return () => rdfManager.offSubjectsChange(handler as any);
  }, [workflowCatalogEnabled, loadTemplates]);

  const handleDragStart = (template: WorkflowTemplate) => {
    console.log('[LeftSidebar] Drag started:', template.label);
  };

  return (
    <TooltipPrimitive.Provider delayDuration={0} skipDelayDuration={0}>
      <div
        className={cn(
          'absolute left-0 top-0 h-full z-20',
          'transition-all duration-300 ease-in-out',
          isExpanded ? 'w-72' : 'w-10'
        )}
      >
        {/* Floating collapse/expand tab on the right edge */}
        <TooltipPrimitive.Root>
          <TooltipPrimitive.Trigger asChild>
            <button
              onClick={onToggle}
              aria-label={isExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
              className="absolute right-0 top-1/2 -translate-y-1/2 z-30 flex items-center justify-center w-6 h-10 rounded-r-lg border border-l-0 border-border/40 bg-background/80 backdrop-blur-sm shadow-sm hover:bg-accent/60 transition-colors text-muted-foreground hover:text-foreground"
            >
              {isExpanded
                ? <ChevronLeft className="h-3 w-3" />
                : <ChevronRight className="h-3 w-3" />}
            </button>
          </TooltipPrimitive.Trigger>
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Content
              className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
              sideOffset={8}
              side="right"
            >
              {isExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
              <TooltipPrimitive.Arrow className="fill-popover" />
            </TooltipPrimitive.Content>
          </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>

        {/* Collapsed state - icon rail */}
        {!isExpanded && (
          <div className="h-full w-full flex flex-col items-center py-2 gap-1 px-1 bg-background border-r border-border/40 shadow-lg">
            {/* Action icons */}
            <TooltipPrimitive.Root>
              <TooltipPrimitive.Trigger asChild>
                <button className="rail-btn" onClick={onLoadOntology} aria-label="Load Ontology">
                  <Database className="h-[18px] w-[18px]" />
                  <span>Onto</span>
                </button>
              </TooltipPrimitive.Trigger>
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md" sideOffset={5} side="right">
                  Load Ontology<TooltipPrimitive.Arrow className="fill-popover" />
                </TooltipPrimitive.Content>
              </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>

            <TooltipPrimitive.Root>
              <TooltipPrimitive.Trigger asChild>
                <button className="rail-btn" onClick={onLoadFile} aria-label="Load File">
                  <Upload className="h-[18px] w-[18px]" />
                  <span>File</span>
                </button>
              </TooltipPrimitive.Trigger>
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md" sideOffset={5} side="right">
                  Load File<TooltipPrimitive.Arrow className="fill-popover" />
                </TooltipPrimitive.Content>
              </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>

            <TooltipPrimitive.Root>
              <TooltipPrimitive.Trigger asChild>
                <button className="rail-btn" onClick={onClearData} aria-label="Clear Data">
                  <Trash2 className="h-[18px] w-[18px]" />
                  <span>Clear</span>
                </button>
              </TooltipPrimitive.Trigger>
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md" sideOffset={5} side="right">
                  Clear Data<TooltipPrimitive.Arrow className="fill-popover" />
                </TooltipPrimitive.Content>
              </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>

            <TooltipPrimitive.Root>
              <TooltipPrimitive.Trigger asChild>
                <button className="rail-btn" onClick={onExport} aria-label="Export">
                  <Download className="h-[18px] w-[18px]" />
                  <span>Export</span>
                </button>
              </TooltipPrimitive.Trigger>
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md" sideOffset={5} side="right">
                  Export<TooltipPrimitive.Arrow className="fill-popover" />
                </TooltipPrimitive.Content>
              </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>

            <div className="flex-1" />

            <TooltipPrimitive.Root>
              <TooltipPrimitive.Trigger asChild>
                <button className="rail-btn" onClick={onSettings} aria-label="Settings">
                  <Settings className="h-[18px] w-[18px]" />
                  <span>Settings</span>
                </button>
              </TooltipPrimitive.Trigger>
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md" sideOffset={5} side="right">
                  Settings<TooltipPrimitive.Arrow className="fill-popover" />
                </TooltipPrimitive.Content>
              </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
          </div>
        )}

        {/* Expanded state - full sidebar */}
        {isExpanded && (
          <div className="glass h-full w-full flex flex-col">
          {/* Toggle button at top */}
          <div className="flex items-center bg-background  justify-between px-3 py-2 border-b border-border/40">
            <span className="text-sm font-medium text-foreground">Menu</span>
          </div>

          {/* Compact file operations row - 5 columns */}
          <div className="px-2 py-3 bg-background border-b border-border/40">
            <div className="grid grid-cols-5 gap-1">
              <TooltipPrimitive.Root>
                <TooltipPrimitive.Trigger asChild>
                  <button className="rail-btn h-14" onClick={onLoadOntology}>
                    <Database className="h-4 w-4" />
                    <span>Onto</span>
                  </button>
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
                  <button className="rail-btn h-14" onClick={onLoadFile}>
                    <Upload className="h-4 w-4" />
                    <span>File</span>
                  </button>
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
                  <button className="rail-btn h-14" onClick={onClearData}>
                    <Trash2 className="h-4 w-4" />
                    <span>Clear</span>
                  </button>
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
                  <button className="rail-btn h-14" onClick={onExport}>
                    <Download className="h-4 w-4" />
                    <span>Export</span>
                  </button>
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
                  <button className="rail-btn h-14" onClick={onSettings}>
                    <Settings className="h-4 w-4" />
                    <span>Settings</span>
                  </button>
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
            <div className="flex-1 bg-background overflow-y-auto">
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
