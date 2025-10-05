/**
 * Runtime contrast sampler using Playwright
 *
 * - Launches Chromium headless
 * - Loads the app (light and dark themes)
 * - Waits for .react-flow__node elements
 * - Samples computed styles for up to 12 nodes: node background/color, badge background/color
 * - Captures full-page screenshots to reports/contrast-sample-light.png and -dark.png
 * - Writes a JSON report to reports/runtime-contrast-report.json
 *
 * Run: node scripts/runtime-contrast-sampler.cjs
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function parseRgbString(s) {
  if (!s) return null;
  // handles "rgb(r, g, b)" and "rgba(r,g,b,a)"
  const m = s.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return null;
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) };
}

function relativeLuminance({ r, g, b }) {
  const srgb = [r, g, b].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(L1, L2) {
  const a = Math.max(L1, L2);
  const b = Math.min(L1, L2);
  return (a + 0.05) / (b + 0.05);
}

async function sampleTheme(themeSuffix, outScreenshot) {
  const url = `http://localhost:8080/${themeSuffix}?rdfUrl=https://raw.githubusercontent.com/Mat-O-Lab/IOFMaterialsTutorial/refs/heads/main/LengthMeasurement.ttl`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(url, { waitUntil: 'networkidle' });
  // wait for nodes
  try {
    await page.waitForSelector('.react-flow__node', { timeout: 8000 });
  } catch (e) {
    // continue; maybe no nodes present
  }

  // evaluate in page to extract computed styles
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

  // take screenshot
  const reportsDir = path.join(process.cwd(), 'reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  await page.screenshot({ path: path.join(reportsDir, outScreenshot), fullPage: true });

  await browser.close();
  return snapshot;
}

(async () => {
  try {
    const light = await sampleTheme('', 'contrast-sample-light.png');
    const dark = await sampleTheme('?theme=dark', 'contrast-sample-dark.png');

    // analyze samples
    function analyze(snapshot) {
      const results = [];
      snapshot.nodes.forEach((n, idx) => {
        const badgeBg = parseRgbString(n.badgeBg);
        const badgeColor = parseRgbString(n.badgeColor);
        const nodeBg = parseRgbString(n.nodeBg);
        const nodeColor = parseRgbString(n.nodeColor);
        const leftBar = parseRgbString(n.leftBarBg);

        const badgeL = badgeBg ? relativeLuminance(badgeBg) : null;
        const badgeTextL = badgeColor ? relativeLuminance(badgeColor) : null;
        const nodeL = nodeBg ? relativeLuminance(nodeBg) : null;
        const nodeTextL = nodeColor ? relativeLuminance(nodeColor) : null;

        const badgeContrast = badgeL !== null && badgeTextL !== null ? contrastRatio(badgeL, badgeTextL) : null;
        const nodeTextOnNode = nodeL !== null && nodeTextL !== null ? contrastRatio(nodeL, nodeTextL) : null;

        // recommended: 4.5:1 for small text, 3:1 for large/graphical
        results.push({
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
        });
      });
      return results;
    }

    const lightAnalysis = analyze(light);
    const darkAnalysis = analyze(dark);

    const report = {
      timestamp: new Date().toISOString(),
      light: { url: light.url, vars: light.vars, docBg: light.docBg, analysis: lightAnalysis },
      dark: { url: dark.url, vars: dark.vars, docBg: dark.docBg, analysis: darkAnalysis },
    };

    const out = path.join(process.cwd(), 'reports', 'runtime-contrast-report.json');
    fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
    console.log('Runtime contrast sampling complete. Report saved to', out);
    process.exit(0);
  } catch (err) {
    console.error('Runtime sampling failed:', err);
    process.exit(2);
  }
})();
