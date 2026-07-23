#!/usr/bin/env bash
set -euo pipefail

VARIANT="${1:-short}"  # "short" (index.html) or "demo" (demo.html)
case "$VARIANT" in
  short) ZIP_NAME="ontosphere-dmkg2026-short.zip"; HTML_FILE="index.html"; PDF_NAME="ontosphere-dmkg2026-short.pdf" ;;
  demo)  ZIP_NAME="ontosphere-dmkg2026-demo.zip";  HTML_FILE="demo.html";  PDF_NAME="ontosphere-dmkg2026-demo.pdf"  ;;
  *)     echo "Usage: $0 [short|demo]" >&2; exit 1 ;;
esac
PAPER_DIR="dist/paper"
TMPDIR=""

cleanup() {
  if [ -n "$TMPDIR" ]; then
    rm -rf "$TMPDIR"
  fi
}
trap cleanup EXIT

# --- Build -----------------------------------------------------------
echo "Building project..."
npm run build --silent

if [ ! -f "$PAPER_DIR/$HTML_FILE" ]; then
  echo "ERROR: $PAPER_DIR/$HTML_FILE not found after build." >&2
  exit 1
fi

# --- Verify no external resource loads -------------------------------
# Check <link> tags (ignore canonical/meta), <script src=>, and <img src=>
# that reference external URLs (http/https).
EXTERNAL=$(grep -oP '<(link|script|img)\b[^>]*(src|href)="https?://[^"]*"' \
  "$PAPER_DIR/$HTML_FILE" \
  | grep -v 'rel="canonical"' \
  || true)

if [ -n "$EXTERNAL" ]; then
  echo ""
  echo "WARNING: External resource references found:"
  echo "$EXTERNAL"
  echo ""
  echo "The ZIP should be self-contained. Consider embedding these resources."
  echo "Proceeding anyway..."
  echo ""
fi

# --- Package ---------------------------------------------------------
TMPDIR=$(mktemp -d)
cp -r "$PAPER_DIR/." "$TMPDIR/"

# Remove files not needed in submission
find "$TMPDIR" -name '.gitkeep' -delete
rm -f "$TMPDIR/lncs-splnproc.zip"

# Create ZIP from temp directory (use Python zipfile since zip may not be installed)
rm -f "$ZIP_NAME"
python3 -c "
import zipfile, os, sys
src = sys.argv[1]
dst = sys.argv[2]
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(src):
        for f in sorted(files):
            full = os.path.join(root, f)
            arcname = os.path.relpath(full, src)
            zf.write(full, arcname)
    print('Contents:')
    for info in zf.infolist():
        print(f'  {info.compress_size:>8}  {info.filename}')
" "$TMPDIR" "$ZIP_NAME"

# --- Generate PDF via Playwright + dokieli print styles ---------------
echo ""
echo "Generating PDF for $VARIANT ($HTML_FILE) via Playwright..."

PAPER_PORT=8766
python3 -m http.server $PAPER_PORT --directory "$PAPER_DIR" --bind 127.0.0.1 &>/dev/null &
HTTP_PID=$!
sleep 1

node -e "
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:${PAPER_PORT}/${HTML_FILE}', { waitUntil: 'networkidle' });
  await page.pdf({
    path: '${PDF_NAME}',
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  });
  await browser.close();
  const fs = require('fs');
  const stat = fs.statSync('${PDF_NAME}');
  console.log('PDF generated: ${PDF_NAME} (' + Math.round(stat.size / 1024) + 'K)');
})().catch(e => { console.error(e); process.exit(1); });
"

kill $HTTP_PID 2>/dev/null || true

# --- Report ----------------------------------------------------------
ZIP_SIZE=$(du -h "$ZIP_NAME" | cut -f1)
PDF_SIZE=$(du -h "$PDF_NAME" 2>/dev/null | cut -f1 || echo "N/A")
echo ""
echo "Created $ZIP_NAME ($ZIP_SIZE)"
echo "Created $PDF_NAME ($PDF_SIZE)"
echo ""
echo "Before submitting:"
echo "  1. Unzip and open index.html in a browser from the filesystem"
echo "  2. Verify it renders correctly (fonts, layout, links)"
echo "  3. Open PDF and check page breaks + LNCS look-and-feel"
