Denkprozess

Fast Clustering Algorithms for React Flow

Since you already have React Flow, you just need pure algorithm implementations. Here are the fastest options:
1. graphology + graphology-communities-louvain (Best Choice)
npm install graphology graphology-communities-louvain

Why: Fast, modular, easy to integrate with React Flow data.

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

function clusterReactFlowGraph(nodes, edges) {
  const graph = new Graph();
  
  // Convert React Flow to graphology
  nodes.forEach(node => graph.addNode(node.id));
  edges.forEach(edge => graph.addEdge(edge.source, edge.target));
  
  // Run Louvain clustering
  const clusters = louvain(graph);
  
  // Map back to React Flow nodes
  return nodes.map(node => ({
    ...node,
    data: { ...node.data, cluster: clusters[node.id] }
  }));
}

2. ngraph.louvain (Fastest for Large Graphs)
npm install ngraph.graph ngraph.louvain

Very performant for 10k+ nodes:

import createGraph from 'ngraph.graph';
import louvain from 'ngraph.louvain';

function fastCluster(nodes, edges) {
  const graph = createGraph();
  
  nodes.forEach(n => graph.addNode(n.id));
  edges.forEach(e => graph.addLink(e.source, e.target));
  
  const communities = louvain(graph);
  
  return nodes.map(node => ({
    ...node,
    data: { ...node.data, cluster: communities[node.id] }
  }));
}

3. jLouvain (Standalone, No Dependencies)
npm install jlouvain

Minimal footprint:

import jLouvain from 'jlouvain';

function clusterWithJLouvain(nodes, edges) {
  const nodeIds = nodes.map(n => n.id);
  const edgeList = edges.map(e => ({ source: e.source, target: e.target, weight: 1 }));
  
  const community = jLouvain()
    .nodes(nodeIds)
    .edges(edgeList);
    
  const clusters = community();
  
  return nodes.map(node => ({
    ...node,
    data: { ...node.data, cluster: clusters[node.id] }
  }));
}

4. Connected Components (Fastest - O(V+E))

If you just need basic connectivity clustering:
npm install graphology graphology-components

import Graph from 'graphology';
import { connectedComponents } from 'graphology-components';

function findConnectedClusters(nodes, edges) {
  const graph = new Graph({ type: 'undirected' });
  
  nodes.forEach(n => graph.addNode(n.id));
  edges.forEach(e => graph.addEdge(e.source, e.target));
  
  const clusters = connectedComponents(graph);
  
  return nodes.map(node => ({
    ...node,
    data: { ...node.data, cluster: clusters[node.id] }
  }));
}

Performance Comparison
Algorithm	Time Complexity	Best For	Speed (10k nodes)
Connected Components	O(V+E)	Disconnected graphs	~50ms
Louvain (ngraph)	O(V log V)	Community detection	~200ms
Louvain (graphology)	O(V log V)	General purpose	~300ms
Label Propagation	O(V+E)	Quick clustering	~100ms
Complete React Flow Integration Example

import { useState, useMemo } from 'react';
import ReactFlow from 'reactflow';
import createGraph from 'ngraph.graph';
import louvain from 'ngraph.louvain';

function FlowWithClustering() {
  const [nodes, setNodes] = useState([/* your nodes */]);
  const [edges, setEdges] = useState([/* your edges */]);
  
  // Compute clusters when graph changes
  const clusteredNodes = useMemo(() => {
    const graph = createGraph();
    nodes.forEach(n => graph.addNode(n.id));
    edges.forEach(e => graph.addLink(e.source, e.target));
    
    const clusters = louvain(graph);
    
    return nodes.map(node => ({
      ...node,
      data: { 
        ...node.data, 
        cluster: clusters[node.id] 
      },
      style: {
        ...node.style,
        backgroundColor: getClusterColor(clusters[node.id])
      }
    }));
  }, [nodes, edges]);
  
  return <ReactFlow nodes={clusteredNodes} edges={edges} />;
}

Which algorithm fits your use case?

    Simple connectivity: Connected Components
    Community detection: Louvain (ngraph or graphology)
    Maximum speed: ngraph.louvain

