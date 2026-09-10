import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Demo tunnels (trycloudflare.com / ngrok) present a foreign Host header.
    allowedHosts: true,
    // In dev the API is proxied so the app works from a single origin (no CORS, same as prod behind Caddy).
    proxy: { '/api': { target: 'http://localhost:8080', changeOrigin: true }, '/health': 'http://localhost:8080' },
  },
  build: { target: 'es2022', sourcemap: false },
});
