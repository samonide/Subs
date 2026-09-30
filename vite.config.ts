import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Must match `DEFAULT_PORT` in `src/server/main.ts`. */
const SERVER_PORT = 4199;

/**
 * Vite config.
 *
 * The dev server proxies `/api` and `/media` to the Node server so the browser sees a
 * single origin. That is not cosmetic: a `<video>` element cannot send Range requests to a
 * cross-origin URL without CORS, and a media pipeline that fails only in development is
 * worse than no dev server.
 *
 * `vite build` emits a static bundle to `dist/web`, which a future web host can serve
 * without Node.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Must match `DEFAULT_PORT` in src/server/main.ts. A mismatch here is invisible until
      // someone loads a video in the browser, so the port is declared once and imported
      // rather than repeated as a literal in two files.
      '/api': { target: `http://127.0.0.1:${SERVER_PORT}`, changeOrigin: false },
      '/media': { target: `http://127.0.0.1:${SERVER_PORT}`, changeOrigin: false },
    },
  },
});
