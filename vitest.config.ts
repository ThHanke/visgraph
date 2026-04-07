import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'file-saver': path.resolve(__dirname, 'src/providers/__mocks__/file-saver.ts'),
    }
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    exclude: ['.trunk/**', 'node_modules/**'],
    server: {
      deps: {
        inline: ['@reactodia/workspace'],
      },
    },
  }
});
