/*
  Simple contrast report (safe, minimal)
  Run with: node scripts/contrast-simple.cjs
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
function relLum({r,g,b}) {
  const sr = [r,g,b].map(v=>{
    const s = v/255;
    return s <= 0.03928 ? s/12.92 : Math.pow((s+0.055)/1.055,2.4);
  });
  return 0.2126*sr[0] + 0.7152*sr[1] + 0.0722*sr[2];
}
function contrast(L1,L2){ const a=Math.max(L1,L2), b=Math.min(L1,L2); return (a+0.05)/(b+0.05); }

function parsePalette() {
  const p = path.join('src','components','Canvas','core','namespacePalette.ts');
  if (!fs.existsSync(p)) return [];
  const s = fs.readFileSync(p,'utf8');
  const matches = s.match(/#[0-9A-Fa-f]{3,6}/g) || [];
  return [...new Set(matches)];
}

function parseTokens() {
  const p = path.join('src','index.css');
  if (!fs.existsSync(p)) return {};
  const s = fs.readFileSync(p,'utf8');
  const root = s.match(/:root\\s*\\{([\\s\\S]*?)\\}/);
  const dark = s.match(/\\.dark\\s*\\{([\\s\\S]*?)\\}/);
  const get = (blk,key) => {
    if (!blk) return null;
    const m = blk[1].match(new RegExp('--'+key+'\\s*:\\s*([^;]+);'));
    return m ? m[1].trim() : null;
  };
  return {
    light: { canvas: get(root,'canvas-bg'), node: get(root,'node-bg'), fg: get(root,'node-foreground') },
    dark: { canvas: get(dark,'canvas-bg'), node: get(dark,'node-bg'), fg: get(dark,'node-foreground') }
  };
}

function parseHslString(s) {
  if (!s) return null;
  // expected "214 18% 10%" (no hsl() wrapper)
  const parts = s.trim().split(/\\s+/);
  if (parts.length < 3) return null;
  const h = parseFloat(parts[0]);
  const sp = parseFloat(parts[1].replace('%',''))/100;
  const lp = parseFloat(parts[2].replace('%',''))/100;
  const hNorm = ((h % 360) + 360) % 360 / 360;
  const q = lp < 0.5 ? lp * (1 + sp) : lp + sp - lp * sp;
  const p = 2 * lp - q;
  const hue2 = (p,q,t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  };
  const r = Math.round(hue2(p,q,hNorm + 1/3) * 255);
  const g = Math.round(hue2(p,q,hNorm) * 255);
  const b = Math.round(hue2(p,q,hNorm - 1/3) * 255);
  return { r,g,b };
}

const palette = parsePalette();
const tokens = parseTokens();

console.log('Palette contrast (recommended text color vs palette color):');
palette.forEach(hex => {
  const rgb = hexToRgb(hex);
  const L = relLum(rgb);
  const cw = contrast(1, L);
  const cb = contrast(L, 0);
  const recommend = cw >= cb ? 'white' : 'black';
  console.log(`${hex} -> recommend: ${recommend} (contrast white=${cw.toFixed(2)}, black=${cb.toFixed(2)})`);
});

console.log('\\nToken parsing:');
console.log(tokens);

['light','dark'].forEach(theme=>{
  const t = tokens[theme];
  if (!t || !t.canvas || !t.node || !t.fg) {
    console.log(`\\n${theme}: missing tokens; skipping`);
    return;
  }
  // parse HSL-style tokens (we expect raw "210 25% 98%")
  const canvasRgb = parseHslString(t.canvas) || null;
  const nodeRgb = parseHslString(t.node) || null;
  const fgRgb = parseHslString(t.fg) || null;
  if (!canvasRgb || !nodeRgb || !fgRgb) {
    console.log(`\\n${theme}: could not parse tokens to HSL rgb; tokens:`, t);
    return;
  }
  const Lc = relLum(canvasRgb);
  const Ln = relLum(nodeRgb);
  const Lf = relLum(fgRgb);
  console.log(`\\n${theme}: node vs canvas contrast=${contrast(Ln,Lc).toFixed(2)} (>=3 recommended)`);
  console.log(`${theme}: text on node contrast=${contrast(Lf,Ln).toFixed(2)} (>=4.5 recommended)`);
});

console.log('\\nDone.');
