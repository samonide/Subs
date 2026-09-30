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

    // Test files run one at a time.
    //
    // This was not a precaution — it fixes a real flake. Several suites shell out to ffmpeg,
    // which is multi-threaded and will take every core it is offered. With file parallelism
    // on a 16-core box, that starved the event loop of the worker running an HTTP test, and
    // undici reset the connection (`ECONNRESET`) roughly 3 runs in 10. The failure landed on
    // an unrelated pure-logic test, which is exactly the signature of an environment problem
    // masquerading as a code bug.
    //
    // Serialising costs a few seconds of wall clock and removes the whole class of failure.
    // If the suite ever grows slow enough for this to hurt, the fix is a dedicated pool for
    // the media suites — not reinstating parallelism across all of them.
    fileParallelism: false,

    // Generous per-test timeout. A few media tests encode multi-second fixtures, and the
    // 5s default was tight enough to trip on a loaded machine.
    testTimeout: 20_000,
    hookTimeout: 20_000,
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
