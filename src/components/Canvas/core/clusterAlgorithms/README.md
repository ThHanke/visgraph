# Clustering Algorithms

This directory contains different clustering algorithms for grouping nodes in the graph visualization.

## Available Algorithms

### 1. Louvain Community Detection (default) ⭐ RECOMMENDED
**File:** `louvainNgraph.ts`

**How it works:**
- Uses ngraph.louvain for community detection
- Finds natural communities based on modularity optimization
- Applies hierarchical coarsening to refine clusters
- Selects highest-connectivity node as cluster parent
- No cluster extension (communities are already optimized)

**Threshold parameter:**
- Minimum **community size** to create a cluster
- Filters out communities smaller than max(2, threshold)
- Recommended: 2-5 for small communities, 5-20 for larger communities

**Best for:**
- **Dense knowledge graphs** (most common use case)
- Large graphs (10k+ nodes)
- Natural community structure
- Dense interconnected regions
- General-purpose clustering

**Performance:** O(N log N) - Optimized for large graphs

---

### 2. Greedy Hierarchical
**File:** `../clusterHelpers.ts` - `computeClusters()`

**How it works:**
- Sorts nodes by connectivity (descending)
- For each high-connectivity node, creates a cluster if it has >= threshold outgoing edges
- Claims all target nodes
- Then extends clusters by absorbing weakly-connected adjacent nodes (connectivity <= 2)

**Threshold parameter:**
- Minimum number of **outgoing edges** required to create a cluster
- Recommended: 3-5 for medium graphs, 5-10 for large graphs

**Best for:**
- Star-like patterns (hubs with many connections)
- Manual clustering (respects collapsedSet)
- Specific use cases where you want hub-based clustering

**Performance:** O(E + N log N) - Good for medium graphs

---

### 3. Connected Components
**File:** `connectedComponents.ts`

**How it works:**
- Uses Union-Find (Disjoint Set) algorithm
- Groups nodes that are connected by any path
- Creates clusters for disconnected subgraphs
- No cluster extension needed

**Threshold parameter:**
- Minimum **component size** to create a cluster
- Filters out components smaller than max(2, threshold)
- Recommended: 2-10 depending on desired granularity

**Best for:**
- ⚠️ **Only disconnected graphs with isolated subgraphs**
- Network component analysis
- **NOT recommended for dense knowledge graphs** (creates huge clusters)

**Performance:** O(E × α(N)) ≈ O(E) - Very fast but unsuitable for dense graphs

**Warning:** In dense graphs, this algorithm groups ALL transitively connected nodes into the same cluster, often resulting in 1-2 massive clusters containing most of the graph. Use Louvain instead for dense graphs.

---

## Algorithm Selection

The algorithm is selected via the `algorithm` parameter in `applyClustering()`:

```typescript
applyClustering(nodes, edges, {
  threshold: 4,
  algorithm: "louvain" | "greedy" | "connected-components"
});
```

**Default:** `"louvain"` (recommended for most use cases)

## Quick Selection Guide

- 🌟 **Dense knowledge graphs?** → Use **Louvain** (default)
- ⭐ **Hub-and-spoke patterns?** → Use **Greedy**
- ⚠️ **Completely disconnected subgraphs?** → Use **Connected Components**

## Implementation Details

### Cluster Extension
- **Louvain:** No extension (communities already optimized)
- **Greedy:** Applies extension to absorb weakly-connected nodes
- **Connected Components:** No extension (components are by definition complete)

### Performance Comparison
| Algorithm | Time Complexity | Memory | Best For |
|-----------|----------------|---------|----------|
| **Louvain** | O(N log N) | Moderate-High | Dense graphs (RECOMMENDED) |
| **Greedy** | O(E + N log N) | Moderate | Hub patterns, manual control |
| **Connected Components** | O(E) | Low | Only disconnected graphs ⚠️ |

### When NOT to Use Each Algorithm
- **Louvain:** Rarely unsuitable - good general purpose choice
- **Greedy:** Not ideal for very large graphs (>50k nodes)
- **Connected Components:** ⚠️ **Never use for dense knowledge graphs** - creates massive clusters
