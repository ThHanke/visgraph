import cx from 'clsx';
import * as React from 'react';
import * as Reactodia from '@reactodia/workspace';
import { highlightSubstring } from '@reactodia/workspace';
import { useSearchIndexContext } from './SearchIndexContext';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

function getEntityLabel(entity: Reactodia.ElementModel): string {
  const labels = entity.properties[RDFS_LABEL];
  if (labels && labels.length > 0) {
    const lit = labels[0];
    if (lit.termType === 'Literal' && lit.value) return lit.value;
  }
  return (entity.id.split(/[/#]/).pop() ?? entity.id);
}

function getEntityTypes(entity: Reactodia.ElementModel, t: Reactodia.Translation, language: string): string {
  return entity.types
    .map(iri => t.formatLabel([], iri, language))
    .join(', ');
}

export function VgEntitiesSection() {
  const { shouldRender, setSectionActive, searchStore } =
    Reactodia.useUnifiedSearchSection({ searchTimeout: 0 });

  const { filteredEntities, activeFilter, clearFilter, searchText, setSearchText, currentIndex, onSelectEntity } =
    useSearchIndexContext();

  const { model, translation, getCommandBus } = Reactodia.useWorkspace();

  // Ref to the currently highlighted item so we can scroll it into view
  const currentItemRef = React.useRef<HTMLLIElement | null>(null);

  React.useEffect(() => {
    const handler = ({ source }: Reactodia.SearchInputStoreChangeValueEvent<string>) => {
      setSearchText(source.value);
    };
    searchStore.events.on('changeValue', handler);
    return () => searchStore.events.off('changeValue', handler);
  }, [searchStore, setSearchText]);

  React.useEffect(() => {
    const bus = getCommandBus(Reactodia.InstancesSearchTopic);
    const handler = () => { setSectionActive(true); };
    bus.on('setCriteria', handler);
    return () => bus.off('setCriteria', handler);
  }, [getCommandBus, setSectionActive]);

  // Scroll highlighted item into view whenever currentIndex changes
  React.useEffect(() => {
    currentItemRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [currentIndex]);

  if (!shouldRender) return null;

  const hasFilter = activeFilter !== null;
  const hasQuery = Boolean(searchText) || hasFilter;

  return (
    <div className="reactodia-search-section-entities reactodia-instances-search">
      {hasFilter && (
        <div className="reactodia-instances-search__criteria">
          <span className="reactodia-instances-search__criteria-label">
            {activeFilter.kind === 'type' ? 'Type: ' : 'Predicate: '}
            {translation.formatLabel([], activeFilter.iri as string, model.language)}
          </span>
          <button
            className="reactodia-instances-search__criteria-clear reactodia-btn reactodia-btn-default"
            title="Clear filter"
            aria-label="Clear filter"
            onClick={clearFilter}
          >
            ×
          </button>
        </div>
      )}

      <div className="reactodia-instances-search__rest">
        {filteredEntities.length === 0 ? (
          <div className="reactodia-instances-search__no-results">
            {hasQuery ? 'No results found' : 'Type to search or click a class'}
          </div>
        ) : (
          <ul>
            {filteredEntities.map((entity, i) => {
              const isCurrent = i === currentIndex;
              const label = getEntityLabel(entity);
              const types = getEntityTypes(entity, translation, model.language);
              return (
                <li
                  key={entity.id}
                  ref={isCurrent ? currentItemRef : null}
                  className={cx(
                    'reactodia-list-element-view',
                    isCurrent && 'reactodia-list-element-view--selected'
                  )}
                  title={`${label} <${entity.id}>\nTypes: ${types}`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => onSelectEntity(i)}
                >
                  <div className="reactodia-list-element-view__label">
                    {highlightSubstring(label, searchText, {
                      className: 'reactodia-text-highlight',
                    })}
                  </div>
                  {types && (
                    <div className="reactodia-list-element-view__types">
                      {types}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
