/**
 * @fileoverview Reactodia ElementTemplate for prov:Activity nodes.
 * Renders the same as RdfElementTemplate but adds a play button.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import * as Reactodia from '@reactodia/workspace';
import { RdfElementTemplate } from './RdfElementTemplate';
import { executeActivity } from '../utils/executeActivity';
import { toast } from 'sonner';

function ProvActivityBody({ props }: { props: Reactodia.TemplateProps }) {
  const { element } = props;
  const { model } = Reactodia.useWorkspace();
  const [isExecuting, setIsExecuting] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const handlePlay = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!(element instanceof Reactodia.EntityElement)) return;

    setIsExecuting(true);
    try {
      let nextIri: string | null = element.data.id;
      while (nextIri && mountedRef.current) {
        nextIri = await executeActivity(nextIri, model);
      }
      if (mountedRef.current) toast.success('Activity executed successfully');
    } catch (err) {
      if (mountedRef.current) toast.error(err instanceof Error ? err.message : 'Execution failed');
    } finally {
      if (mountedRef.current) setIsExecuting(false);
    }
  }, [element, model]);

  const baseRender = RdfElementTemplate.renderElement(props);

  return (
    <div style={{ position: 'relative' }}>
      {baseRender}
      <button
        onClick={handlePlay}
        disabled={isExecuting}
        title={isExecuting ? 'Executing\u2026' : 'Execute activity'}
        style={{
          position: 'absolute',
          top: 4,
          right: 6,
          width: 26,
          height: 26,
          borderRadius: 5,
          border: 'none',
          cursor: isExecuting ? 'not-allowed' : 'pointer',
          background: isExecuting ? '#9ca3af' : '#7c3aed',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
          opacity: isExecuting ? 0.6 : 1,
          zIndex: 10,
        }}
      >
        {isExecuting ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" strokeLinecap="round"/>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
            <path d="M8 5v14l11-7z"/>
          </svg>
        )}
      </button>
    </div>
  );
}

export const ProvActivityTemplate: Reactodia.ElementTemplate = {
  renderElement: (props: Reactodia.TemplateProps) => <ProvActivityBody props={props} />,
  supports: {
    [Reactodia.TemplateProperties.Expanded]: true,
  },
};
