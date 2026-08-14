import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// In development the app runs on :5173 and the control server on :4000.  The
// proxy keeps every request same-origin so the browser's WebSocket and fetch
// calls look identical to the production setup, where nginx does the same job.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: env['VITE_DEV_API'] ?? 'http://localhost:4000',
          changeOrigin: true,
          ws: true,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
