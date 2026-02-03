# LocalStorage Safety Guide

## Overview

This document describes the general paradigm for safely handling localStorage persistence in the VisGraph application. Following these patterns ensures that users never experience crashes or errors due to missing, malformed, or outdated localStorage data.

## Core Principles

### 1. **Never Trust Persisted Data**
- Always validate and normalize data loaded from localStorage
- Treat all persisted state as `unknown` until validated
- Have sensible defaults for all configuration values

### 2. **Version-Based Migration**
- Use semantic versioning for persisted stores
- Increment version when schema changes
- Implement explicit migration logic for each version transition

### 3. **Fail Safely**
- If migration or validation fails, fall back to defaults
- Log errors for debugging but don't break the application
- Provide clear console messages about what went wrong

### 4. **Defensive Consumption**
- Code consuming persisted data should also validate critical fields
- Add runtime checks before accessing nested properties
- Use optional chaining and nullish coalescing

## Implementation Pattern

### Store Configuration (Zustand with Persist)

```typescript
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { isPlainObject } from "../utils/guards";
import { resolveStateStorage } from "../utils/stateStorage";

// 1. Define your state interface
interface MyConfig {
  requiredField: string;
  optionalField?: number;
  nestedConfig: {
    url: string;
    enabled: boolean;
  };
}

// 2. Define storage metadata
const STORAGE_KEY = "my-config-store";
const CONFIG_VERSION = 1; // Increment when schema changes

// 3. Define sensible defaults
const defaultConfig: MyConfig = {
  requiredField: "default-value",
  nestedConfig: {
    url: "https://example.com/default",
    enabled: true,
  },
};

// 4. Create normalization function
function normalizeMyConfig(value: unknown, context: string): MyConfig {
  if (!isPlainObject(value)) {
    throw new Error(`${context} must be a plain object`);
  }
  
  const input = value as Partial<MyConfig>;
  
  return {
    requiredField: normalizeString(
      input.requiredField ?? defaultConfig.requiredField,
      `${context}.requiredField`
    ),
    optionalField: input.optionalField !== undefined 
      ? normalizeNumber(input.optionalField, `${context}.optionalField`)
      : undefined,
    nestedConfig: normalizeNestedConfig(
      input.nestedConfig ?? defaultConfig.nestedConfig,
      `${context}.nestedConfig`
    ),
  };
}

// 5. Create the store with robust migration
export const useMyConfigStore = create<MyConfigStore>()(
  persist(
    (set, get) => ({
      config: defaultConfig,
      // ... store methods
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(resolveStateStorage),
      version: CONFIG_VERSION,
      
      // 6. Implement migration with version parameter
      migrate: (persistedState: unknown, version: number) => {
        console.log('[MyConfig] Running migration from version', version, 'to', CONFIG_VERSION);
        
        // Handle invalid persisted state
        if (!isPlainObject(persistedState)) {
          console.warn('[MyConfig] Invalid persisted state, using defaults');
          return { config: { ...defaultConfig } };
        }
        
        const typed = persistedState as { config?: unknown };
        if (!typed.config) {
          console.warn('[MyConfig] No config in persisted state, using defaults');
          return { config: { ...defaultConfig } };
        }
        
        let config = typed.config;
        
        // Apply version-specific migrations
        if (version < 2) {
          console.log('[MyConfig] Applying migration v1 -> v2: Adding newField');
          if (isPlainObject(config)) {
            const oldConfig = config as Partial<MyConfig>;
            config = {
              ...oldConfig,
              newField: oldConfig.newField || 'default-value',
            };
          }
        }
        
        // Add more migrations as needed
        // if (version < 3) {
        //   // Migration logic for v2 -> v3
        // }
        
        // Normalize and validate the migrated config
        try {
          const normalized = normalizeMyConfig(config, "persistedConfig");
          console.log('[MyConfig] Migration completed successfully');
          return { config: normalized };
        } catch (error) {
          console.error('[MyConfig] Migration failed, using defaults:', error);
          return { config: { ...defaultConfig } };
        }
      },
    },
  ),
);
```

## Defensive Consumption Pattern

When consuming persisted data in your application code, add additional defensive checks:

```typescript
export async function consumePersistedConfig(config: AppConfig) {
  // 1. Validate critical nested fields exist
  if (!config.nestedConfig || typeof config.nestedConfig !== 'object') {
    console.error('[Consumer] nestedConfig is missing or invalid');
    return {
      success: false,
      error: 'Configuration is invalid. Please reset your settings.',
    };
  }
  
  // 2. Validate required properties
  if (!config.nestedConfig.url) {
    console.error('[Consumer] nestedConfig.url is missing');
    return {
      success: false,
      error: 'Configuration URL is missing.',
    };
  }
  
  // 3. Use the validated data safely
  await doSomethingWith(config.nestedConfig.url);
  
  return { success: true };
}
```

## Checklist for Adding New Persisted Fields

When adding new fields to a persisted store:

- [ ] **Increment the version constant** (e.g., `CONFIG_VERSION = 2`)
- [ ] **Add the new field to the interface** with proper typing
- [ ] **Add default value** for the new field in `defaultConfig`
- [ ] **Update normalization function** to handle the new field
- [ ] **Add migration logic** in the `migrate` function:
  ```typescript
  if (version < 2) {
    config = {
      ...oldConfig,
      newField: oldConfig.newField || defaultValue,
    };
  }
  ```
- [ ] **Test migration** with old localStorage data
- [ ] **Add defensive checks** in consuming code if the field is critical

## Checklist for Modifying Existing Fields

When changing the structure of existing persisted fields:

- [ ] **Increment the version constant**
- [ ] **Update the interface** to reflect the new structure
- [ ] **Update default values** to match new structure
- [ ] **Update normalization function** to handle both old and new formats
- [ ] **Add migration logic** to transform old format to new:
  ```typescript
  if (version < 3) {
    // Transform old structure to new structure
    if (typeof oldConfig.field === 'string') {
      config.field = { url: oldConfig.field, enabled: true };
    }
  }
  ```
- [ ] **Test with various old localStorage states**

## Current Stores and Versions

| Store | Key | Current Version | Last Modified |
|-------|-----|-----------------|---------------|
| `appConfigStore` | `ontology-painter-config` | 2 | 2026-02-03 |
| `settingsStore` | `ontology-painter-settings` | 1 | 2026-02-03 |

## Version History

### appConfigStore

#### Version 2 (2026-02-03)
- Added `workflowCatalogUrls` field with nested structure
- Migration: Adds default workflow catalog URLs for users on v1

#### Version 1 (Initial)
- Initial schema with basic configuration options

### settingsStore

#### Version 1 (Initial)
- Initial schema for ontology settings

## Testing localStorage Migrations

### Manual Testing Process

1. **Save old version to localStorage:**
   ```javascript
   localStorage.setItem('ontology-painter-config', JSON.stringify({
     state: { config: { /* old v1 config */ } },
     version: 1
   }));
   ```

2. **Reload the application**

3. **Check console for migration logs:**
   - Should see: `[AppConfig] Running migration from version 1 to 2`
   - Should see: `[AppConfig] Migration completed successfully`

4. **Verify the config was migrated:**
   ```javascript
   JSON.parse(localStorage.getItem('ontology-painter-config'))
   ```

5. **Test the application functionality**

### Automated Testing

Add tests in `src/__tests__/stores/` for each store:

```typescript
describe('appConfigStore migration', () => {
  it('should migrate from v1 to v2', () => {
    const v1State = {
      state: {
        config: {
          currentLayout: 'horizontal',
          // ... other v1 fields, missing workflowCatalogUrls
        }
      },
      version: 1
    };
    
    // Save v1 state
    localStorage.setItem('ontology-painter-config', JSON.stringify(v1State));
    
    // Create store (triggers migration)
    const { config } = useAppConfigStore.getState();
    
    // Verify migration added missing fields
    expect(config.workflowCatalogUrls).toBeDefined();
    expect(config.workflowCatalogUrls.ontology).toBeTruthy();
  });
});
```

## Common Pitfalls to Avoid

### ❌ Don't: Access nested properties without validation
```typescript
// This will crash if workflowCatalogUrls is undefined
const url = config.workflowCatalogUrls.ontology;
```

### ✅ Do: Validate before access
```typescript
if (!config.workflowCatalogUrls || !config.workflowCatalogUrls.ontology) {
  console.error('Missing configuration');
  return;
}
const url = config.workflowCatalogUrls.ontology;
```

### ❌ Don't: Forget to increment version when changing schema
```typescript
// Adding new field but keeping version = 1
// Old users won't get the migration!
```

### ✅ Do: Always increment version with schema changes
```typescript
const CONFIG_VERSION = 2; // Incremented from 1
```

### ❌ Don't: Throw errors in migration without try-catch
```typescript
migrate: (state, version) => {
  return { config: strictNormalize(state.config) }; // May throw
}
```

### ✅ Do: Wrap normalization in try-catch and fall back to defaults
```typescript
migrate: (state, version) => {
  try {
    return { config: normalizeConfig(state.config) };
  } catch (error) {
    console.error('Migration failed:', error);
    return { config: { ...defaultConfig } };
  }
}
```

## Recovery Instructions for Users

If users encounter localStorage-related issues:

1. **Soft Reset** - Clear specific store:
   ```javascript
   localStorage.removeItem('ontology-painter-config');
   // Then reload the page
   ```

2. **Hard Reset** - Clear all VisGraph data:
   ```javascript
   Object.keys(localStorage)
     .filter(key => key.startsWith('ontology-painter-'))
     .forEach(key => localStorage.removeItem(key));
   // Then reload the page
   ```

3. **Complete Reset** - Clear all localStorage:
   ```javascript
   localStorage.clear();
   // Then reload the page
   ```

## Best Practices Summary

1. ✅ **Always validate persisted data** using normalization functions
2. ✅ **Increment version** when changing schema
3. ✅ **Provide explicit migration logic** for each version transition
4. ✅ **Fall back to defaults** if migration or validation fails
5. ✅ **Log migration progress** for debugging
6. ✅ **Add defensive checks** in code consuming persisted data
7. ✅ **Test migrations** with real old localStorage data
8. ✅ **Document version history** in this guide
9. ✅ **Use type-safe interfaces** for all persisted state
10. ✅ **Never assume nested objects exist** without checking

## References

- [Zustand Persist Middleware](https://github.com/pmndrs/zustand/blob/main/docs/integrations/persisting-store-data.md)
- [Project Guards Utilities](./src/utils/guards.ts)
- [Project Normalizers Utilities](./src/utils/normalizers.ts)
- [AppConfig Store](./src/stores/appConfigStore.ts) - Reference implementation
- [Settings Store](./src/stores/settingsStore.ts) - Reference implementation
