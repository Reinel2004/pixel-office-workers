import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` -> normal multi-file build in dist/ (served by the Connected Mode server)
// `npm run build:single` -> one self-contained HTML file in dist-single/ (Demo Mode preview only)
export default defineConfig(({ mode }) => ({
  plugins: mode === 'single' ? [react(), viteSingleFile()] : [react()],
  base: './',
  // No VITE_* secrets: the browser never receives API credentials. In development the
  // Connected Mode API is proxied to the local server (npm run dev:server).
  envPrefix: 'WAD_PUBLIC_',
  server: {
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  build: {
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    chunkSizeWarningLimit: 2000,
  },
}));
