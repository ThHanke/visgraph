import { readFileSync } from 'fs';
import { resolve } from 'path';
import { transform } from 'esbuild';
import type { Plugin } from 'vite';

const VIRTUAL_ID = 'virtual:relay-bookmarklet';
const RESOLVED_ID = '\0' + VIRTUAL_ID;

export function bookmarkletPlugin(): Plugin {
  let root: string;

  return {
    name: 'relay-bookmarklet',
    configResolved(config) {
      root = config.root;
    },
    resolveId(id) {
      if (id === VIRTUAL_ID) return RESOLVED_ID;
    },
    async load(id) {
      if (id !== RESOLVED_ID) return;

      const filePath = resolve(root, 'public/relay-bookmarklet.js');
      this.addWatchFile(filePath); // invalidate virtual module when source changes
      const src = readFileSync(filePath, 'utf8');
      const { code } = await transform(src, {
        minify: true,
        target: 'es2015',
      });
      // Strip trailing newline/semicolon from IIFE so it embeds cleanly in javascript: URL
      const minified = code.trim();
      return `export default ${JSON.stringify(minified)};`;
    },
  };
}
