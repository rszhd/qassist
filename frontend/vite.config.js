import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies API + WebSocket to Express so the frontend can run on a
// separate port during development. In production the build is served by Express.
// API_PORT must match the port `npm run dev` in server/ listens on (8081 by default).
const apiPort = process.env.API_PORT || 8081;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': `http://localhost:${apiPort}`,
      '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
    },
  },
  build: { outDir: 'dist' },
});
