#!/usr/bin/env bash
# Prepared archive script (DRY-RUN friendly) for the selected canvas candidate files.
# This script only prints git mv commands and will perform moves when you remove the --dry-run flag.
#
# Usage:
#   1. Review the commands below.
#   2. Make the script executable: chmod +x scripts/archive_canvas_candidates.sh
#   3. Run in dry-run first: ./scripts/archive_canvas_candidates.sh --dry-run
#   4. If results look good, run without --dry-run to perform the git mv operations.
#
# After moving files, run the verification steps listed at the end (build & tests).
# If anything breaks, revert the moves with: git restore --staged . && git checkout -- .

set -euo pipefail

DRY_RUN=true
if [ "${1:-}" = "--no-dry-run" ] || [ "${1:-}" = "run" ]; then
  DRY_RUN=false
fi

ROOT="$(pwd)"
ARCHIVE_DIR="archived/knowledgecanvas_candidates"
mkdir -p "$ARCHIVE_DIR"

# Candidate files to archive (selected from unreachable-from-KnowledgeCanvas analysis)
FILES=(
  "src/components/Canvas/core/DiagramManager.ts"
  "src/components/Canvas/core/TemplateManager.ts"
  "src/components/Canvas/core/EventHandlers.ts"
  "src/components/Canvas/ReactFlowCanvas.tsx"
  "src/components/Canvas/AnnotationPropertyDialog.tsx"
  "src/components/Canvas/NamespaceLegend.tsx"
  "src/components/Canvas/helpers/diagramHelpers.ts"
  "src/components/Canvas/helpers/paletteHelpers.ts"
)

echo "Archive directory: $ARCHIVE_DIR"
echo "Dry run: $DRY_RUN"
echo

for f in "${FILES[@]}"; do
  if [ -e "$f" ]; then
    if $DRY_RUN; then
      echo "[DRY] git mv \"$f\" \"$ARCHIVE_DIR/\""
    else
      echo "Moving: $f -> $ARCHIVE_DIR/"
      git mv "$f" "$ARCHIVE_DIR/" || { echo "git mv failed for $f"; exit 1; }
    fi
  else
    echo "NOT FOUND: $f"
  fi
done

if $DRY_RUN; then
  echo
  echo "Dry run complete. If you want to perform the moves, re-run with:"
  echo "  ./scripts/archive_canvas_candidates.sh --no-dry-run"
  exit 0
fi

echo
echo "Files moved to $ARCHIVE_DIR. Next verification steps (run manually):"
echo "  1) npm run build"
echo "  2) npm test"
echo
echo "If build/test fail and you want to revert the moves:"
echo "  git restore --staged ."
echo "  git checkout -- ."
echo
echo "When satisfied, commit the archive changes:"
echo "  git add \"$ARCHIVE_DIR\""
echo "  git commit -m \"archive: move candidate canvas files for review\""
