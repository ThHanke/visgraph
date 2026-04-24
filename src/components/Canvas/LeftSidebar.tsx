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
  Bot,
  HelpCircle,
} from 'lucide-react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '../ui/accordion';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { WorkflowTemplateCard } from './WorkflowTemplateCard';
import { getWorkflowTemplates, type WorkflowTemplate } from '../../utils/workflowInstantiator';
import { useAppConfigStore } from '../../stores/appConfigStore';
import { useRelayBridge } from '../../hooks/useRelayBridge';
import { RelaySection } from './RelaySection';
import { cn } from '../../lib/utils';
import bookmarkletTemplate from 'virtual:relay-bookmarklet';
import readmeSrc from '../../../README.md?raw';

function parseTocLinks(markdown: string): [string, string][] {
  const match = markdown.match(/## Table of Contents\n([\s\S]*?)(?=\n[A-Za-z]|\n##)/);
  if (!match) return [];
  return [...match[1].matchAll(/^- \[([^\]]+)\]\(#([^)]+)\)/gm)]
    .map(m => [m[1], `#${m[2]}`] as [string, string]);
}

const README_TOC = parseTocLinks(readmeSrc);

export type RdfExportFormat = 'turtle' | 'json-ld' | 'rdf-xml';

// eslint-disable-next-line no-script-url
function buildBookmarkletHref(origin: string, pageHref: string): string {
  const relayUrl = new URL('relay.html', pageHref).href;
  const code = bookmarkletTemplate
    .replace('__RELAY_URL__', relayUrl)
    .replace('__RELAY_ORIGIN__', origin);
  return `javascript:${code}`;
}

interface LeftSidebarProps {
  isExpanded: boolean;
  onToggle: () => void;
  onLoadOntology: () => void;
  onLoadFile: () => void;
  onClearData: () => void;
  onExportRdf: (format: RdfExportFormat) => void;
  onSettings: () => void;
}

export const LeftSidebar: React.FC<LeftSidebarProps> = ({
  isExpanded,
  onToggle,
  onLoadOntology,
  onLoadFile,
  onClearData,
  onExportRdf,
  onSettings,
}) => {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openAccordions, setOpenAccordions] = useState<string[]>(['ai-relay']);
  const workflowCatalogEnabled = useAppConfigStore((s) => s.config.workflowCatalogEnabled);
  const { connected, callLog } = useRelayBridge(true);

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
      {/* Mobile backdrop — tap to close */}
      {isExpanded && (
        <div
          className="fixed inset-0 sm:hidden"
          style={{ zIndex: 90 }}
          onClick={onToggle}
        />
      )}
      <div
        className={cn(
          'absolute left-0 top-0 h-full',
          'transition-all duration-300 ease-in-out',
          isExpanded ? 'w-[min(18rem,75vw)]' : 'w-10'
        )}
        style={{ zIndex: 100 }}
      >
        {/* Collapsed state - icon rail */}
        {!isExpanded && (
          <div className="h-full w-full flex flex-col bg-background border-r border-border/40 shadow-lg overflow-visible">
            {/* Top spacer — full-bleed, chevron centered, lip div grows on hover */}
            <TooltipPrimitive.Root>
              <TooltipPrimitive.Trigger asChild>
                <div
                  role="button"
                  onClick={onToggle}
                  aria-label="Expand sidebar"
                  className="group flex-shrink-0 w-full h-12 border-b border-border/40 flex items-center justify-center relative overflow-visible cursor-pointer"
                >
                  <div className="group relative flex items-center justify-center w-full h-8 overflow-visible text-muted-foreground group-hover:text-foreground group-hover:bg-accent transition-colors duration-150">
                    <ChevronRight className="h-[18px] w-[18px] shrink-0" />
                    <div className="absolute right-0 top-0 bottom-0 w-0 group-hover:w-3 translate-x-full bg-accent rounded-r-md transition-[width] duration-200" />
                  </div>
                </div>
              </TooltipPrimitive.Trigger>
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md" sideOffset={5} side="right">
                  Expand sidebar<TooltipPrimitive.Arrow className="fill-popover" />
                </TooltipPrimitive.Content>
              </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
            {/* Action icons */}
            <div className="flex flex-col items-center gap-1 px-1 py-2 flex-1">
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

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="rail-btn" aria-label="Export">
                  <Download className="h-[18px] w-[18px]" />
                  <span>Export</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="start" className="z-[99999] min-w-[10rem]">
                <DropdownMenuLabel className="text-xs text-muted-foreground">Export RDF</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => onExportRdf('turtle')}>
                  Turtle (.ttl)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onExportRdf('json-ld')}>
                  JSON-LD (.jsonld)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onExportRdf('rdf-xml')}>
                  RDF/XML (.rdf)
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <TooltipPrimitive.Root>
                <TooltipPrimitive.Trigger asChild>
                  <button className="rail-btn relative" onClick={() => { setOpenAccordions(['ai-relay']); onToggle(); }} aria-label="AI Relay">
                    <Bot className="h-[18px] w-[18px]" />
                    <span>Relay</span>
                    {connected && (
                      <span className="absolute top-0.5 right-0.5 h-2 w-2 rounded-full bg-green-500" />
                    )}
                  </button>
                </TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                  <TooltipPrimitive.Content className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md" sideOffset={5} side="right">
                    AI Relay<TooltipPrimitive.Arrow className="fill-popover" />
                  </TooltipPrimitive.Content>
                </TooltipPrimitive.Portal>
              </TooltipPrimitive.Root>

            <div className="flex-1" />

            <TooltipPrimitive.Root>
              <TooltipPrimitive.Trigger asChild>
                <button
                  className="rail-btn"
                  aria-label="Documentation"
                  onClick={() => {
                    setOpenAccordions(['docs']);
                    onToggle();
                  }}
                >
                  <HelpCircle className="h-[18px] w-[18px]" />
                  <span>Docs</span>
                </button>
              </TooltipPrimitive.Trigger>
              <TooltipPrimitive.Portal>
                <TooltipPrimitive.Content className="z-[99999] rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md" sideOffset={5} side="right">
                  Documentation<TooltipPrimitive.Arrow className="fill-popover" />
                </TooltipPrimitive.Content>
              </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>

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
            </div>{/* end icons div */}
          </div>
        )}

        {/* Expanded state - full sidebar */}
        {isExpanded && (
          <div className="glass h-full w-full flex flex-col">
          {/* Toggle button at top */}
          <div className="flex items-center bg-background justify-between px-3 py-2 border-b border-border/40">
            <span className="text-sm font-medium text-foreground">Menu</span>
            <TooltipPrimitive.Root>
              <TooltipPrimitive.Trigger asChild>
                <button
                  onClick={onToggle}
                  aria-label="Collapse sidebar"
                  className="h-8 w-8 flex items-center justify-center rounded hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
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

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="rail-btn h-14" aria-label="Export">
                    <Download className="h-4 w-4" />
                    <span>Export</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="bottom" align="start" className="z-[99999] min-w-[10rem]">
                  <DropdownMenuLabel className="text-xs text-muted-foreground">Export RDF</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => onExportRdf('turtle')}>
                    Turtle (.ttl)
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onExportRdf('json-ld')}>
                    JSON-LD (.jsonld)
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => onExportRdf('rdf-xml')}>
                    RDF/XML (.rdf)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

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

          {/* Accordion sections - scrollable */}
          <div className="flex-1 bg-background overflow-y-auto">
            <Accordion type="multiple" value={openAccordions} onValueChange={setOpenAccordions}>
              {workflowCatalogEnabled && (
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
              )}

              <AccordionItem value="ai-relay" className="border-none">
                <AccordionTrigger className="px-3 py-2 hover:bg-accent/5">
                  <div className="flex items-center gap-2 text-foreground flex-1">
                    <Bot className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium">AI Relay</span>
                    <span
                      className={`ml-auto mr-1 h-2 w-2 rounded-full flex-shrink-0 ${connected ? 'bg-green-500' : 'bg-muted-foreground/40'}`}
                      aria-label={connected ? 'Connected' : 'Not connected'}
                    />
                  </div>
                </AccordionTrigger>
                <AccordionContent className="pb-2">
                  <RelaySection
                    bookmarkletHref={buildBookmarkletHref(window.location.origin, window.location.href)}
                    connected={connected}
                    callLog={callLog}
                  />
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="docs" className="border-none">
                <AccordionTrigger className="px-3 py-2 hover:bg-accent/5">
                  <div className="flex items-center gap-2 text-foreground">
                    <HelpCircle className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium">Documentation</span>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="pb-2">
                  <nav className="px-3 py-1 space-y-1">
                    {README_TOC.map(([label, anchor]) => (
                      <a
                        key={anchor}
                        href={`https://github.com/ThHanke/visgraph${anchor}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-0.5"
                      >
                        <span className="text-muted-foreground/50">›</span>
                        {label}
                      </a>
                    ))}
                  </nav>
                </AccordionContent>
              </AccordionItem>
            </Accordion>

            {/* If neither section enabled, show placeholder */}
            {!workflowCatalogEnabled && (
              <div className="flex items-center justify-center p-4 h-full">
                <div className="text-center text-sm text-muted-foreground">
                  <Sparkles className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No sections enabled</p>
                  <p className="text-xs mt-1">Enable in Settings</p>
                </div>
              </div>
            )}
          </div>
          </div>
        )}
      </div>
    </TooltipPrimitive.Provider>
  );
};
