import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Server and pure-logic suites run in node; component suites need a DOM. The default
    // is node so the majority of tests keep the faster, more realistic runtime, and only
    // the suites that render React opt in.
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
  // React's `act` is only exported from the development build. Testing Library needs it to
  // render components without tearing, so the browser tests run against dev React while
  // everything else is unaffected.
  define: {
    'process.env.NODE_ENV': JSON.stringify('development'),
  },
  resolve: {
    conditions: ['development', 'browser'],
  },
});
