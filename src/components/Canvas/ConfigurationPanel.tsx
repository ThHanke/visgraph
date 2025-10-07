/**
 * @fileoverview Configuration Panel Component
 * Provides UI for managing and testing persistent app configurations
 */

import { useState, useEffect } from 'react';
import { Button } from '../ui/button';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import { Slider } from '../ui/slider';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Settings, Download, Upload, RotateCcw } from 'lucide-react';
import { useAppConfigStore } from '../../stores/appConfigStore';
import { useOntologyStore } from '../../stores/ontologyStore';
import { WELL_KNOWN } from '../../utils/wellKnownOntologies';
import { fallback } from '../../utils/startupDebug';
import { toast } from 'sonner';



export interface ConfigurationPanelProps {
  triggerVariant?: 'default' | 'none' | 'fixed-icon' | 'inline-icon';
}

export const ConfigurationPanel = ({ triggerVariant = 'default' }: ConfigurationPanelProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [importText, setImportText] = useState('');

  // Blacklist UI local state (decoupled from persisted config until applied)
  const [blacklistEnabledLocal, setBlacklistEnabledLocal] = useState<boolean>(() => {
    try { return !!useAppConfigStore.getState().config.blacklistEnabled; } catch { return true; }
  });
  const [prefixesText, setPrefixesText] = useState<string>(() => {
    try { return (useAppConfigStore.getState().config.blacklistedPrefixes || []).join(', '); } catch { return 'owl, rdf, rdfs, xml, xsd'; }
  });
  const [urisText, setUrisText] = useState<string>(() => {
    try { return (useAppConfigStore.getState().config.blacklistedUris || []).join(', '); } catch { return 'http://www.w3.org/2002/07/owl, http://www.w3.org/1999/02/22-rdf-syntax-ns#'; }
  });

      useEffect(() => {
    try {
      const cfg = useAppConfigStore.getState().config;
      setBlacklistEnabledLocal(!!cfg.blacklistEnabled);
      setPrefixesText((cfg.blacklistedPrefixes || []).join(', '));
      setUrisText((cfg.blacklistedUris || []).join(', '));
    } catch (_) {
      /* ignore */
    }
  }, []);

  const {
    config,
    setCurrentLayout,
    setLayoutAnimations,
    setLayoutSpacing,
    setCanvasTheme,
    setAutoReasoning,
    setMaxVisibleNodes,
    // Reasoning rulesets setter
    setReasoningRulesets,
    resetToDefaults,
    exportConfig,
    importConfig,
    // Blacklist controls
    setBlacklistEnabled,
    setBlacklistedPrefixes,
    setBlacklistedUris,
    // Persisted autoload toggle
    setPersistedAutoload,
    removeAdditionalOntology,
    // Debugging toggles
    setDebugRdfLogging,
    // Debug master toggle
    setDebugAll,
    setTooltipEnabled,
  } = useAppConfigStore();


  const handleExportConfig = () => {
    const configJson = exportConfig();
    navigator.clipboard.writeText(configJson);
    toast.success('Configuration copied to clipboard');
  };

  const handleImportConfig = () => {
    try {
      importConfig(importText);
      setImportText('');
      toast.success('Configuration imported successfully');
    } catch (error) {
      toast.error('Invalid configuration format');
    }
  };

  const handleResetDefaults = () => {
    resetToDefaults();
    toast.success('Configuration reset to defaults');
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      {triggerVariant === 'fixed-icon' ? (
        <div className="fixed top-4 right-4 z-50">
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="p-2 rounded-full bg-card/90 border border-border shadow-md hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-primary/40"
              aria-label="Open configuration"
            >
              <Settings className="h-4 w-4" />
              <span className="sr-only">Configuration</span>
            </Button>
          </DialogTrigger>
        </div>
      ) : triggerVariant === 'inline-icon' ? (
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="p-2 rounded-md bg-card/90 border border-border shadow-sm hover:shadow focus:outline-none focus:ring-2 focus:ring-primary/20"
            aria-label="Open configuration"
            title="Open configuration"
          >
            <Settings className="h-4 w-4" />
            <span className="sr-only">Configuration</span>
          </Button>
        </DialogTrigger>
      ) : triggerVariant === 'none' ? null : (
        <DialogTrigger asChild>
          <Button variant="outline" size="sm" className="shadow-glass backdrop-blur-sm">
            <Settings className="h-4 w-4 mr-2" />
            Config
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Application Configuration</DialogTitle>
          <DialogDescription>
            Manage persistent settings and preferences for the visgraph.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="layout" className="w-full">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="layout">Layout</TabsTrigger>
            <TabsTrigger value="ui">Interface</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
            <TabsTrigger value="reasoning">Reasoning</TabsTrigger>
            <TabsTrigger value="advanced">Advanced</TabsTrigger>
          </TabsList>

          {/* Layout Settings */}
          <TabsContent value="layout" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Layout Preferences</CardTitle>
                <CardDescription>Configure how graphs are displayed and animated</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Current Layout</Label>
                  <Select value={config.currentLayout} onValueChange={setCurrentLayout}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="horizontal">Horizontal (Dagre)</SelectItem>
                      <SelectItem value="vertical">Vertical (Dagre)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between">
                  <Label htmlFor="animations">Layout Animations</Label>
                  <Switch
                    id="animations"
                    checked={config.layoutAnimations}
                    onCheckedChange={setLayoutAnimations}
                  />
                </div>


                <div className="space-y-2">
                  <Label>Recent Layouts</Label>
                  <div className="flex flex-wrap gap-1">
                    {config.recentLayouts.map((layout, index) => (
                      <Badge 
                        key={index} 
                        variant={layout === config.currentLayout ? "default" : "secondary"}
                        className="text-xs cursor-pointer"
                        onClick={() => setCurrentLayout(layout)}
                      >
                        {layout}
                      </Badge>
                    ))}
                  </div>
                </div>
              </CardContent>
              </Card>
          </TabsContent>

          {/* UI Settings */}
          <TabsContent value="ui" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Interface Preferences</CardTitle>
                <CardDescription>Customize the user interface appearance</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Canvas Theme</Label>
                  <Select value={config.canvasTheme} onValueChange={setCanvasTheme}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="light">Light</SelectItem>
                      <SelectItem value="dark">Dark</SelectItem>
                      <SelectItem value="auto">Auto (System)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Current View Mode</Label>
                  <Badge variant="outline">{config.viewMode.toUpperCase()}</Badge>
                </div>

                <div className="space-y-2">
                  <Label>Legend Visibility</Label>
                  <Badge variant={config.showLegend ? "default" : "secondary"}>
                    {config.showLegend ? "Visible" : "Hidden"}
                  </Badge>
                </div>

                <div className="flex items-center justify-between">
                  <Label>Enable tooltips</Label>
                  <Switch
                    checked={config.tooltipEnabled}
                    onCheckedChange={(val) => {
                      try {
                        setTooltipEnabled(Boolean(val));
                        toast.success(`Tooltips ${val ? "enabled" : "disabled"}`);
                      } catch (e) {
                        try { console.debug("[VG_DEBUG] setTooltipEnabled failed", e); } catch (_) { void 0; }
                        toast.error("Failed to update tooltip setting");
                      }
                    }}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <Label>Auto-load configured ontologies on startup</Label>
                  <Switch
                    checked={config.persistedAutoload}
                    onCheckedChange={(val) => {
                      try {
                        // Persist the new setting immediately
                        setPersistedAutoload(val);
                        toast.success(`Persisted autoload ${val ? "enabled" : "disabled"}`);
                      } catch (e) {
                        try { console.debug("[VG_DEBUG] setPersistedAutoload failed", e); } catch (_) { void 0; }
                        toast.error("Failed to update autoload setting");
                      }
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Performance Settings */}
          <TabsContent value="performance" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Performance Settings</CardTitle>
                <CardDescription>Optimize performance for large graphs</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Max Visible Nodes: {config.maxVisibleNodes}</Label>
                  <Slider
                    value={[config.maxVisibleNodes]}
                    onValueChange={([value]) => setMaxVisibleNodes(value)}
                    min={100}
                    max={5000}
                    step={100}
                    className="w-full"
                  />
                </div>

                
              </CardContent>
            </Card>
          </TabsContent>
  
          <TabsContent value="reasoning" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Reasoning</CardTitle>
                <CardDescription>Configure automatic reasoning and rulesets</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label htmlFor="reasoning">Auto Reasoning</Label>
                  <Switch
                    id="reasoning"
                    checked={config.autoReasoning}
                    onCheckedChange={setAutoReasoning}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Reasoning Rulesets</Label>
                  <div className="space-y-2 text-xs">
                    <div className="text-xs text-muted-foreground">
                      The selected rulesets will be fetched from the app's public assets and combined to drive the N3 reasoner.
                    </div>

                    {(() => {
                      try {
                        const available = ['best-practice.n3', 'owl-e.n3', 'owl-p.n3', 'owl-rl.n3'];
                        const selected = Array.isArray(config.reasoningRulesets) ? config.reasoningRulesets : [];

                        return available.map((name) => {
                          const checked = selected.includes(name);
                          return (
                            <div key={name} className="flex items-center gap-2">
                              <input
                                id={`rr-${name}`}
                                type="checkbox"
                                checked={checked}
                                onChange={() => {
                                  try {
                                    const cur = Array.isArray(config.reasoningRulesets) ? config.reasoningRulesets.slice() : [];
                                    const next = cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name];
                                    setReasoningRulesets(next);
                                    toast.success('Updated reasoning rulesets');
                                  } catch (e) {
                                    try { console.debug("[VG_DEBUG] setReasoningRulesets failed", e); } catch (_) { void 0; }
                                    toast.error('Failed to update reasoning rulesets');
                                  }
                                }}
                              />
                              <label htmlFor={`rr-${name}`} className="truncate">{name}</label>
                            </div>
                          );
                        });
                      } catch (_) {
                        return <div className="text-xs text-muted-foreground">n/a</div>;
                      }
                    })()}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>Auto-loaded Ontologies ({config.additionalOntologies.length})</Label>
                  {config.additionalOntologies.length === 0 ? (
                    <div className="text-xs text-muted-foreground">
                      No additional ontologies loaded automatically
                    </div>
                  ) : (
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {config.additionalOntologies.map((ontology, index) => (
                        <div 
                          key={index} 
                          className="flex items-center justify-between text-xs p-2 bg-primary/10 rounded"
                        >
                          <span 
                            className="truncate flex-1 mr-2" 
                            title={ontology}
                          >
                            {ontology.split('/').pop()?.replace('#', '') || ontology}
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-4 w-4 p-0 text-muted-foreground hover:text-destructive"
                            onClick={() => {
                              const { removeLoadedOntology } = useOntologyStore.getState();
                              removeLoadedOntology(ontology);
                              toast.success('Removed ontology from configuration');
                            }}
                          >
                            ×
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between">
                  <Label>Auto-load configured ontologies on startup</Label>
                  <Switch
                    checked={config.persistedAutoload}
                    onCheckedChange={(val) => {
                      try {
                        // Persist the new setting immediately
                        setPersistedAutoload(val);
                        toast.success(`Persisted autoload ${val ? "enabled" : "disabled"}`);
                      } catch (e) {
                        try { console.debug("[VG_DEBUG] setPersistedAutoload failed", e); } catch (_) { void 0; }
                        toast.error("Failed to update autoload setting");
                      }
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          {/* Advanced Settings */}
          <TabsContent value="advanced" className="space-y-4">
          <Card>
              <CardHeader>
                <CardTitle className="text-sm">Debug</CardTitle>
                <CardDescription>Developer debug helpers</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="text-xs text-muted-foreground">
                  When enabled, diagnostic logs prefixed with <code>[VG_]</code> and in-canvas metrics become visible.
                </div>

                <div className="flex items-center justify-between">
                  <Label>Enable developer debug (master)</Label>
                  <Switch
                    checked={config.debugAll}
                    onCheckedChange={(val) => {
                      try {
                        setDebugAll(Boolean(val));
                        toast.success(`Debug ${val ? "enabled" : "disabled"}`);
                      } catch (e) {
                        try { console.debug("[VG_DEBUG] setDebugAll failed", e); } catch (_) { void 0; }
                        toast.error("Failed to update debug setting");
                      }
                    }}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <Label>Enable RDF write logging</Label>
                  <Switch
                    checked={config.debugRdfLogging}
                    onCheckedChange={(val) => {
                      try {
                        setDebugRdfLogging(Boolean(val));
                        toast.success(`RDF write logging ${val ? "enabled" : "disabled"}`);
                      } catch (e) {
                        try { console.debug("[VG_DEBUG] setDebugRdfLogging failed", e); } catch (_) { void 0; }
                        toast.error("Failed to update RDF logging setting");
                      }
                    }}
                  />
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Blacklist</CardTitle>
                <CardDescription>Exclude subjects from UI node emission by prefix or namespace URI</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label>Enable blacklist</Label>
                  <Switch
                    checked={blacklistEnabledLocal}
                    onCheckedChange={(val) => {
                      try {
                        setBlacklistEnabledLocal(val);
                        setBlacklistEnabled(val);
                        try {
                          const mgr = useOntologyStore.getState().getRdfManager();
                          const prefixes = (prefixesText || "").split(",").map(s=>s.trim()).filter(Boolean);
                          const uris = (urisText || "").split(",").map(s=>s.trim()).filter(Boolean);
                          mgr.setBlacklist(prefixes, uris);
                        } catch (_) { /* ignore */ }
                        toast.success(`Blacklist ${val ? 'enabled' : 'disabled'}`);
                      } catch (e) {
                        toast.error('Failed to update blacklist');
                      }
                    }}
                  />
                </div>

                <div className="space-y-2">
                  <Label>Blacklisted prefixes (comma-separated)</Label>
                  <Input
                    value={prefixesText}
                    onChange={(e) => {
                      const v = (e.target as HTMLInputElement).value;
                      setPrefixesText(v);
                      try {
                        const prefixes = (v || "").split(",").map(s=>s.trim()).filter(Boolean);
                        setBlacklistedPrefixes(prefixes);
                        const uris = (urisText || "").split(",").map(s=>s.trim()).filter(Boolean);
                        const mgr = useOntologyStore.getState().getRdfManager();
                        mgr.setBlacklist(prefixes, uris);
                      } catch (_) { /* ignore */ }
                    }}
                    className="text-xs"
                    placeholder="e.g. owl, rdf, rdfs, xml, xsd"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Blacklisted namespace URIs (comma-separated)</Label>
                  <Input
                    value={urisText}
                    onChange={(e) => {
                      const v = (e.target as HTMLInputElement).value;
                      setUrisText(v);
                      try {
                        const uris = (v || "").split(",").map(s=>s.trim()).filter(Boolean);
                        setBlacklistedUris(uris);
                        const prefixes = (prefixesText || "").split(",").map(s=>s.trim()).filter(Boolean);
                        const mgr = useOntologyStore.getState().getRdfManager();
                        mgr.setBlacklist(prefixes, uris);
                      } catch (_) { /* ignore */ }
                    }}
                    className="text-xs"
                    placeholder="e.g. http://www.w3.org/1999/02/22-rdf-syntax-ns#"
                  />
                </div>

                <div className="space-y-2">
                  <Label>Computed expanded URIs</Label>
                  <div className="text-xs text-muted-foreground">
                    These are expanded namespace URIs derived from current prefixes and known namespaces (for visibility).
                  </div>
                  <div className="mt-2 text-xs">
                    {(() => {
                      try {
                        const mgr = useOntologyStore.getState().getRdfManager();
                        const ns = (mgr && typeof mgr.getNamespaces === 'function') ? mgr.getNamespaces() : {};
                        const wkPrefixes = (WELL_KNOWN && (WELL_KNOWN as any).prefixes) ? (WELL_KNOWN as any).prefixes : {};
                        const prefixes = (prefixesText || "").split(",").map(s=>s.trim()).filter(Boolean);
                        const explicitUris = (urisText || "").split(",").map(s=>s.trim()).filter(Boolean);

                        // Expand prefixes to namespace URIs using runtime namespaces, then well-known fallbacks.
                        const expandedFromPrefixes = prefixes.map((p) => {
                          try {
                            if (!p) return "";
                            if (ns[p]) return ns[p];
                            if (wkPrefixes && wkPrefixes[p]) return wkPrefixes[p];
                            if (mgr && typeof (mgr as any).expandPrefix === 'function') {
                              try {
                                const attempt = (mgr as any).expandPrefix(`${p}:dummy`);
                                // If expandPrefix returns something containing http, try to strip the dummy suffix.
                                if (typeof attempt === 'string') {
                                  const stripped = attempt.replace(/dummy$/, '');
                                  if (/^https?:\/\//i.test(stripped)) return stripped;
                                }
                              } catch (_) { /* ignore */ }
                            }
                            return "";
                          } catch (_) {
                            return "";
                          }
                        }).filter(Boolean);

                        // Combine and dedupe expanded URIs and explicit URIs
                        const combined = Array.from(new Set<string>([...expandedFromPrefixes, ...explicitUris])).filter(Boolean);

                        if (combined.length === 0) {
                          return <div className="text-xs text-muted-foreground">None</div>;
                        }

                        return combined.map((u, i) => (
                          <div key={i} className="truncate">{u}</div>
                        ));
                      } catch (_) {
                        return <div className="text-xs text-muted-foreground">n/a</div>;
                      }
                    })()}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Import/Export Configuration</CardTitle>
                <CardDescription>Backup or restore your settings</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Button onClick={handleExportConfig} variant="outline" className="flex-1">
                    <Download className="h-4 w-4 mr-2" />
                    Export Config
                  </Button>
                  <Button onClick={handleResetDefaults} variant="outline" className="flex-1">
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Reset Defaults
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label>Import Configuration</Label>
                  <textarea
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    placeholder="Paste configuration JSON here..."
                    className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 h-24 resize-none"
                  />
                  <Button 
                    onClick={handleImportConfig} 
                    disabled={!importText.trim()}
                    className="w-full"
                  >
                    <Upload className="h-4 w-4 mr-2" />
                    Import Configuration
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label>Storage Info</Label>
                  <div className="text-xs text-muted-foreground">
                    Settings are automatically saved to browser localStorage
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};
