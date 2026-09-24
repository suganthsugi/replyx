import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      // changeOrigin stays false: the API resolves the tenant from the incoming
      // Host header (e.g. acme.localhost), so it must be forwarded as-is (research D2).
      '/api': {
        target: 'http://api:3000',
        changeOrigin: false,
        ws: true,
      },
      '/rt': {
        target: 'http://api:3000',
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
