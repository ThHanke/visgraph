#!/bin/bash
# Bulk migration script for test files - replaces common .getStore() patterns

set -e

echo "Starting bulk test migration..."

# Files to process
FILES=(
  "src/__tests__/stores/ontologyStore.loadOntologyRdf.test.ts"
  "src/__tests__/stores/reasoning_missing_label.test.ts"
  "src/__tests__/stores/rdfManager.namespaces.test.ts"
  "src/__tests__/stores/updateFatMap.after_ontology_load.test.ts"
  "src/__tests__/stores/rdfManager.load_well_known.test.ts"
  "src/__tests__/stores/rdfManager.emit_all_subjects.test.ts"
  "src/__tests__/stores/reasoning_lengthmeasurement_app_integration.test.ts"
)

for file in "${FILES[@]}"; do
  if [ -f "$file" ]; then
    echo "Processing $file..."
    
    # Add import for test helpers if not present
    if ! grep -q "import.*findQuads.*waitForOperation" "$file"; then
      # Find the last import line and add after it
      sed -i '/^import.*from/a import { findQuads, waitForOperation, getQuadCount } from "../utils/testHelpers";' "$file"
    fi
    
    # Common pattern 1: rdfManager.getStore().getQuads(...) in variable assignment
    # This is tricky and needs manual review
    
    # Common pattern 2: mgr.getStore().getQuads(...) 
    # This is also tricky
    
    echo "  File prepared - manual patterns still needed"
  else
    echo "Skipping $file (not found)"
  fi
done

echo "Bulk migration complete. Manual review needed for complex patterns."
