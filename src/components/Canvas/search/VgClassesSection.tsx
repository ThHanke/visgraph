import cx from 'clsx';
import * as React from 'react';
import { useCallback, useRef } from 'react';
import * as Reactodia from '@reactodia/workspace';
import { mapAbortedToNull, highlightSubstring } from '@reactodia/workspace';

import { TBOX_PROPERTY_TYPES } from '../../../providers/N3DataProvider';
import { useCanvasState } from '../../../hooks/useCanvasState';
import { useSearchIndexContext } from './SearchIndexContext';
import {
  buildClassTree,
  filterTreeByKeyword,
  sortTree,
  type TreeNode,
} from './treeUtils';

// CSS block names match vanilla ClassTree exactly so styles apply unchanged
const TREE = 'reactodia-class-tree';
const ITEM = 'reactodia-class-tree-item';

export interface VgClassesSectionProps {
  onEntityCreated?: (element: Reactodia.EntityElement) => void;
}

export function VgClassesSection({ onEntityCreated }: VgClassesSectionProps) {
  const { shouldRender, setSectionActive, searchStore } =
    Reactodia.useUnifiedSearchSection({ searchTimeout: 0 });

  const { classGraph, classHitCounts, searchText, setSearchText, setActiveFilter } =
    useSearchIndexContext();

  const { model, view, editor, getCommandBus, translation } = Reactodia.useWorkspace();
  const { state: canvasState } = useCanvasState();

  React.useEffect(() => {
    const handler = ({ source }: Reactodia.SearchInputStoreChangeValueEvent<string>) => {
      setSearchText(source.value);
    };
    searchStore.events.on('changeValue', handler);
    return () => searchStore.events.off('changeValue', handler);
  }, [searchStore, setSearchText]);

  const createCancellation = useRef(new AbortController());
  React.useEffect(() => {
    return () => { createCancellation.current.abort(); };
  }, []);

  const createInstanceAt = useCallback(
    async (iri: Reactodia.ElementTypeIri, dropEvent?: Reactodia.CanvasDropEvent) => {
      if (!editor.metadataProvider) return;
      const batch = model.history.startBatch();
      createCancellation.current.abort();
      createCancellation.current = new AbortController();
      const signal = createCancellation.current.signal;

      const created = await mapAbortedToNull(
        editor.metadataProvider.createEntity(iri, {
          translation,
          language: model.language,
          signal,
        }),
        signal
      );
      if (!created) return;

      const element = editor.createEntity(created.data);
      if (created.elementState) element.setElementState(created.elementState);

      let targetCanvas: Reactodia.CanvasApi | undefined;
      let targetPos: Reactodia.Vector | undefined;
      if (dropEvent) {
        targetCanvas = dropEvent.source;
        targetPos = dropEvent.position;
      } else {
        targetCanvas = view.findAnyCanvas();
        if (targetCanvas) {
          const pane = targetCanvas.metrics.pane;
          targetPos = targetCanvas.metrics.clientToPaperCoords(
            pane.clientWidth / 2,
            pane.clientHeight / 2
          );
        }
      }
      if (targetCanvas && targetPos) {
        element.setPosition(targetPos);
        targetCanvas.renderingState.syncUpdate();
        const size = targetCanvas.renderingState.getElementSize(element) ?? { width: 0, height: 0 };
        element.setPosition({
          x: targetPos.x - size.width / 2,
          y: targetPos.y - size.height / 2,
        });
      }

      batch.store();
      model.setSelection([element]);
      getCommandBus(Reactodia.VisualAuthoringTopic).trigger('editEntity', { target: element });
      onEntityCreated?.(element);
    },
    [model, view, editor, translation, getCommandBus, onEntityCreated]
  );

  const onClickCreate = useCallback(
    (node: TreeNode) => { void createInstanceAt(node.iri); },
    [createInstanceAt]
  );

  const onDragCreate = useCallback(
    (node: TreeNode) => {
      view.setHandlerForNextDropOnPaper(e => { void createInstanceAt(node.iri, e); });
    },
    [view, createInstanceAt]
  );

  const onSelectNode = useCallback(
    (node: TreeNode) => {
      const isProperty = TBOX_PROPERTY_TYPES.has(node.iri);
      setActiveFilter(
        isProperty
          ? { kind: 'predicate', iri: node.iri as unknown as Reactodia.LinkTypeIri }
          : { kind: 'type', iri: node.iri }
      );
      const filterKind = isProperty ? 'predicate' : 'type';
      setSectionActive(false);
      getCommandBus(Reactodia.InstancesSearchTopic).trigger('setCriteria', {
        criteria: filterKind === 'type'
          ? { elementType: node.iri }
          : { refElementLink: node.iri },
      });
    },
    [setActiveFilter, setSectionActive, getCommandBus]
  );

  // Build tree, inject hit counts into node.data.count so Leaf badge works
  const roots = React.useMemo(() => {
    const built = buildClassTree(classGraph, (id, data) =>
      translation.formatLabel(data?.label ?? [], id, model.language)
    );
    const sorted = sortTree(built);
    const filtered = searchText ? filterTreeByKeyword(sorted, searchText) : sorted;
    return injectCounts(filtered, classHitCounts);
  }, [classGraph, searchText, classHitCounts, translation, model.language]);

  const creatableClasses = React.useMemo((): ReadonlyMap<Reactodia.ElementTypeIri, boolean> => {
    if (canvasState.viewMode !== 'abox') return new Map();
    const m = new Map<Reactodia.ElementTypeIri, boolean>();
    for (const node of flattenTree(roots)) {
      if (!TBOX_PROPERTY_TYPES.has(node.iri)) m.set(node.iri, true);
    }
    return m;
  }, [roots, canvasState.viewMode]);

  if (!shouldRender) return null;

  const noResults = roots.length === 0 ? (
    <div className={`${TREE}__no-results`}>
      {searchText ? 'No classes found' : 'No classes available'}
    </div>
  ) : null;

  return (
    <div className={cx(TREE, `${TREE}--controlled`, 'reactodia-search-section-element-types')}>
      <VgForest
        className={`${TREE}__tree reactodia-scrollable`}
        nodes={roots}
        root
        searchText={searchText}
        onSelect={onSelectNode}
        creatableClasses={creatableClasses}
        onClickCreate={onClickCreate}
        onDragCreate={onDragCreate}
        footer={noResults}
      />
    </div>
  );
}

// ─── Inject hit counts ────────────────────────────────────────────────────────

function injectCounts(
  nodes: ReadonlyArray<TreeNode>,
  counts: ReadonlyMap<Reactodia.ElementTypeIri, number>
): ReadonlyArray<TreeNode> {
  return nodes.map(node => {
    const count = counts.get(node.iri) ?? 0;
    const derived = injectCounts(node.derived, counts);
    return {
      ...node,
      data: node.data ? { ...node.data, count } : undefined,
      derived,
    };
  });
}

function* flattenTree(nodes: ReadonlyArray<TreeNode>): Iterable<TreeNode> {
  for (const n of nodes) { yield n; yield* flattenTree(n.derived); }
}

// ─── Tree rendering — mirrors vanilla leaf.tsx exactly ────────────────────────

interface VgForestProps {
  className?: string;
  nodes: ReadonlyArray<TreeNode>;
  root?: boolean;
  searchText: string;
  onSelect: (node: TreeNode) => void;
  creatableClasses: ReadonlyMap<Reactodia.ElementTypeIri, boolean>;
  onClickCreate: (node: TreeNode) => void;
  onDragCreate: (node: TreeNode) => void;
  footer?: React.ReactNode;
}

function VgForest({ className, nodes, root, footer, ...leafProps }: VgForestProps) {
  return (
    <div className={className} role={root ? 'tree' : undefined}>
      {nodes.map(node => (
        <VgLeaf key={`node-${node.iri}`} node={node} {...leafProps} />
      ))}
      {footer}
    </div>
  );
}

type VgLeafProps = Omit<VgForestProps, 'nodes' | 'root' | 'footer' | 'className'> & {
  node: TreeNode;
};

function VgLeaf({ node, searchText, onSelect, creatableClasses, onClickCreate, onDragCreate }: VgLeafProps) {
  const [expanded, setExpanded] = React.useState(Boolean(searchText));
  React.useEffect(() => { setExpanded(Boolean(searchText)); }, [searchText]);

  const { getElementTypeStyle } = Reactodia.useWorkspace();
  const typeStyle = getElementTypeStyle([node.iri]);
  const providedStyle = {
    '--reactodia-element-style-color': typeStyle.color,
  } as React.CSSProperties;

  const hasChildren = node.derived.length > 0;
  const toggleClass = (
    !hasChildren ? `${ITEM}__toggle` :
    expanded ? `${ITEM}__toggle-expanded` :
    `${ITEM}__toggle-collapsed`
  );

  const count = node.data?.count ?? 0;

  return (
    <div
      className={ITEM}
      style={providedStyle}
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
    >
      <div className={`${ITEM}__row`}>
        <div
          className={toggleClass}
          role="button"
          onClick={() => setExpanded(prev => !prev)}
        />
        <a
          className={`${ITEM}__body`}
          href={node.iri}
          draggable
          onClick={e => { e.preventDefault(); onSelect(node); }}
          onDragStart={e => {
            e.dataTransfer.setData('text', '');
            onDragCreate(node);
          }}
        >
          <div className={`${ITEM}__icon-container`}>
            {typeStyle.icon ? (
              <img
                role="presentation"
                className={cx(
                  `${ITEM}__icon`,
                  typeStyle.iconMonochrome ? `${ITEM}__icon--monochrome` : undefined
                )}
                src={typeStyle.icon}
              />
            ) : (
              <div className={hasChildren ? `${ITEM}__default-icon-parent` : `${ITEM}__default-icon-leaf`} />
            )}
          </div>
          <span className={`${ITEM}__label`}>
            {highlightSubstring(node.label, searchText, { className: `${ITEM}__highlighted-term` })}
          </span>
          {count > 0 ? (
            <span className={`${ITEM}__count reactodia-badge`}>{count}</span>
          ) : null}
        </a>
        {creatableClasses.get(node.iri) ? (
          <div
            role="button"
            title="Drag or click to create an instance"
            className={cx(`${ITEM}__create-button`, 'reactodia-btn reactodia-btn-default')}
            draggable
            onClick={() => onClickCreate(node)}
            onDragStart={e => {
              e.dataTransfer.setData('text', '');
              onDragCreate(node);
            }}
          />
        ) : null}
      </div>
      {expanded && hasChildren ? (
        <VgForest
          className={`${ITEM}__children`}
          nodes={node.derived}
          searchText={searchText}
          onSelect={onSelect}
          creatableClasses={creatableClasses}
          onClickCreate={onClickCreate}
          onDragCreate={onDragCreate}
        />
      ) : null}
    </div>
  );
}
