import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      '/health': 'http://127.0.0.1:8787',
      '/openapi.json': 'http://127.0.0.1:8787',
      '/jobs': 'http://127.0.0.1:8787',
    },
  },
});
