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
  const ghostRef = React.useRef<HTMLDivElement | null>(null);
  const cardRef = React.useRef<HTMLDivElement | null>(null);

  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('application/vg-workflow-template', template.iri);
    onDragStart(template);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    onDragStart(template);

    const card = cardRef.current;
    const ghost = document.createElement('div');
    ghost.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 9999;
      opacity: 0.8;
      width: ${card ? card.offsetWidth : 200}px;
      left: ${touch.clientX - (card ? card.offsetWidth / 2 : 100)}px;
      top: ${touch.clientY - 20}px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.2);
      font-size: 14px;
      font-weight: 500;
    `;
    ghost.textContent = template.label;
    document.body.appendChild(ghost);
    ghostRef.current = ghost;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    e.preventDefault();
    const touch = e.touches[0];
    const ghost = ghostRef.current;
    if (ghost) {
      ghost.style.left = `${touch.clientX - parseInt(ghost.style.width) / 2}px`;
      ghost.style.top = `${touch.clientY - 20}px`;
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const touch = e.changedTouches[0];
    ghostRef.current?.remove();
    ghostRef.current = null;

    document.dispatchEvent(new CustomEvent('vg-workflow-touch-drop', {
      bubbles: true,
      detail: { iri: template.iri, clientX: touch.clientX, clientY: touch.clientY },
    }));
  };

  return (
    <Card
      ref={cardRef}
      draggable
      onDragStart={handleDragStart}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      className="p-3 cursor-grab active:cursor-grabbing hover:shadow-md transition-shadow border-border bg-card touch-none"
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
