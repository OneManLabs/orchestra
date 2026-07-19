import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const fleetCoreTarget = process.env.VITE_FLEET_CORE_URL ?? 'http://127.0.0.1:4780';
const fleetCoreWebSocketTarget = fleetCoreTarget.replace(/^http/, 'ws');

export default defineConfig({
  root: '.',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: fleetCoreTarget, changeOrigin: false },
      '/ws': { target: fleetCoreWebSocketTarget, ws: true, changeOrigin: false }
    }
  },
  build: { outDir: 'dist-web', emptyOutDir: true }
});
