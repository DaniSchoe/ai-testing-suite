import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build landet in server/public und wird von Fastify ausgeliefert.
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../server/public', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8080', '/auth': 'http://localhost:8080' },
  },
});
