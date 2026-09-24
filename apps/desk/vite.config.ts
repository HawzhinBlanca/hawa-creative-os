import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const CSP_HEADER = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self' ws: wss: http: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none';";

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env': {},
  },
  server: {
    port: 5173,
    headers: {
      'Content-Security-Policy': CSP_HEADER,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
    proxy: {
      '/v1': 'http://127.0.0.1:3001',
      '/api': 'http://127.0.0.1:3001',
    },
  },
  preview: {
    port: 4173,
    headers: {
      'Content-Security-Policy': CSP_HEADER,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    },
    proxy: {
      '/v1': 'http://127.0.0.1:3001',
      '/api': 'http://127.0.0.1:3001',
    },
  },
});
