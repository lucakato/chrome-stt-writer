import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  publicDir: 'public',
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        content: resolve(__dirname, 'src/content/directInsert.ts'),
        widgetLoader: resolve(__dirname, 'src/content/widgetLoader.ts'),
        widgetModule: resolve(__dirname, 'src/content/widget.ts')
      },
      output: {
        entryFileNames: (chunkInfo) =>
          chunkInfo.name === 'background'
            ? 'background.js'
            : chunkInfo.name === 'content'
              ? 'content/directInsert.js'
              : chunkInfo.name === 'widgetLoader'
                ? 'content/widget.js'
                : chunkInfo.name === 'widgetModule'
                  ? 'content/widget.module.js'
                  : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    },
    target: 'chrome138'
  }
});
