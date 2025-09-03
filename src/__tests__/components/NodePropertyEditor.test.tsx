/**
 * @fileoverview Unit tests for NodePropertyEditor component
 */

import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NodePropertyEditor } from '../../components/Canvas/NodePropertyEditor';

// Mock the ontology store
vi.mock('../../stores/ontologyStore', () => ({
  useOntologyStore: () => ({
    availableClasses: [
      {
        label: 'TestClass',
        uri: 'http://example.com/TestClass',
        namespace: 'test',
        properties: ['rdfs:label', 'rdfs:comment']
      }
    ]
  })
}));

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