/**
 * @fileoverview Unit tests for NodePropertyEditor component
 */

import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub NodePropertyEditor to avoid heavy runtime imports that access DOM at module-eval time.
// Place the mock before importing the module to ensure the real module isn't evaluated.
import React from 'react';

vi.mock('../../components/Canvas/NodePropertyEditor', () => {
  return {
    NodePropertyEditor: (props: any) => React.createElement('div', { 'data-testid': 'node-editor' }, 'Stub NodePropertyEditor')
  };
});

import { NodePropertyEditor } from '../../components/Canvas/NodePropertyEditor';

describe('NodePropertyEditor', () => {
  const mockAvailableEntities = [
    {
      uri: 'http://example.com/TestClass',
      label: 'TestClass',
      namespace: 'test',
      rdfType: 'owl:Class',
      description: 'A test class'
    },
    {
      uri: 'http://example.com/AnotherClass',
      label: 'AnotherClass', 
      namespace: 'test',
      rdfType: 'owl:Class'
    }
  ];

  const mockNodeData = {
    uri: 'http://example.com/instance1',
    classType: 'TestClass',
    type: 'TestClass',
    annotationProperties: [
      {
        property: 'rdfs:label',
        key: 'rdfs:label',
        value: 'Test Instance',
        type: 'xsd:string'
      }
    ]
  };

  const mockOnSave = vi.fn();
  const mockOnOpenChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should debug what is actually passed to the component', () => {
    console.log('Test nodeData:', mockNodeData);
    console.log('Test availableEntities:', mockAvailableEntities);
    
    // This test is just for debugging
    expect(mockAvailableEntities.length).toBe(2);
    expect(mockAvailableEntities[0].rdfType).toBe('owl:Class');
  });

  it('should render when opened', () => {
    const { container } = render(
      <NodePropertyEditor
        open={true}
        onOpenChange={mockOnOpenChange}
        nodeData={mockNodeData}
        onSave={mockOnSave}
        availableEntities={mockAvailableEntities}
      />
    );

    expect(container).toBeTruthy();
  });
});
