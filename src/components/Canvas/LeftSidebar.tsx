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

export type RdfExportFormat = 'turtle' | 'json-ld' | 'rdf-xml';

// eslint-disable-next-line no-script-url
function buildBookmarkletHref(origin: string, pageHref: string): string {
  const RU = new URL('relay.html', pageHref).href;
  const RO = origin;
  // Minified from public/relay-bookmarklet.js — keep in sync when updating.
  // RU/RO are injected at runtime; \\n in string literals = template literal \\n = newline in output.
  return `javascript:(function(){var RU='${RU}',RO='${RO}',PN='vg-relay',PO='width=320,height=180,menubar=no,toolbar=no,location=no,resizable=yes',DB=400;function op(){if(!window.__vgRelayPopup||window.__vgRelayPopup.closed)window.__vgRelayPopup=window.open(RU,PN,PO);return window.__vgRelayPopup;}if(window.__vgRelayActive){var ep=op();badge();if(!ep){toast('Popup blocked \\u2014 allow popups for this site, then click the badge to retry',false);var eb=document.getElementById('vg-relay-badge');if(eb)eb.style.animation='vg-pulse 0.6s ease 3';}return;}window.__vgRelayActive=true;(function(){var s=document.createElement('style');s.textContent='@keyframes vg-pulse{0%,100%{outline:2px solid #3fb950}50%{outline:4px solid #f0883e}}';document.head.appendChild(s);})();function badge(){var e=document.getElementById('vg-relay-badge');if(e){e.style.display='flex';return;}var d=document.createElement('div');d.id='vg-relay-badge';d.style.cssText='position:fixed;top:12px;right:12px;z-index:2147483647;background:#0d1117;color:#3fb950;border:1px solid #3fb950;border-radius:6px;padding:6px 10px;font:13px/1.4 monospace;display:flex;align-items:center;gap:8px;box-shadow:0 2px 8px rgba(0,0,0,.5);cursor:pointer';d.title='Click to reopen relay popup';var t=document.createElement('span');t.textContent='\\u{1F7E2} VisGraph Relay Active';var x=document.createElement('span');x.style.cssText='cursor:pointer;color:#8b949e;font-size:15px;line-height:1';x.textContent='\\u00D7';x.title='Hide badge (relay stays active)';x.addEventListener('click',function(e){e.stopPropagation();d.style.display='none';});d.addEventListener('click',function(){var p=op();if(!p){toast('Popup blocked \\u2014 allow popups for this site, then click the badge to retry',false);d.style.animation='vg-pulse 0.6s ease 3';}});d.appendChild(t);d.appendChild(x);document.body.appendChild(d);}(function(){var p=op();if(!p){badge();toast('Popup blocked \\u2014 allow popups for this site, then click the badge to retry',false);var b=document.getElementById('vg-relay-badge');if(b)b.style.animation='vg-pulse 0.6s ease 3';}else{badge();}})();function toast(txt,ok){var t=document.createElement('div');t.style.cssText='position:fixed;bottom:20px;right:12px;z-index:2147483647;background:#0d1117;color:'+(ok?'#3fb950':'#f85149')+';border:1px solid '+(ok?'#3fb950':'#f85149')+';border-radius:6px;padding:8px 12px;font:12px monospace;max-width:340px;box-shadow:0 2px 8px rgba(0,0,0,.5)';t.textContent=(ok?'\\u2713 ':'\\u2717 ')+txt.slice(0,120);document.body.appendChild(t);setTimeout(function(){if(t.parentNode)t.parentNode.removeChild(t);},4000);}function findInp(){var cs=Array.from(document.querySelectorAll('textarea,div[contenteditable="true"]')).filter(function(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0;});if(!cs.length)return null;var ta=cs.filter(function(e){return e.tagName==='TEXTAREA';});var pool=ta.length?ta:cs;return pool.reduce(function(best,el){return el.getBoundingClientRect().bottom>best.getBoundingClientRect().bottom?el:best;});}function submit(inp){var cur=inp.parentElement;while(cur&&cur!==document.body){var sb=Array.from(cur.querySelectorAll('button')).find(function(b){if(b.disabled)return false;var l=(b.getAttribute('aria-label')||b.title||b.textContent||'').toLowerCase();return b.type==='submit'||l.includes('send')||l.includes('submit');});if(sb){sb.click();return;}cur=cur.parentElement;}['keydown','keyup'].forEach(function(t){inp.dispatchEvent(new KeyboardEvent(t,{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));});}function inject(text){var el=findInp();if(!el){toast('Could not find chat input',false);return false;}function doSub(){setTimeout(function(){submit(el);},500);}function fb3(){el.focus();if(el.tagName==='TEXTAREA'){var s=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;s.call(el,(el.value?el.value+'\\n':'')+text);el.dispatchEvent(new Event('input',{bubbles:true}));}else{document.execCommand('selectAll');document.execCommand('insertText',false,text);}doSub();}function fb2(){try{var dt=new DataTransfer();dt.setData('text/plain',text);el.focus();var sb=el.tagName==='TEXTAREA'?el.value:el.textContent;el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));var sa=el.tagName==='TEXTAREA'?el.value:el.textContent;if(sa!==sb){doSub();}else{fb3();}}catch(e){fb3();}}if(el.tagName==='TEXTAREA'){fb3();}else if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){el.focus();el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true}));doSub();}).catch(function(){fb2();});}else{fb2();}return true;}function briefData(d){if(!d)return'ok';if(typeof d==='string')return d.slice(0,80);if(d.iri)return d.iri;if(d.loaded!==undefined){var b=String(d.loaded);if(d.newEntitiesAvailable&&d.newEntitiesAvailable.length)b+=' \\u2014 '+d.newEntitiesAvailable.length+' new entities available';return b;}if(d.entities)return d.entities.length+' entities';if(d.links)return d.links.length+' links';if(d.results){var oc=d.results.filter(function(r){return r.onCanvas;});return d.results.length+' results'+(oc.length?', '+oc.length+' on canvas (auto-focused)':'');}if(d.completions)return d.completions.length+' completions';if(d.nodeCount!==undefined)return d.nodeCount+' nodes, '+d.linkCount+' links';if(d.added)return 's='+(d.added.s||'')+' p='+(d.added.p||'')+' o='+(d.added.o||'');if(d.removed!==undefined)return typeof d.removed==='string'?'removed '+d.removed:JSON.stringify(d.removed);if(d.inferredTriples!==undefined)return d.inferredTriples+' triples inferred';if(d.content!==undefined)return'('+(d.content.length||0)+' chars)';if(d.expanded!==undefined)return d.expanded+' nodes expanded';return JSON.stringify(d).slice(0,80);}var pi=null;function injectBatch(results,summary,svg){var allOk=results.every(function(r){return r.ok;});var lines=['[VisGraph \\u2014 '+results.length+' tool'+(results.length!==1?'s':'')+(allOk?' \\u2713':' (some failed)')+']'];results.forEach(function(r){if(r.ok){lines.push('\\u2713 '+r.tool+': '+briefData(r.result&&r.result.data));}else{var err=(r.result&&r.result.error)||'failed';lines.push('\\u2717 '+r.tool+': '+err);}});if(summary){lines.push('');lines.push(summary);}if(svg&&typeof svg==='string'){lines.push('');lines.push('Current graph (SVG):');lines.push(svg);}var text=lines.join('\\n');var msg='Done: '+results.length+' tool'+(results.length!==1?'s':'');if(!document.hasFocus()||document.visibilityState!=='visible'){pi={text:text,allOk:allOk,toastMsg:msg};toast('\\u23f3 Waiting for tab focus to inject result',true);return;}inject(text);toast(msg,allOk);}var cq=[],br=[],isp=false,pt=null,ls=null;window.addEventListener('message',function(ev){if(ev.origin!==RO)return;var d=ev.data;if(!d||d.type!=='vg-result')return;var ok=!!(d.result&&d.result.success!==false);br.push({tool:pt||'?',ok:ok,result:d.result});if(d.summary)ls=d.summary;isp=false;pt=null;if(cq.length>0){next();}else{var rs=br.slice();var sm=ls;br=[];ls=null;injectBatch(rs,sm,d.svg);}});var KP={'rdf:':'http://www.w3.org/1999/02/22-rdf-syntax-ns#','rdfs:':'http://www.w3.org/2000/01/rdf-schema#','owl:':'http://www.w3.org/2002/07/owl#','xsd:':'http://www.w3.org/2001/XMLSchema#','foaf:':'http://xmlns.com/foaf/0.1/','skos:':'http://www.w3.org/2004/02/skos/core#','dc:':'http://purl.org/dc/elements/1.1/','dcterms:':'http://purl.org/dc/terms/','schema:':'https://schema.org/','ex:':'http://example.org/'};function expand(v){for(var p in KP){if(v.indexOf(p)===0)return KP[p]+v.slice(p.length);}return v;}var ds=new Set();function extr(text){var stripped=text.replace(/^\`\`\`[^\\n]*\\n([\\s\\S]*?)^\`\`\`/gm,'$1');var calls=[];var parts=stripped.split(/^TOOL:\\s*/m);for(var i=1;i<parts.length;i++){var lines=parts[i].split('\\n');var fl=lines[0].trim();var tm=fl.match(/^(\\w+)(.*)/);if(!tm)continue;var tool=tm[1];var params={};function pp(line){line=line.trim();if(!line)return;var kv=line.match(/^(\\w+):\\s*(.+)/);if(kv&&!/\\s+\\w+:/.test(kv[2])){var v=kv[2].trim();if(v.indexOf(':')!==-1&&v.indexOf(' ')===-1)v=expand(v);params[kv[1]]=v==='true'?true:v==='false'?false:(!isNaN(+v)&&v!=='')?+v:v;return;}var pr=/(\\w+):\\s*(.*?)(?=\\s+\\w+:|$)/g;var mp;while((mp=pr.exec(line))!==null){var v=mp[2].trim();if(!v)continue;if(v.indexOf(':')!==-1&&v.indexOf(' ')===-1)v=expand(v);params[mp[1]]=v==='true'?true:v==='false'?false:(!isNaN(+v)&&v!=='')?+v:v;}}var ir=tm[2].trim();if(ir)pp(ir);for(var j=1;j<lines.length;j++)pp(lines[j]);var sig=tool+':'+JSON.stringify(params);if(!ds.has(sig)){ds.add(sig);calls.push({tool:tool,params:params});}}return calls;}function isStr(){var inp=findInp();if(inp){if(inp.disabled)return true;if(inp.getAttribute('aria-disabled')==='true')return true;var cur=inp.parentElement;while(cur&&cur!==document.body){var sb=Array.from(cur.querySelectorAll('button')).find(function(b){var l=(b.getAttribute('aria-label')||b.title||b.textContent||'').toLowerCase();return b.type==='submit'||l.includes('send')||l.includes('senden')||l.includes('submit');});if(sb){if(sb.disabled)return true;break;}cur=cur.parentElement;}var el=inp.parentElement;while(el&&el!==document.body){if(el.getAttribute('aria-busy')==='true')return true;el=el.parentElement;}}return false;}function waitIdle(el,cb){var MW=30000,PI=200,ST=3,elapsed=0,ll=-1,sc=0;function p(){elapsed+=PI;var l=(el.innerText||el.textContent||'').length;if(l!==ll){ll=l;sc=0;}else{sc++;}var done=(!isStr()&&sc>=ST)||elapsed>=MW;if(done){cb();}else{setTimeout(p,PI);}}setTimeout(p,PI);}var dt2=null;function sched(el){clearTimeout(dt2);dt2=setTimeout(function(){waitIdle(el,function(){if(!isp)next();});},DB);}function enq(el){if(!el)return;var txt=el.innerText||el.textContent||'';var calls=extr(txt);if(!calls.length)return;cq=cq.concat(calls);sched(el);}function next(){if(isp||!cq.length)return;isp=true;var item=cq.shift();var isLast=cq.length===0;var pp=window.__vgRelayPopup;if(!pp||pp.closed)pp=op();if(!pp){toast('Relay popup could not open',false);isp=false;cq=[];br=[];ls=null;return;}pt=item.tool;var rid='rq-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);setTimeout(function(){try{pp.postMessage({type:'vg-call',tool:item.tool,params:item.params,requestId:rid,isLast:isLast},RO);}catch(e){console.warn('[vg-relay] postMessage failed:',e);isp=false;}},200);}var dbt=null,pn=new Set();function flush(){pn.forEach(function(n){enq(n);});pn.clear();}function collect(node){var el=node.nodeType===3?node.parentElement:node;while(el&&el!==document.body){var t=el.tagName?el.tagName.toLowerCase():'';if(t==='p'||t==='li'){var p=el.parentElement;while(p&&p!==document.body){var pt=p.tagName?p.tagName.toLowerCase():'';if(pt==='div'||pt==='section'||pt==='article'){pn.add(p);return;}p=p.parentElement;}pn.add(el);return;}if(t==='div'||t==='section'||t==='article'){pn.add(el);return;}el=el.parentElement;}if(el===document.body)pn.add(document.body);}new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){collect(n);});if(m.type==='characterData')collect(m.target);});clearTimeout(dbt);dbt=setTimeout(flush,DB);}).observe(document.body,{childList:true,subtree:true,characterData:true});document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible'&&pi){var p=pi;pi=null;inject(p.text);toast(p.toastMsg,p.allOk);}});setTimeout(function(){enq(document.body);},500);})();`;
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
                    {([
                      ['Overview', '#overview'],
                      ['Key capabilities', '#key-capabilities'],
                      ['Startup / URL parameters', '#startup--url-parameters'],
                      ['Left sidebar', '#left-sidebar'],
                      ['AI / MCP integration', '#ai--mcp-integration'],
                      ['AI Relay Bridge', '#chatgpt-gemini-claudeai--ai-relay-bridge'],
                      ['Playwright / headless', '#setup-playwright--headless'],
                    ] as [string, string][]).map(([label, anchor]) => (
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
