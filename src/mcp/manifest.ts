// src/mcp/manifest.ts
import type { McpToolManifestEntry } from './types';

export const mcpManifest: McpToolManifestEntry[] = [
  {
    name: 'loadRdf',
    description: 'Load RDF data into the canvas from a URL or a Turtle string.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        turtle: { type: 'string' },
      },
      oneOf: [
        { required: ['url'] },
        { required: ['turtle'] },
      ],
    },
  },
  {
    name: 'loadOntology',
    description: 'Load an ontology by URL into the TBox. Feeds domain/range autocomplete and OWL-RL reasoning.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'queryGraph',
    description: 'Run a SPARQL SELECT query against the in-memory RDF store. Returns rows as JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        sparql: { type: 'string' },
      },
      required: ['sparql'],
    },
  },
  {
    name: 'exportGraph',
    description: 'Export the current RDF graph as Turtle, JSON-LD, or RDF-XML.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['turtle', 'jsonld', 'rdfxml'] },
      },
      required: ['format'],
    },
  },
  {
    name: 'exportImage',
    description: 'Export the canvas as an SVG string or a PNG data URI.',
    inputSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['svg', 'png'] },
      },
      required: ['format'],
    },
  },
  {
    name: 'addNode',
    description: 'Add an entity (node) to the canvas by IRI, with an optional RDF type and label.',
    inputSchema: {
      type: 'object',
      properties: {
        iri: { type: 'string' },
        typeIri: { type: 'string' },
        label: { type: 'string' },
      },
      required: ['iri'],
    },
  },
  {
    name: 'removeNode',
    description: 'Remove an entity and all its triples from the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        iri: { type: 'string' },
      },
      required: ['iri'],
    },
  },
  {
    name: 'getNodes',
    description: 'Return entities currently on the canvas. Optionally filter by type IRI or label substring.',
    inputSchema: {
      type: 'object',
      properties: {
        typeIri: { type: 'string' },
        labelContains: { type: 'string' },
        limit: { type: 'integer', default: 100 },
      },
    },
  },
  {
    name: 'addLink',
    description: 'Add a triple (directed edge) between two entities.',
    inputSchema: {
      type: 'object',
      properties: {
        subjectIri: { type: 'string' },
        predicateIri: { type: 'string' },
        objectIri: { type: 'string' },
      },
      required: ['subjectIri', 'predicateIri', 'objectIri'],
    },
  },
  {
    name: 'removeLink',
    description: 'Remove a triple (edge) between two entities.',
    inputSchema: {
      type: 'object',
      properties: {
        subjectIri: { type: 'string' },
        predicateIri: { type: 'string' },
        objectIri: { type: 'string' },
      },
      required: ['subjectIri', 'predicateIri', 'objectIri'],
    },
  },
  {
    name: 'getLinks',
    description: 'Return edges currently in the graph.',
    inputSchema: {
      type: 'object',
      properties: {
        subjectIri: { type: 'string' },
        predicateIri: { type: 'string' },
        objectIri: { type: 'string' },
        limit: { type: 'integer', default: 100 },
      },
    },
  },
  {
    name: 'searchEntities',
    description: 'Search entities in the loaded graph by label or IRI substring. Returns IRI + label pairs the AI can use to pick real IRIs before adding nodes or links.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', default: 20 },
      },
      required: ['query'],
    },
  },
  {
    name: 'autocomplete',
    description: 'Autocomplete entity IRIs from the loaded graph — augments lookups so the AI can resolve partial names to full IRIs before authoring.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        limit: { type: 'integer', default: 10 },
      },
      required: ['text'],
    },
  },
  {
    name: 'runLayout',
    description: 'Apply a layout algorithm to reposition nodes on the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        algorithm: {
          type: 'string',
          enum: ['dagre-lr', 'dagre-tb', 'elk-layered', 'elk-force', 'elk-stress', 'elk-radial'],
        },
      },
      required: ['algorithm'],
    },
  },
  {
    name: 'runReasoning',
    description: 'Run OWL-RL inference over the loaded graph. Returns the count of new inferred triples.',
    inputSchema: {
      type: 'object',
    },
  },
  {
    name: 'clearInferred',
    description: 'Remove all inferred (OWL-RL derived) triples from the graph.',
    inputSchema: {
      type: 'object',
    },
  },
  {
    name: 'getCapabilities',
    description: 'Return available layout algorithms, export formats, and loaded ontologies.',
    inputSchema: {
      type: 'object',
    },
  },
];
