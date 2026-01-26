# Function Usage Analysis - Dead Code & Duplications

## Methodology
This analysis identifies:
1. **Exported functions** that are never imported (potential dead code)
2. **Similar function names** across files (potential duplicates)
3. **Internal helper functions** that could be consolidated

---

## Summary of Functions Cataloged

### src/utils (50+ functions across 17 files)
- **fetcher.ts**: 1 function (doFetch)
- **graphValidation.ts**: 1 function (validateGraph)
- **guards.ts**: 8 assertion functions
- **normalizers.ts**: 8 normalization functions
- **rdfManager.impl.ts**: 35+ methods (RDFManagerImpl class)
- **rdfManager.workerClient.ts**: 2 functions + class
- **rdfManager.workerProtocol.ts**: 40+ validation functions
- **rdfSerialization.ts**: 9 serialization functions
- **startupDebug.ts**: 15+ logging/debugging functions
- **stateStorage.ts**: 2 storage functions
- **storeHelpers.ts**: 6 helper functions (recently added)
- **termUtils.ts**: 10+ term manipulation functions
- **theme.ts**: 5 theme functions
- **workerNormalization.ts**: 5 worker normalization functions

### src/stores (30+ functions across 3 files)
- **appConfigStore.ts**: 3 internal helpers + store
- **ontologyStore.ts**: 20+ internal helpers + store
- **reasoningValidators.ts**: 1 function (runDomainRangeChecks)
- **settingsStore.ts**: 6 normalization helpers + store

### src/workers (30+ functions across 2 files)
- **rdfManager.runtime.ts**: 28+ runtime functions
- **polyfills.ts**: BufferShim class

### src/components (Not yet fully cataloged - very large)
- Will focus on searching for specific patterns

---

## Analysis Strategy

Instead of mapping all 200+ functions manually, I'll use targeted searches to find:

1. **Potential Dead Code**: Search for exports that are never imported
2. **Name Collisions**: Functions with similar names across files
3. **Obvious Duplicates**: Functions doing the same thing

---

## Phase 1: Exported Functions That May Be Unused

### Checking normalizers.ts exports...

**normalizers.ts exports**:
- normalizeBoolean
- normalizeString
- normalizeOptionalString
- normalizeNumber
- normalizeStringArray
- normalizeStringSet
- normalizeStringRecord
- normalizeBooleanFlag

### Checking guards.ts exports...

**guards.ts exports**:
- isPlainObject
- invariant
- assertPlainObject
- assertString
- assertNumber
- assertArray
- assertBoolean
- isStringRecord

### Checking startupDebug.ts exports...

**startupDebug.ts exports**:
- incr
- milestone
- log, debug, info, warn, error
- timedAsync
- fallback
- getSummary

---

## Analysis Results (To Be Populated)

### Dead Code Candidates

*Analysis in progress - will search for imports of each exported function*

### Duplicate Function Names

*To be identified through systematic search*

### Consolidation Opportunities

*To be identified through pattern matching*

---

## Next Steps

1. Search for usage of each exported function in the codebase
2. Identify functions that are exported but never imported
3. Check for functions with nearly identical implementations
4. Document recommendations

