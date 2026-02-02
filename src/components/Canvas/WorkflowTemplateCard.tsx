/**
 * @fileoverview Workflow Template Card Component
 * Draggable card representing a workflow template
 */

import React from 'react';
import { Card } from '../ui/card';
import { Badge } from '../ui/badge';
import { GripVertical, Workflow } from 'lucide-react';
import type { WorkflowTemplate } from '../../utils/workflowInstantiator';

interface WorkflowTemplateCardProps {
  template: WorkflowTemplate;
  onDragStart: (template: WorkflowTemplate) => void;
}

export const WorkflowTemplateCard: React.FC<WorkflowTemplateCardProps> = ({
  template,
  onDragStart,
}) => {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/vg-workflow-template', template.iri);
    onDragStart(template);
  };

  return (
    <Card
      draggable
      onDragStart={handleDragStart}
      className="p-3 cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow border-border bg-card"
    >
      <div className="flex items-start gap-2">
        <GripVertical className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Workflow className="h-4 w-4 text-primary shrink-0" />
            <h3 className="font-medium text-sm truncate">{template.label}</h3>
          </div>
          {template.description && (
            <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
              {template.description}
            </p>
          )}
          <div className="flex flex-wrap gap-1">
            {template.inputVars.length > 0 && (
              <Badge variant="outline" className="text-xs px-1.5 py-0">
                {template.inputVars.length} input{template.inputVars.length !== 1 ? 's' : ''}
              </Badge>
            )}
            {template.outputVars.length > 0 && (
              <Badge variant="outline" className="text-xs px-1.5 py-0">
                {template.outputVars.length} output{template.outputVars.length !== 1 ? 's' : ''}
              </Badge>
            )}
            {template.steps.length > 0 && (
              <Badge variant="secondary" className="text-xs px-1.5 py-0">
                {template.steps.length} step{template.steps.length !== 1 ? 's' : ''}
              </Badge>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
};
