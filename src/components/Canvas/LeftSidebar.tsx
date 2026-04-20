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

export type RdfExportFormat = 'turtle' | 'json-ld' | 'rdf-xml';

// eslint-disable-next-line no-script-url
function buildBookmarkletHref(origin: string, pageHref: string): string {
  const RU = new URL('relay.html', pageHref).href;
  const RO = origin;
  return `javascript:(function(){var RU='${RU}',RO='${RO}',PN='vg-relay',PO='width=320,height=180,menubar=no,toolbar=no,location=no,resizable=yes';if(window.__vgRelayActive){var b=document.getElementById('vg-relay-badge');if(b)b.style.display='flex';return;}window.__vgRelayActive=true;function op(){if(!window.__vgRelayPopup||window.__vgRelayPopup.closed)window.__vgRelayPopup=window.open(RU,PN,PO);return window.__vgRelayPopup;}op();function badge(){var e=document.getElementById('vg-relay-badge');if(e){e.style.display='flex';return;}var d=document.createElement('div');d.id='vg-relay-badge';d.style.cssText='position:fixed;top:12px;right:12px;z-index:2147483647;background:#0d1117;color:#3fb950;border:1px solid #3fb950;border-radius:6px;padding:6px 10px;font:13px/1.4 monospace;display:flex;align-items:center;gap:8px;box-shadow:0 2px 8px rgba(0,0,0,.5);cursor:pointer';d.title='Click to reopen relay popup';var t=document.createElement('span');t.textContent='\uD83D\uDFE2 VisGraph Relay Active';var x=document.createElement('span');x.style.cssText='cursor:pointer;color:#8b949e;font-size:15px;line-height:1';x.textContent='\u00D7';x.title='Hide badge';x.addEventListener('click',function(e){e.stopPropagation();d.style.display='none';});d.addEventListener('click',function(){op();});d.appendChild(t);d.appendChild(x);document.body.appendChild(d);}badge();function toast(txt,ok){var t=document.createElement('div');t.style.cssText='position:fixed;bottom:20px;right:12px;z-index:2147483647;background:#0d1117;color:'+(ok?'#3fb950':'#f85149')+';border:1px solid '+(ok?'#3fb950':'#f85149')+';border-radius:6px;padding:8px 12px;font:12px monospace;max-width:340px;box-shadow:0 2px 8px rgba(0,0,0,.5)';t.textContent=(ok?'✓ ':'✗ ')+txt.slice(0,80);document.body.appendChild(t);setTimeout(function(){if(t.parentNode)t.parentNode.removeChild(t);},4000);}function pickInp(root){var byId=['chat-input','prompt-textarea'].map(function(id){return document.getElementById(id);}).filter(Boolean)[0];if(byId)return byId;var all=Array.from(root.querySelectorAll('textarea,div[contenteditable="true"]'));if(!all.length)return null;var ta=all.filter(function(e){return e.tagName==='TEXTAREA';});return ta.length?ta[ta.length-1]:all[all.length-1];}function findInp(src){var el=(src&&document.contains(src))?src:document.body;while(el&&el!==document.body){var i=pickInp(el);if(i)return i;el=el.parentElement;}return pickInp(document.body);}function submit(inp){var cur=inp.parentElement;while(cur&&cur!==document.body){var sb=Array.from(cur.querySelectorAll('button')).find(function(b){if(b.disabled)return false;var l=(b.getAttribute('aria-label')||b.title||b.textContent||'').toLowerCase();return b.type==='submit'||l.includes('send')||l.includes('submit');});if(sb){sb.click();return;}cur=cur.parentElement;}['keydown','keyup'].forEach(function(t){inp.dispatchEvent(new KeyboardEvent(t,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));});}function inject(text,src){var el=findInp(src);if(!el)return;el.focus();if(el.tagName==='TEXTAREA'){var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;s.call(el,(el.value?el.value+'\n':'')+text);el.dispatchEvent(new Event('input',{bubbles:true}));}else{var sel=window.getSelection(),rng=document.createRange();rng.selectNodeContents(el);rng.collapse(false);sel.removeAllRanges();sel.addRange(rng);document.execCommand('insertText',false,(el.textContent&&el.textContent.trim()?'\n':'')+text);}setTimeout(function(){submit(el);},300);}var pse={};window.addEventListener('message',function(ev){if(ev.origin!==RO)return;var d=ev.data;if(!d||d.type!=='vg-result')return;var ok=d.result&&d.result.success!==false;var txt='Tool result: '+JSON.stringify(d.result!==undefined?d.result:d,null,2);var src=pse[d.requestId]||null;delete pse[d.requestId];inject(txt,src);toast(ok?'Result injected':'Error injected',ok);});function send(tn,params,src){var pp=window.__vgRelayPopup;if(!pp||pp.closed){toast('Relay popup closed \u2014 click the green badge to reopen',false);return;}var rid='rq-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);pse[rid]=src||null;setTimeout(function(){try{pp.postMessage({type:'vg-call',tool:tn,params:params,requestId:rid},RO);}catch(e){}},200);}var ds=new Set();function extr(text,src){var m=text.match(/^TOOL:\\s*(\\w+)\\s*$/m);if(!m)return false;var tn=m[1],params={},after=text.slice(text.indexOf(m[0])+m[0].length);after.split('\\n').forEach(function(line){var kv=line.match(/^(\\w+):\\s*(.+)/);if(kv){var v=kv[2].trim();params[kv[1]]=v==='true'?true:v==='false'?false:(!isNaN(+v)&&v!==''?+v:v);}});var sig=tn+':'+JSON.stringify(params);if(ds.has(sig))return false;ds.add(sig);send(tn,params,src);return true;}function scan(el){if(!el||(el.dataset&&el.dataset.vgProcessed))return;var txt=el.innerText||el.textContent||'';if(extr(txt,el)&&el.dataset)el.dataset.vgProcessed='1';}var dt=null;var pn=new Set();function flush(){pn.forEach(function(n){scan(n);});pn.clear();}function collect(node){var el=node.nodeType===3?node.parentElement:node;while(el&&el!==document.body){if(el.dataset&&el.dataset.vgProcessed)return;var t=el.tagName?el.tagName.toLowerCase():'';if(t==='p'||t==='div'||t==='section'||t==='article'||t==='li'){pn.add(el);return;}el=el.parentElement;}if(el===document.body)pn.add(document.body);}new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){collect(n);});if(m.type==='characterData')collect(m.target);});clearTimeout(dt);dt=setTimeout(flush,400);}).observe(document.body,{childList:true,subtree:true,characterData:true});setTimeout(function(){scan(document.body);},500);})();`;
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
                  <button className="rail-btn relative" onClick={onToggle} aria-label="AI Relay">
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
            <Accordion type="multiple" defaultValue={['ai-relay']}>
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
