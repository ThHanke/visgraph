/**
 * Pure tree-building utilities adapted from @reactodia/workspace ClassTree internals.
 * These functions are not exported by reactodia so we re-implement them here.
 */
import type { ElementTypeGraph, ElementTypeIri, ElementTypeModel } from '@reactodia/workspace';

export interface TreeNode {
  readonly iri: ElementTypeIri;
  readonly data: ElementTypeModel | undefined;
  readonly label: string;
  readonly derived: ReadonlyArray<TreeNode>;
}

export const TreeNode = {
  setDerived: (node: TreeNode, derived: ReadonlyArray<TreeNode>): TreeNode => ({ ...node, derived }),
};

interface ClassTreeItem extends ElementTypeModel {
  children: ClassTreeItem[];
}

/**
 * Build a hierarchical tree from a flat ElementTypeGraph.
 * `getLabel(id, model)` converts an ElementTypeModel into a display string.
 * Detects and removes cycles before building parent/child relationships.
 */
export function buildClassTree(
  graph: ElementTypeGraph,
  getLabel: (id: ElementTypeIri, model: ElementTypeModel | undefined) => string
): TreeNode[] {
  const items = new Map<ElementTypeIri, ClassTreeItem>();
  for (const model of graph.elementTypes) {
    items.set(model.id, { ...model, children: [] });
  }

  const childToParents = new Map<ElementTypeIri, Set<ElementTypeIri>>();
  for (const [childId, parentId] of graph.subtypeOf) {
    let parents = childToParents.get(childId);
    if (!parents) { parents = new Set(); childToParents.set(childId, parents); }
    parents.add(parentId);
  }

  // Detect and remove cycles via DFS
  const edgesToDelete: [ElementTypeIri, ElementTypeIri][] = [];
  const visiting = new Set<ElementTypeIri>();
  const visited = new Set<ElementTypeIri>();
  const visit = (id: ElementTypeIri) => {
    if (visited.has(id)) return;
    visiting.add(id);
    const parents = childToParents.get(id);
    if (parents) {
      for (const parentId of parents) {
        if (visiting.has(parentId)) {
          edgesToDelete.push([id, parentId]);
        } else {
          visit(parentId);
        }
      }
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of items.keys()) visit(id);
  for (const [childId, parentId] of edgesToDelete) {
    childToParents.get(childId)?.delete(parentId);
  }

  // Assign children to parents; collect roots
  const roots: ClassTreeItem[] = [];
  for (const item of items.values()) {
    const parents = childToParents.get(item.id);
    if (!parents || parents.size === 0) {
      roots.push(item);
    } else {
      for (const parentId of parents) {
        items.get(parentId)?.children.push(item);
      }
    }
  }

  // Convert to TreeNode tree
  const mapItem = (item: ClassTreeItem): TreeNode => ({
    iri: item.id,
    data: item,
    label: getLabel(item.id, item),
    derived: item.children.map(mapItem),
  });
  return roots.map(mapItem);
}

/**
 * Keep only nodes whose label contains `searchText` (case-insensitive),
 * or whose descendants contain a match. Empty string returns the original array.
 */
export function filterTreeByKeyword(
  roots: ReadonlyArray<TreeNode>,
  searchText: string
): ReadonlyArray<TreeNode> {
  if (!searchText) return roots;
  const lc = searchText.toLowerCase();
  const collect = (acc: TreeNode[], node: TreeNode): TreeNode[] => {
    const derived = node.derived.reduce(collect, []);
    if (derived.length > 0 || node.label.toLowerCase().includes(lc)) {
      acc.push(TreeNode.setDerived(node, derived));
    }
    return acc;
  };
  return roots.reduce(collect, []);
}

/** Sort tree nodes alphabetically by label at every level. */
export function sortTree(roots: ReadonlyArray<TreeNode>): ReadonlyArray<TreeNode> {
  const mapNode = (node: TreeNode): TreeNode =>
    TreeNode.setDerived(node, sortTree(node.derived));
  return [...roots].map(mapNode).sort((a, b) => a.label.localeCompare(b.label));
}
