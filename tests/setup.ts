/**
 * Test setup shared by every suite.
 *
 * Two environment gaps are filled here, both about jsdom rather than about the code under
 * test.
 *
 * **Media playback.** jsdom implements no decoder, so a `<video>` element is inert:
 * `play()` never resolves, `currentTime` never advances on its own, and `duration` stays
 * `NaN`. Each component test therefore drives the element explicitly by dispatching the
 * events a real element would fire. This keeps the tests honest — they verify the clock's
 * *response* to media events rather than pretending the browser decodes video.
 *
 * **localStorage.** jsdom only provides it when started with `--localstorage-file`, so it is
 * `undefined` here. The application already treats storage as optional and fails quietly
 * (a blocked storage partition must not break the app), so a minimal in-memory stand-in
 * lets the tests exercise the remember-the-project path instead of skipping it.
 */

import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

if (typeof window !== 'undefined' && window.localStorage === undefined) {
  const store = new Map<string, string>();
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

beforeEach(() => {
  try {
    window.localStorage?.clear();
  } catch {
    // Nothing to do; the application treats storage as optional.
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
