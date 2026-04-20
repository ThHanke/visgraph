// vite-plugin-mcp-manifest.ts
import type { Plugin } from 'vite';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

export function mcpManifestPlugin(): Plugin {
  return {
    name: 'vite-plugin-mcp-manifest',
    async buildStart() {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const { mcpManifest, mcpServerName, mcpServerDescription } = await import('./src/mcp/manifest.js');
      const manifest = {
        name: mcpServerName,
        description: mcpServerDescription,
        tools: mcpManifest,
      };
      const outDir = resolve(__dirname, 'public/.well-known');
      mkdirSync(outDir, { recursive: true });
      writeFileSync(resolve(outDir, 'mcp.json'), JSON.stringify(manifest, null, 2), 'utf-8');
      console.log('[mcp-manifest] wrote public/.well-known/mcp.json');
    },
  };
}
