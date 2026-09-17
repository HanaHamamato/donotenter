import { defineConfig } from 'vite';

// The game is a pure static site: one HTML shell + ES modules + JSON data.
// Dev server is bound to 0.0.0.0 so it can be proxied by the Arena preview host.
export default defineConfig({
  base: './',
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    allowedHosts: true,
    // HMR websockets are not reliably proxied in the preview environment; the
    // page works fine without it and we avoid a wall of console errors.
    hmr: false,
  },
  preview: {
    host: '0.0.0.0',
    port: 4173,
    strictPort: false,
    allowedHosts: true,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          return undefined;
        },
      },
    },
  },
});
