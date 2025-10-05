/**
 * Contrast report script (CommonJS)
 * - Reads src/components/Canvas/core/namespacePalette.ts for palette hexs
 * - Reads src/index.css to extract --canvas-bg / --node-bg / --node-foreground tokens for :root and .dark
 * - Computes contrast ratios for:
 *   - palette color vs chosen badge foreground (white or black)
 *   - node-foreground vs node-bg for light and dark themes
 *   - node-bg vs canvas-bg for light and dark themes
 *
 * Run with: node scripts/contrast-report.cjs
 */

const fs = require('fs');
const path = require('path');

function hexToRgb(hex) {
  if (!hex) return null;
  const c = hex.replace('#','');
  const full = c.length === 3 ? c.split('').map(s=>s+s).join('') : c;
  const n = parseInt(full,16);
  return { r: (n>>16)&255, g: (n>>8)&255, b: n&255 };
}

function hslStringToRgbTuple(s) {
  // expects "214 18% 10%" or "0 0% 100%" (space separated H S% L%)
  if (!s) return null;
  const parts = s.trim().split(/\s+/);
  if (parts.length < 3) return null;
  const h = parseFloat(parts[0]);
  const sPerc = parseFloat(parts[1].replace('%',''))/100;
  const lPerc = parseFloat(parts[2].replace('%',''))/100;
  // convert hsl to rgb 0-255
  const hNorm = ((h % 360) + 360) % 360 / 360;
  const sVal = sPerc;
  const lVal = lPerc;
  if (sVal === 0) {
    const v = Math.round(lVal * 255);
    return { r: v, g: v, b: v };
  }
  const q = lVal < 0.5 ? lVal * (1 + sVal) : lVal + sVal - lVal * sVal;
  const p = 2 * lVal - q;
  const hue2rgb = (p,q,t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const r = Math.round(hue2rgb(p,q,hNorm + 1/3) * 255);
  const g = Math.round(hue2rgb(p,q,hNorm) * 255);
  const b = Math.round(hue2rgb(p,q,hNorm - 1/3) * 255);
  return { r, g, b };
}

function relativeLuminance({ r,g,b }) {
  const srgb = [r,g,b].map(v => {
    const s = v/255;
    return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055, 2.4);
  });
  return 0.2126*srgb[0] + 0.7152*srgb[1] + 0.0722*srgb[2];
}

function contrastRatio(l1, l2) {
  const L1 = Math.max(l1,l2), L2 = Math.min(l1,l2);
  return (L1 + 0.05) / (L2 + 0.05);
}

function parsePalette() {
  const palettePath = path.join('src','components','Canvas','core','namespacePalette.ts');
  if (!fs.existsSync(palettePath)) return [];
  const s = fs.readFileSync(palettePath,'utf8');
  const matches = s.match(/#[0-9A-Fa-f]{3,6}/g) || [];
  const uniq = [...new Set(matches)];
  return uniq;
}

function parseTokens() {
  const cssPath = path.join('src','index.css');
  if (!fs.existsSync(cssPath)) return {};
  const s = fs.readFileSync(cssPath,'utf8');
  // Extract :root and .dark token blocks
  const rootMatch = s.match(/:root\\s*\\{([\\s\\S]*?)\\}/);
  const darkMatch = s.match(/\\.dark\\s*\\{([\\s\\S]*?)\\}/);
  const extract = (block, key) => {
    if (!block) return null;
    const m = block.match(new RegExp(`--${key}\\s*:\\s*([^;]+);`));
    return m ? m[1].trim() : null;
  };
  const tokens = {
    light: {
      canvasBg: extract(rootMatch && rootMatch[1], 'canvas-bg'),
      nodeBg: extract(rootMatch && rootMatch[1], 'node-bg'),
      nodeForeground: extract(rootMatch && rootMatch[1], 'node-foreground'),
    },
    dark: {
      canvasBg: extract(darkMatch && darkMatch[1], 'canvas-bg'),
      nodeBg: extract(darkMatch && darkMatch[1], 'node-bg'),
      nodeForeground: extract(darkMatch && darkMatch[1], 'node-foreground'),
    }
  };
  return tokens;
}

function pickBestTextColorForHex(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#000000';
  const L = relativeLuminance(rgb);
  const contrastWhite = contrastRatio(1, L);
  const contrastBlack = contrastRatio(L, 0);
  return contrastWhite >= contrastBlack ? '#ffffff' : '#111827';
}

// Run checks
const palette = parsePalette();
const tokens = parseTokens();

console.log('Tokens (parsed):', tokens);
console.log('');
console.log('Palette contrast checks (badge background -> recommended text -> contrast):');
palette.forEach(hex => {
  const fg = pickBestTextColorForHex(hex);
  const rgbBg = hexToRgb(hex);
  const Lbg = relativeLuminance(rgbBg);
  const Lfg = fg === '#ffffff' ? 1 : 0; // white luminance=1, black=0
  const cr = contrastRatio(Lfg, Lbg);
  console.log(hex, '->', fg, 'contrast=', cr.toFixed(2), cr >= 4.5 ? 'PASS' : 'FAIL');
});

console.log('');
console.log('Node / canvas token contrasts:');
['light','dark'].forEach(theme => {
  const t = tokens[theme];
  if (!t.canvasBg || !t.nodeBg || !t.nodeForeground) {
    console.log(theme, 'missing tokens to evaluate');
    return;
  }
  // parse hsl tokens if present (they are like "210 25% 98%")
  const canvasRgb = t.canvasBg.includes('hsl') ? null : hslStringToRgbTuple(t.canvasBg);
  const nodeRgb = t.nodeBg.includes('hsl') ? null : hslStringToRgbTuple(t.nodeBg);
  // Our tokens are raw HSL strings (without "hsl()") in file; attempt parse
  const parseMaybeHsl = (val) => {
    if (!val) return null;
    const cleaned = val.replace(/hsl\\(|\\)/g,'').trim();
    return hslStringToRgbTuple(cleaned) || hslStringToRgbTuple(val);
  };
  const canvasCol = parseMaybeHsl(t.canvasBg) || hexToRgb(t.canvasBg);
  const nodeCol = parseMaybeHsl(t.nodeBg) || hexToRgb(t.nodeBg);
  const nodeFgCol = parseMaybeHsl(t.nodeForeground) || hexToRgb(t.nodeForeground);
  if (!canvasCol || !nodeCol || !nodeFgCol) {
    console.log(theme, 'could not parse one of the tokens', t);
    return;
  }
  const Lcanvas = relativeLuminance(canvasCol);
  const Lnode = relativeLuminance(nodeCol);
  const LnodeFg = relativeLuminance(nodeFgCol);
  const crNodeOnCanvas = contrastRatio(Lnode, Lcanvas);
  const crTextOnNode = contrastRatio(LnodeFg, Lnode);
  console.log(theme, 'node vs canvas contrast=', crNodeOnCanvas.toFixed(2), crNodeOnCanvas >= 3 ? 'OK (>=3 recommended for UI surfaces)' : 'LOW');
  console.log(theme, 'text on node contrast=', crTextOnNode.toFixed(2), crTextOnNode >= 4.5 ? 'PASS (>=4.5)' : (crTextOnNode >= 3 ? 'AA Large (>=3)' : 'FAIL'));
});

console.log('');
console.log('Report complete.');
</command>
<requires_approval>false</requires_approval>
<task_progress>
- [x] Create contrast-report script (CJS)
- [x] Run automated runtime contrast checks
- [ ] Review report and adjust tokens if needed
</task_progress>
</execute_command>
