import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Phase 0 lint configuration.
 *
 * The load-bearing rule here is the `core-boundary` block: `src/core` is the pure
 * domain layer that must stay importable from a browser bundle, a Node worker, and a
 * test runner unchanged. The lint rule enforces it statically; `tests/boundary.test.ts`
 * enforces it again by inspecting the emitted dependency graph, so a misconfigured or
 * bypassed lint rule cannot silently permit a breach.
 */

/** Modules `src/core` may never import. See ARCHITECTURE.md §9. */
const FORBIDDEN_IN_CORE = [
  // UI frameworks
  'react',
  'react/*',
  'react-dom',
  'react-dom/*',
  'preact',
  'vue',
  'svelte',
  'solid-js',
  // Build and app tooling
  'vite',
  'vitest',
  '@vitejs/*',
  // Server frameworks
  'fastify',
  'express',
  'koa',
  '@hapi/*',
  'hono',
  // State libraries
  'zustand',
  'redux',
  '@reduxjs/toolkit',
  'jotai',
  // Media tooling — FFmpeg is a spawned binary in a worker, never a package here
  '@ffmpeg/*',
  'ffmpeg-static',
  'fluent-ffmpeg',
  // Styling
  'tailwindcss',
  '*.css',
  '*.scss',
  // Filesystem and process — core is environment-agnostic
  'node:fs',
  'node:fs/*',
  'node:path',
  'node:child_process',
  'node:worker_threads',
  'node:os',
  'fs',
  'fs/*',
  'path',
  'child_process',
  'worker_threads',
  'os',
  // Network
  'node:http',
  'node:https',
  'node:net',
  'node:dgram',
  'http',
  'https',
  'node-fetch',
  'axios',
  // Provider SDKs — a vendor type must never reach the document model
  'openai',
  '@anthropic-ai/*',
  '@google-cloud/*',
  'groq-sdk',
  'assemblyai',
  // Web platform APIs
  'node:perf_hooks',
  'perf_hooks',
  'canvas',
];

const CORE_BOUNDARY_MESSAGE =
  'ARCHITECTURE: src/core must stay pure domain logic. It may not import UI, server, ' +
  'filesystem, network, or provider dependencies. That boundary is what lets the same ' +
  'style resolver run in the browser preview and the export worker. If a function needs ' +
  'host capability, it does not belong in core. See ARCHITECTURE.md §9 and ' +
  'ARCHITECTURE_REVIEW.md §2.';

export default tseslint.config(
  {
    // Tooling config files are plain JS outside the TypeScript project, so the
    // type-aware parser has no tsconfig to resolve them against. They are not part of
    // the product surface, so they are excluded rather than specially configured.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.mjs', '*.config.ts'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    settings: {
      react: { version: 'detect' },
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // The browser layer is the only place JSX may appear. Enabling the parser feature
    // here means a stray JSX file outside src/web is a parse error rather than something a
    // reviewer has to notice.
    files: ['src/web/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: FORBIDDEN_IN_CORE,
              message: CORE_BOUNDARY_MESSAGE,
            },
          ],
        },
      ],
    },
  },
  {
    // Tests and tooling legitimately reach for Node APIs; the restriction above is
    // scoped to `src/core` only.
    files: ['tests/**/*.ts', '*.config.ts'],
    rules: {
      'no-restricted-imports': 'off',
      // A test double that resolves synchronously is the clearest possible statement of what
      // it does. Requiring a fabricated `await` inside it would add noise to satisfy a rule
      // about production code, so the rule stays where it earns its keep: in `src/`.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
