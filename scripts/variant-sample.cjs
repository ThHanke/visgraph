/**
 * Variant sampler
 * - Applies each canvas variant to src/index.css (light + dark token pairs)
 * - Runs an in-process Playwright sampling (no external scripts) and writes:
 *   - reports/contrast-sample-light-variant<N>.png
 *   - reports/contrast-sample-dark-variant<N>.png
 *   - reports/runtime-contrast-report-variant<N>.json
 *
 * Run with: node scripts/variant-sample.cjs
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const INDEX_CSS = path.join(process.cwd(), 'src', 'index.css');
const REPORTS = path.join(process.cwd(), 'reports');
if (!fs.existsSync(REPORTS)) fs.mkdirSync(REPORTS, { recursive: true });

const variants = [
  {
    name: 'variant1',
    light: { canvasBg: '172 65% 97%', canvasGrid: '172 60% 95%' },
    dark: { canvasBg: '172 22% 10%', canvasGrid: '172 18% 14%' },
  },
  {
    name: 'variant2',
    light: { canvasBg: '172 60% 95%', canvasGrid: '172 52% 92%' },
    dark: { canvasBg: '172 20% 9%', canvasGrid: '172 16% 12%' },
  },
  {
    name: 'variant3',
    light: { canvasBg: '172 50% 92%', canvasGrid: '172 46% 88%' },
    dark: { canvasBg: '172 16% 6%', canvasGrid: '172 14% 10%' },
  },
];

function replaceCanvasTokens(content, light, dark) {
  // Replace the first :root canvas token lines and the .dark canvas token lines.
  const rootRegex = /\/\* Canvas tokens \*\/[\s\S]*?--canvas-bg:[^\n;]+;[\r\n]+[^\n;]*--canvas-grid:[^\n;]+;/m;
  const darkRegex = /\.dark\s*\{([\s\S]*?)\}/m;
  // Replace root block: find the comment and replace the next two --canvas lines.
  content = content.replace(/\/\* Canvas tokens \*\/[\s\S]*?--canvas-grid:[^\n;]+;/m, `/* Canvas tokens */\n  /* Variant applied by scripts/variant-sample.cjs */\n  --canvas-bg: ${light.canvasBg};\n  --canvas-grid: ${light.canvasGrid};`);
  // Replace .dark canvas lines inside .dark block
  content = content.replace(/--canvas-bg:[^\n;]+;[\r\n]+\s*--canvas-grid:[^\n;]+;/m, `--canvas-bg: ${dark.canvasBg};\n  --canvas-grid: ${dark.canvasGrid};`);
  return content;
}

function parseRgbString(s) {
  if (!s) return null;
  const m = s.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}
function relLum({r,g,b}) {
  const sr = [r,g,b].map(v=>{
    const s = v/255;
    return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055,2.4);
  });
  return 0.2126*sr[0]+0.7152*sr[1]+0.0722*sr[2];
}
function contrast(L1,L2){ const a=Math.max(L1,L2), b=Math.min(L1,L2); return (a+0.05)/(b+0.05); }

async function sample(url, outScreenshot) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(url, { waitUntil: 'networkidle' });
  try {
    await page.waitForSelector('.react-flow__node', { timeout: 8000 });
  } catch (_) {}
  const snapshot = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('.react-flow__node')).slice(0, 12).map((el) => {
      const badge = el.querySelector('.node-badge');
      const header = el.querySelector('.text-sm.font-bold') || el;
      const nodeBg = getComputedStyle(el).backgroundColor;
      const nodeColor = getComputedStyle(el).color;
      const badgeBg = badge ? getComputedStyle(badge).backgroundColor : null;
      const badgeColor = badge ? getComputedStyle(badge).color : null;
      const leftBar = el.querySelector('.w-2[style]') || el.querySelector('.w-2');
      const leftBarBg = leftBar ? getComputedStyle(leftBar).backgroundColor : null;
      const title = header ? header.textContent?.trim().slice(0, 80) : '';
      return { nodeBg, nodeColor, badgeBg, badgeColor, leftBarBg, title };
    });
    const cs = getComputedStyle(document.documentElement);
    const vars = {
      canvasBg: cs.getPropertyValue('--canvas-bg') || null,
      canvasGrid: cs.getPropertyValue('--canvas-grid') || null,
      nodeBgVar: cs.getPropertyValue('--node-bg') || null,
      nodeFgVar: cs.getPropertyValue('--node-foreground') || null,
    };
    const docBg = getComputedStyle(document.documentElement).backgroundColor;
    return { nodes, vars, docBg, url: location.href };
  });
  await page.screenshot({ path: path.join(REPORTS, outScreenshot), fullPage: true });
  await browser.close();
  return snapshot;
}

(async () => {
  const original = fs.readFileSync(INDEX_CSS, 'utf8');
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    console.log('Applying', v.name);
    const content = fs.readFileSync(INDEX_CSS, 'utf8');
    const newContent = replaceCanvasTokens(content, v.light, v.dark);
    fs.writeFileSync(INDEX_CSS, newContent, 'utf8');
    // allow a small pause for file watchers
    await new Promise((r) => setTimeout(r, 250));
    // sample light
    const lightSnapshot = await sample(`http://localhost:8080/?rdfUrl=https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/refs/heads/main/LengthMeasurement.ttl`, `contrast-sample-light-${v.name}.png`);
    // sample dark
    const darkSnapshot = await sample(`http://localhost:8080/?theme=dark&rdfUrl=https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/refs/heads/main/LengthMeasurement.ttl`, `contrast-sample-dark-${v.name}.png`);
    // analyze (simple)
    function analyze(snapshot) {
      return snapshot.nodes.map((n, idx) => {
        const badgeBg = parseRgbString(n.badgeBg);
        const badgeColor = parseRgbString(n.badgeColor);
        const nodeBg = parseRgbString(n.nodeBg);
        const nodeColor = parseRgbString(n.nodeColor);
        const badgeL = badgeBg ? relLum(badgeBg) : null;
        const badgeTextL = badgeColor ? relLum(badgeColor) : null;
        const nodeL = nodeBg ? relLum(nodeBg) : null;
        const nodeTextL = nodeColor ? relLum(nodeColor) : null;
        const badgeContrast = badgeL !== null && badgeTextL !== null ? contrast(badgeL, badgeTextL) : null;
        const nodeTextOnNode = nodeL !== null && nodeTextL !== null ? contrast(nodeL, nodeTextL) : null;
        return {
          index: idx,
          title: n.title,
          badgeBg: n.badgeBg,
          badgeColor: n.badgeColor,
          badgeContrast: badgeContrast ? Number(badgeContrast.toFixed(2)) : null,
          badgePass: badgeContrast ? (badgeContrast >= 4.5) : null,
          nodeBg: n.nodeBg,
          nodeColor: n.nodeColor,
          nodeTextOnNode: nodeTextOnNode ? Number(nodeTextOnNode.toFixed(2)) : null,
          nodeTextPass: nodeTextOnNode ? (nodeTextOnNode >= 4.5) : null,
          leftBarBg: n.leftBarBg,
        };
      });
    }
    const report = {
      timestamp: new Date().toISOString(),
      variant: v.name,
      light: { snapshot: lightSnapshot, analysis: analyze(lightSnapshot) },
      dark: { snapshot: darkSnapshot, analysis: analyze(darkSnapshot) },
    };
    fs.writeFileSync(path.join(REPORTS, `runtime-contrast-report-${v.name}.json`), JSON.stringify(report, null, 2), 'utf8');
    console.log('Saved reports for', v.name);
  }
  // restore original
  fs.writeFileSync(INDEX_CSS, original, 'utf8');
  console.log('Done. Restored original index.css');
})();
