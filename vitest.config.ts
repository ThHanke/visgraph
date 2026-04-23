import { defineConfig } from 'vitest/config';
import path from 'path';

const virtualBookmarkletPlugin = {
  name: 'virtual-relay-bookmarklet-mock',
  resolveId(id: string) {
    if (id === 'virtual:relay-bookmarklet') return '\0virtual:relay-bookmarklet';
  },
  load(id: string) {
    if (id === '\0virtual:relay-bookmarklet') return 'export default "";';
  },
};

export default defineConfig({
  plugins: [virtualBookmarkletPlugin],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'file-saver': path.resolve(__dirname, 'src/providers/__mocks__/file-saver.ts'),
    }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    exclude: ['.trunk/**', 'node_modules/**', 'e2e/**'],
    server: {
      deps: {
        inline: ['@reactodia/workspace'],
      },
    },
  }
});
