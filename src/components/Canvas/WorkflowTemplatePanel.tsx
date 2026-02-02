/**
 * @fileoverview Workflow Template Panel Component
 * Collapsible sidebar displaying available workflow templates
 */

import React, { useState, useEffect } from 'react';
import { Button } from '../ui/button';
import { ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { WorkflowTemplateCard } from './WorkflowTemplateCard';
import { getWorkflowTemplates, type WorkflowTemplate } from '../../utils/workflowInstantiator';
import { useAppConfigStore } from '../../stores/appConfigStore';

interface WorkflowTemplatePanelProps {
  isOpen: boolean;
  onToggle: () => void;
}

export const WorkflowTemplatePanel: React.FC<WorkflowTemplatePanelProps> = ({
  isOpen,
  onToggle,
}) => {
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workflowCatalogEnabled = useAppConfigStore((s) => s.config.workflowCatalogEnabled);

  useEffect(() => {
    if (isOpen && workflowCatalogEnabled) {
      loadTemplates();
    }
  }, [isOpen, workflowCatalogEnabled]);

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
      console.error('[WorkflowTemplatePanel] Failed to load templates:', err);
      setError('Failed to load workflow templates');
    } finally {
      setLoading(false);
    }
  };

  const handleDragStart = (template: WorkflowTemplate) => {
    console.log('[WorkflowTemplatePanel] Drag started:', template.label);
  };

  if (!workflowCatalogEnabled) {
    return (
      <div className="absolute left-4 top-24 z-10">
        <Button
          variant="outline"
          size="sm"
          onClick={onToggle}
          className="shadow-glass backdrop-blur-sm bg-card/80"
          title="Enable Workflow Catalog in Settings"
        >
          <Sparkles className="h-4 w-4 text-muted-foreground" />
        </Button>
      </div>
    );
  }

  return (
    <>
      {/* Toggle Button (shown when panel is closed) */}
      {!isOpen && (
        <div className="absolute left-4 top-24 z-10">
          <Button
            variant="outline"
            size="sm"
            onClick={onToggle}
            className="shadow-glass backdrop-blur-sm bg-card/80"
            title="Show Workflow Templates"
          >
            <Sparkles className="h-4 w-4 mr-2" />
            Workflows
          </Button>
        </div>
      )}

      {/* Sidebar Panel */}
      {isOpen && (
        <div className="absolute left-4 top-24 z-10 w-64 bg-card/95 backdrop-blur-sm border border-border rounded-lg shadow-lg overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between p-3 border-b border-border bg-card">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <h2 className="font-semibold text-sm">Workflow Templates</h2>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggle}
              className="h-6 w-6 p-0"
              title="Hide Panel"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>

          {/* Content */}
          <div className="p-3 space-y-2 max-h-[calc(100vh-200px)] overflow-y-auto">
            {loading && (
              <div className="text-sm text-muted-foreground text-center py-8">
                Loading templates...
              </div>
            )}

            {error && (
              <div className="text-sm text-destructive text-center py-4">
                {error}
              </div>
            )}

            {!loading && !error && templates.length === 0 && (
              <div className="text-sm text-muted-foreground text-center py-8">
                <p className="mb-2">No templates available</p>
                <p className="text-xs">
                  Load the catalog from Settings → Workflows
                </p>
              </div>
            )}

            {!loading && !error && templates.length > 0 && (
              <>
                <p className="text-xs text-muted-foreground mb-3">
                  Drag a template onto the canvas to create a workflow instance
                </p>
                {templates.map((template) => (
                  <WorkflowTemplateCard
                    key={template.iri}
                    template={template}
                    onDragStart={handleDragStart}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
};
