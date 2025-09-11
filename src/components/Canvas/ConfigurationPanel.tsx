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
import { fallback } from '../../utils/startupDebug';
import { toast } from 'sonner';

/**
 * RecentOntologiesDisplay
 * - Shows recent ontologies (from config) and ontologies currently loaded into the RDF/ontology store
 * - Allows quickly adding a discovered/loaded ontology to the auto-load list (additionalOntologies)
 * - Shows badges indicating whether an ontology is currently loaded and whether it is configured for auto-load
 */
const RecentOntologiesDisplay = () => {
  const { config, addAdditionalOntology, removeAdditionalOntology } = useAppConfigStore();
  const { loadedOntologies, getRdfManager } = useOntologyStore();

  // Obtain any namespaces discovered in the RDF manager as additional potential sources
  const rdfMgr = getRdfManager && typeof getRdfManager === 'function' ? getRdfManager() : undefined;
  const rdfNamespaces = (rdfMgr && typeof rdfMgr.getNamespaces === 'function') ? rdfMgr.getNamespaces() : {};

  // Build a combined, ordered list: prefer loaded ontologies, then recent config entries, then rdfManager namespaces
  const loadedUrls = (loadedOntologies || []).map(o => o.url);
  const recentUrls = (config && config.recentOntologies) ? config.recentOntologies : [];
  const nsUrls = Object.values(rdfNamespaces || {});

  const combined = Array.from(new Set<string>([
    ...loadedUrls,
    ...recentUrls,
    ...nsUrls
  ]));

  if (combined.length === 0) {
    return <div className="text-xs text-muted-foreground">No recent or loaded ontologies</div>;
  }

  return (
    <div className="space-y-1 max-h-40 overflow-y-auto">
      {combined.map((uri) => {
        const short = (() => {
          try {
            return new URL(uri).hostname + (new URL(uri).pathname ? new URL(uri).pathname.split('/').pop() || '' : '');
          } catch {
            return uri;
          }
        })();

        const isLoaded = loadedUrls.includes(uri);
        const isAuto = (config && Array.isArray(config.additionalOntologies)) ? config.additionalOntologies.includes(uri) : false;

        return (
          <div key={uri} className="flex items-center justify-between gap-2 p-2 bg-muted/5 rounded text-xs">
            <div className="flex-1 min-w-0">
              <div className="truncate" title={uri}>{short || uri}</div>
              <div className="text-xs text-muted-foreground truncate" title={uri}>{uri}</div>
            </div>

            <div className="flex items-center gap-2">
              {isLoaded && <Badge variant="default" className="text-xs">Loaded</Badge>}
              {isAuto ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={() => {
                    try {
                      removeAdditionalOntology(uri);
                      toast.success('Removed from auto-load list');
                    } catch (e) {
                      ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('removeAdditionalOntology failed', e);
                      toast.error('Failed to remove ontology from auto-load list');
                    }
                  }}
                >
                  Auto (Remove)
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => {
                    try {
                      addAdditionalOntology(uri);
                      toast.success('Added to auto-load list');
                    } catch (e) {
                      ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('addAdditionalOntology failed', e);
                      toast.error('Failed to add ontology to auto-load list');
                    }
                  }}
                >
                  Add Auto
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

export interface ConfigurationPanelProps {
  triggerVariant?: 'default' | 'none' | 'fixed-icon' | 'inline-icon';
}

export const ConfigurationPanel = ({ triggerVariant = 'default' }: ConfigurationPanelProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [importText, setImportText] = useState('');

  const {
    config,
    setCurrentLayout,
    setLayoutAnimations,
    setLayoutSpacing,
    setCanvasTheme,
    setAutoReasoning,
    setMaxVisibleNodes,
    resetToDefaults,
    exportConfig,
    importConfig,
    removeAdditionalOntology
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
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="layout">Layout</TabsTrigger>
            <TabsTrigger value="ui">Interface</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
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
                <div className="flex items-center justify-between">
                  <Label htmlFor="reasoning">Auto Reasoning</Label>
                  <Switch
                    id="reasoning"
                    checked={config.autoReasoning}
                    onCheckedChange={setAutoReasoning}
                  />
                </div>

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

                <div className="space-y-2">
                  <Label>Recent Ontologies</Label>
                  {/* Combine recent entries from config with any loaded ontologies for convenience.
                      Allow quick adding of an ontology to the auto-load list. */}
                  <RecentOntologiesDisplay />
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
              </CardContent>
            </Card>
          </TabsContent>

          {/* Advanced Settings */}
          <TabsContent value="advanced" className="space-y-4">
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
                    className="w-full h-24 p-2 text-xs border rounded resize-none"
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
