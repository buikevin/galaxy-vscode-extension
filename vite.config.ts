import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'process.env': JSON.stringify({ NODE_ENV: 'production' }),
    process: JSON.stringify({ env: { NODE_ENV: 'production' } }),
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@webview': resolve(__dirname, 'webview/src'),
    },
  },
  build: {
    outDir: 'dist/webview',
    emptyOutDir: false,
    cssCodeSplit: false,
    lib: {
      entry: resolve(__dirname, 'webview/src/main.tsx'),
      name: 'GalaxyCodeWebview',
      formats: ['iife'],
      cssFileName: 'chat',
      fileName: () => 'chat.js',
    },
  },
});
