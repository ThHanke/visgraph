/**
 * @fileoverview GoJS Template Manager
 * Creates and manages node and link templates for the knowledge graph visualization.
 * Handles the visual appearance and interactive behavior of diagram elements.
 */

import * as go from 'gojs';
import { NodeTemplateConfig, LinkTemplateConfig } from '../../../types/canvas';

/**
 * Manages GoJS templates for nodes, links, and groups
 */
export class TemplateManager {
  private nodeConfig: NodeTemplateConfig;
  private linkConfig: LinkTemplateConfig;

  /**
   * Creates a new TemplateManager instance
   * 
   * @param nodeConfig - Configuration for node templates
   * @param linkConfig - Configuration for link templates
   */
  constructor(
    nodeConfig: Partial<NodeTemplateConfig> = {},
    linkConfig: Partial<LinkTemplateConfig> = {}
  ) {
    // Default node configuration
    this.nodeConfig = {
      defaultSize: { width: 200, height: 120 },
      headerHeight: 40,
      colors: {
        background: '#ffffff',
        headerBackground: '#2E8B57',
        headerText: '#ffffff',
        bodyText: '#333333',
        border: '#888888',
      },
      fonts: {
        header: 'bold 12px Inter, sans-serif',
        body: '11px Inter, sans-serif',
      },
      ...nodeConfig,
    };

    // Default link configuration
    this.linkConfig = {
      strokeWidth: 2,
      arrowSize: 8,
      label: {
        font: '10px Inter, sans-serif',
        background: 'rgba(255, 255, 255, 0.9)',
        offset: new go.Point(0, -10),
      },
      colors: {
        default: '#64748b',
        hover: '#7c3aed',
        selected: '#7c3aed',
        error: '#ef4444',
      },
      ...linkConfig,
    };
  }

  /**
   * Creates the node template for knowledge graph entities
   * 
   * @returns GoJS node template
   */
  public createNodeTemplate(): go.Node {
    const $ = go.GraphObject.make;

    return $(go.Node, 'Auto',
      {
        selectionAdorned: true,
        resizable: true,
        locationSpot: go.Spot.Center,
        locationObjectName: 'BODY',
        // Tooltip
        toolTip: this.createNodeTooltip(),
        // Selection adornment
        selectionAdornmentTemplate: this.createNodeSelectionAdornment(),
      },

      // Main shape with rounded border
      $(go.Shape, 'RoundedRectangle',
        {
          fill: this.nodeConfig.colors.background,
          stroke: this.nodeConfig.colors.border,
          strokeWidth: 1,
          name: 'SHAPE'
        },
        new go.Binding('fill', 'backgroundColor', (color) => color || this.nodeConfig.colors.background),
        new go.Binding('stroke', 'hasReasoningError', (hasError) => 
          hasError ? '#ef4444' : this.nodeConfig.colors.border
        )
      ),

      // Main panel containing header and body
      $(go.Panel, 'Vertical',
        {
          stretch: go.GraphObject.Fill,
          name: 'BODY'
        },

        // Header panel
        this.createNodeHeader(),

        // Body panel with properties
        this.createNodeBody()
      ),

      // Position binding
      new go.Binding('location', 'loc', go.Point.parse).makeTwoWay(go.Point.stringify),
      new go.Binding('visible', 'visible', (vis) => vis !== false)
    );
  }

  /**
   * Creates the node header with entity information
   * 
   * @returns GoJS panel for the node header
   */
  private createNodeHeader(): go.Panel {
    const $ = go.GraphObject.make;

    return $(go.Panel, 'Auto',
      {
        stretch: go.GraphObject.Horizontal,
        height: this.nodeConfig.headerHeight,
      },
      // Header background
      $(go.Shape, 'Rectangle',
        {
          fill: this.nodeConfig.colors.headerBackground,
          stroke: null,
          name: 'HEADER_SHAPE'
        },
        new go.Binding('fill', '', (data) => {
          // Get namespace color
          const color = this.getNamespaceColor(data.namespace);
          return color || this.nodeConfig.colors.headerBackground;
        })
      ),
      // Header text
      $(go.TextBlock,
        {
          margin: new go.Margin(6, 8),
          font: this.nodeConfig.fonts.header,
          stroke: this.nodeConfig.colors.headerText,
          textAlign: 'center',
          wrap: go.TextBlock.WrapFit,
          maxSize: new go.Size(180, this.nodeConfig.headerHeight - 12),
          overflow: go.TextOverflow.Ellipsis
        },
        new go.Binding('text', '', this.formatNodeHeaderText.bind(this))
      )
    );
  }

  /**
   * Creates the node body with annotation properties
   * 
   * @returns GoJS panel for the node body
   */
  private createNodeBody(): go.Panel {
    const $ = go.GraphObject.make;

    return $(go.Panel, 'Table',
      {
        stretch: go.GraphObject.Fill,
        defaultRowSeparatorStroke: '#ddd',
        padding: new go.Margin(6, 8, 8, 8),
        name: 'PROPERTIES_TABLE'
      },
      new go.Binding('itemArray', '', this.formatNodeProperties.bind(this)),
      {
        itemTemplate: this.createPropertyRowTemplate()
      }
    );
  }

  /**
   * Creates a template for property rows in the node body
   * 
   * @returns GoJS panel for property rows
   */
  private createPropertyRowTemplate(): go.Panel {
    const $ = go.GraphObject.make;

    return $(go.Panel, 'TableRow',
      $(go.TextBlock,
        {
          column: 0,
          margin: new go.Margin(2, 4, 2, 0),
          font: this.nodeConfig.fonts.body,
          stroke: '#666666',
          alignment: go.Spot.Left,
          maxSize: new go.Size(80, NaN),
          overflow: go.TextOverflow.Ellipsis,
          isMultiline: false
        },
        new go.Binding('text', 'key')
      ),
      $(go.TextBlock,
        {
          column: 1,
          margin: new go.Margin(2, 0, 2, 4),
          font: this.nodeConfig.fonts.body,
          stroke: this.nodeConfig.colors.bodyText,
          alignment: go.Spot.Left,
          maxSize: new go.Size(100, NaN),
          overflow: go.TextOverflow.Ellipsis,
          isMultiline: false
        },
        new go.Binding('text', 'value')
      )
    );
  }

  /**
   * Creates a tooltip for nodes
   * 
   * @returns GoJS adornment for node tooltips
   */
  private createNodeTooltip(): go.Adornment {
    const $ = go.GraphObject.make;

    return $(go.Adornment, 'Auto',
      {
        maxSize: new go.Size(300, 200)
      },
      $(go.Shape, 'RoundedRectangle',
        {
          fill: '#fefce8',
          stroke: '#facc15',
          strokeWidth: 2
        }
      ),
      $(go.Panel, 'Vertical',
        { margin: 8 },
        $(go.TextBlock,
          {
            font: 'bold 11px Inter, sans-serif',
            stroke: '#a16207',
            maxSize: new go.Size(280, NaN),
            wrap: go.TextBlock.WrapFit
          },
          new go.Binding('text', 'uri', (uri) => `URI: ${uri || 'unknown'}`)
        ),
        $(go.TextBlock,
          {
            font: '10px Inter, sans-serif',
            stroke: '#a16207',
            margin: new go.Margin(2, 0, 0, 0),
            maxSize: new go.Size(280, NaN),
            wrap: go.TextBlock.WrapFit
          },
          new go.Binding('text', 'rdfType', (type) => `Type: ${type || 'unknown'}`)
        )
      )
    );
  }

  /**
   * Creates selection adornment for nodes
   * 
   * @returns GoJS adornment for node selection
   */
  private createNodeSelectionAdornment(): go.Adornment {
    const $ = go.GraphObject.make;

    return $(go.Adornment, 'Spot',
      $(go.Panel, 'Auto',
        $(go.Shape, 'RoundedRectangle',
          {
            fill: null,
            stroke: '#00A9C9',
            strokeWidth: 2
          }
        ),
        $(go.Placeholder, { padding: 4 })
      ),
      // Action buttons
      $(go.Panel, 'Horizontal',
        {
          alignment: go.Spot.TopRight,
          alignmentFocus: go.Spot.TopRight,
          margin: new go.Margin(2)
        },
        // Edit button
        $('Button',
          {
            'ButtonBorder.fill': 'transparent',
            'ButtonBorder.stroke': null,
            '_buttonFillOver': 'rgba(0, 169, 201, 0.1)',
            click: this.handleEditNodeClick.bind(this)
          },
          $(go.TextBlock, '✎', { font: '12px sans-serif', stroke: '#00A9C9' })
        ),
        // Add annotation button
        $('Button',
          {
            'ButtonBorder.fill': 'transparent',
            'ButtonBorder.stroke': null,
            '_buttonFillOver': 'rgba(0, 169, 201, 0.1)',
            click: this.handleAddAnnotationClick.bind(this)
          },
          $(go.TextBlock, '+A', { font: '12px sans-serif', stroke: '#00A9C9' })
        )
      )
    );
  }

  /**
   * Creates the link template for property connections
   * 
   * @returns GoJS link template
   */
  public createLinkTemplate(): go.Link {
    const $ = go.GraphObject.make;

    return $(go.Link,
      {
        routing: go.Link.AvoidsNodes,
        curve: go.Link.JumpOver,
        corner: 5,
        selectionAdornmentTemplate: this.createLinkSelectionAdornment(),
        toolTip: this.createLinkTooltip(),
        // Mouse interaction handlers
        mouseEnter: this.handleLinkMouseEnter.bind(this),
        mouseLeave: this.handleLinkMouseLeave.bind(this),
        doubleClick: this.handleLinkDoubleClick.bind(this)
      },
      // Link shape
      $(go.Shape,
        {
          name: 'SHAPE',
          strokeWidth: this.linkConfig.strokeWidth,
          stroke: this.linkConfig.colors.default
        },
        new go.Binding('stroke', 'hasReasoningError', (hasError) =>
          hasError ? this.linkConfig.colors.error : this.linkConfig.colors.default
        )
      ),
      // Arrow head
      $(go.Shape,
        {
          name: 'ARROWHEAD',
          toArrow: 'Standard',
          fill: this.linkConfig.colors.default,
          stroke: null,
          scale: this.linkConfig.arrowSize / 8
        },
        new go.Binding('fill', 'hasReasoningError', (hasError) =>
          hasError ? this.linkConfig.colors.error : this.linkConfig.colors.default
        )
      ),
      // Label
      $(go.TextBlock,
        {
          name: 'LABEL',
          segmentIndex: 0,
          segmentFraction: 0.5,
          segmentOffset: this.linkConfig.label.offset,
          background: this.linkConfig.label.background,
          font: this.linkConfig.label.font,
          stroke: '#1e293b',
          margin: new go.Margin(3, 6, 3, 6),
          maxSize: new go.Size(120, NaN),
          overflow: go.TextOverflow.Ellipsis,
          textAlign: 'center'
        },
        new go.Binding('text', 'label')
      )
    );
  }

  /**
   * Creates a tooltip for links
   * 
   * @returns GoJS adornment for link tooltips
   */
  private createLinkTooltip(): go.Adornment {
    const $ = go.GraphObject.make;

    return $(go.Adornment, 'Auto',
      $(go.Shape, { fill: '#fefce8', stroke: '#facc15', strokeWidth: 2 }),
      $(go.Panel, 'Vertical',
        { margin: 8 },
        $(go.TextBlock,
          {
            font: 'bold 11px Inter, sans-serif',
            stroke: '#a16207',
            maxSize: new go.Size(250, NaN),
            wrap: go.TextBlock.WrapFit
          },
          new go.Binding('text', 'propertyUri', (uri) => `Property: ${uri || 'unknown'}`)
        ),
        $(go.TextBlock,
          {
            font: '10px Inter, sans-serif',
            stroke: '#a16207',
            margin: new go.Margin(2, 0, 0, 0),
            maxSize: new go.Size(250, NaN),
            wrap: go.TextBlock.WrapFit
          },
          new go.Binding('text', 'rdfType', (type) => `RDF Type: ${type || 'unknown'}`)
        )
      )
    );
  }

  /**
   * Creates selection adornment for links
   * 
   * @returns GoJS adornment for link selection
   */
  private createLinkSelectionAdornment(): go.Adornment {
    const $ = go.GraphObject.make;

    return $(go.Adornment, 'Link',
      $(go.Shape, {
        isPanelMain: true,
        stroke: this.linkConfig.colors.selected,
        strokeWidth: 3
      }),
      $(go.Shape, {
        toArrow: 'Standard',
        fill: this.linkConfig.colors.selected,
        stroke: null
      })
    );
  }

  /**
   * Creates a group template (for future use)
   * 
   * @returns GoJS group template
   */
  public createGroupTemplate(): go.Group {
    const $ = go.GraphObject.make;

    return $(go.Group, 'Auto',
      {
        background: 'transparent',
        ungroupable: true,
        // Compute the group's location as the average of its member nodes
        locationSpot: go.Spot.Center,
        selectionAdorned: false
      },
      $(go.Shape, 'RoundedRectangle',
        {
          fill: 'rgba(128, 128, 128, 0.1)',
          stroke: 'gray',
          strokeWidth: 1
        }
      ),
      $(go.Placeholder, { padding: 10 })
    );
  }

  // Event handlers and utility methods

  /**
   * Handles edit node button click
   */
  private handleEditNodeClick(e: go.InputEvent, button: go.GraphObject): void {
    const adornment = button.part as go.Adornment;
    const node = adornment?.adornedPart;
    if (node && node.data) {
      // Emit custom event for node editing
      const event = new CustomEvent('nodeEdit', { detail: node.data });
      document.dispatchEvent(event);
    }
  }

  /**
   * Handles add annotation button click
   */
  private handleAddAnnotationClick(e: go.InputEvent, button: go.GraphObject): void {
    const adornment = button.part as go.Adornment;
    const node = adornment?.adornedPart;
    if (node && node.data) {
      // Emit custom event for adding annotation
      const event = new CustomEvent('nodeAddAnnotation', { detail: node.data });
      document.dispatchEvent(event);
    }
  }

  /**
   * Handles link mouse enter
   */
  private handleLinkMouseEnter(e: go.InputEvent, link: go.GraphObject): void {
    const linkPart = link.part as go.Link;
    if (linkPart) {
      const shape = linkPart.findObject('SHAPE') as go.Shape;
      const arrow = linkPart.findObject('ARROWHEAD') as go.Shape;
      const label = linkPart.findObject('LABEL') as go.TextBlock;

      if (shape) {
        shape.stroke = this.linkConfig.colors.hover;
        shape.strokeWidth = 3;
      }
      if (arrow) arrow.fill = this.linkConfig.colors.hover;
      if (label) label.background = '#e0e7ff';

      // Change cursor
      if (linkPart.diagram && linkPart.diagram.div) {
        (linkPart.diagram.div as any).style.cursor = 'pointer';
      }
    }
  }

  /**
   * Handles link mouse leave
   */
  private handleLinkMouseLeave(e: go.InputEvent, link: go.GraphObject): void {
    const linkPart = link.part as go.Link;
    if (linkPart) {
      const hasError = linkPart.data.hasReasoningError;
      const shape = linkPart.findObject('SHAPE') as go.Shape;
      const arrow = linkPart.findObject('ARROWHEAD') as go.Shape;
      const label = linkPart.findObject('LABEL') as go.TextBlock;

      const defaultColor = hasError ? this.linkConfig.colors.error : this.linkConfig.colors.default;

      if (shape) {
        shape.stroke = defaultColor;
        shape.strokeWidth = this.linkConfig.strokeWidth;
      }
      if (arrow) arrow.fill = defaultColor;
      if (label) label.background = this.linkConfig.label.background;

      // Reset cursor
      if (linkPart.diagram && linkPart.diagram.div) {
        (linkPart.diagram.div as any).style.cursor = 'auto';
      }
    }
  }

  /**
   * Handles link double click
   */
  private handleLinkDoubleClick(e: go.InputEvent, link: go.GraphObject): void {
    const linkPart = link.part as go.Link;
    if (linkPart && linkPart.data) {
      // Emit custom event for link editing
      const event = new CustomEvent('linkEdit', { detail: linkPart.data });
      document.dispatchEvent(event);
    }
  }

  /**
   * Formats the node header text
   */
  private formatNodeHeaderText(data: any): string {
    const uri = data.uri || data.iri;
    let shortUri = 'unknown';
    if (uri) {
      const parts = uri.split(/[/#]/);
      shortUri = parts[parts.length - 1] || parts[parts.length - 2] || uri;
    }

    let type = '';
    // For A-box view, show the actual semantic type
    if (data.entityType === 'individual' && data.rdfTypes) {
      const meaningfulType = data.rdfTypes.find((t: string) =>
        !t.includes('NamedIndividual')
      );
      if (meaningfulType) {
        type = this.shortenURI(meaningfulType);
      }
    } else {
      type = data.rdfType || 'unknown:type';
    }

    return `${shortUri} — ${type}`;
  }

  /**
   * Formats node properties for display
   */
  private formatNodeProperties(data: any): Array<{ key: string; value: string }> {
    const properties = [];

    if (data.annotationProperties) {
      data.annotationProperties.forEach((prop: any) => {
        properties.push({
          key: this.shortenURI(prop.property),
          value: prop.value
        });
      });
    }

    return properties.slice(0, 5); // Limit to 5 properties
  }

  /**
   * Gets color for a namespace
   */
  private getNamespaceColor(namespace: string): string {
    const colors = [
      '#2E8B57', '#4169E1', '#DC143C', '#FF8C00', '#9932CC',
      '#228B22', '#B22222', '#4682B4', '#D2691E', '#6B8E23'
    ];
    
    if (!namespace) return colors[0];
    
    let hash = 0;
    for (let i = 0; i < namespace.length; i++) {
      hash = namespace.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }

  /**
   * Shortens a URI using common prefixes
   */
  private shortenURI(uri: string): string {
    const prefixMap = {
      'https://spec.industrialontologies.org/ontology/core/Core/': 'iof:',
      'http://www.w3.org/2002/07/owl#': 'owl:',
      'http://www.w3.org/2000/01/rdf-schema#': 'rdfs:',
      'http://www.w3.org/1999/02/22-rdf-syntax-ns#': 'rdf:',
      'https://github.com/Mat-O-Lab/IOFMaterialsTutorial/': ':'
    };

    for (const [namespace, prefix] of Object.entries(prefixMap)) {
      if (uri.startsWith(namespace)) {
        return uri.replace(namespace, prefix);
      }
    }

    return uri;
  }
}