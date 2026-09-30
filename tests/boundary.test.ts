/**
 * The core boundary test.
 *
 * `src/core` is the pure domain layer. It must be importable unchanged by a browser
 * bundle, a Node worker, and a test runner — that constraint is what lets the same style
 * resolver drive both the preview and the export, which is the mechanism behind the
 * WYSIWYG promise.
 *
 * `eslint.config.mjs` already forbids the offending imports statically. This test
 * enforces the same rule a second, independent way: by inspecting the emitted JavaScript
 * for `import`/`require` statements rather than trusting the lint configuration. A
 * misconfigured or bypassed lint rule must not be able to silently permit a breach.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const projectRoot = join(here, '..');
const srcRoot = join(projectRoot, 'src');
const coreRoot = join(srcRoot, 'core');
const distCoreRoot = join(projectRoot, 'dist', 'src', 'core');

/** Packages and builtins `src/core` may never depend on. */
const FORBIDDEN = [
  'react',
  'react-dom',
  'preact',
  'vue',
  'svelte',
  'vite',
  'vitest',
  'fastify',
  'express',
  'koa',
  'hono',
  'zustand',
  'redux',
  'jotai',
  'tailwindcss',
  'ffmpeg-static',
  'fluent-ffmpeg',
  'openai',
  'canvas',
  'fs',
  'path',
  'child_process',
  'worker_threads',
  'os',
  'http',
  'https',
  'net',
  'perf_hooks',
];

function collectFiles(dir: string, extensions: string[]): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectFiles(full, extensions));
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      found.push(full);
    }
  }
  return found;
}

/** Match static and dynamic import/require specifiers in emitted JS. */
function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        specifiers.push(specifier);
      }
    }
  }
  return specifiers;
}

function assertNoForbiddenImports(files: string[], label: string): void {
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const specifier of importedSpecifiers(source)) {
      // Only external/builtin specifiers matter. Relative imports stay inside core,
      // which is exactly what we want.
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        continue;
      }
      const bare = specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
      const packageName = bare.startsWith('@')
        ? bare.split('/').slice(0, 2).join('/')
        : bare.split('/')[0]!;
      expect(
        FORBIDDEN,
        `${label} ${relative(projectRoot, file)} must not import "${specifier}". ` +
          'src/core is pure domain logic; host capability means the function is in the wrong place.',
      ).not.toContain(packageName);
    }
  }
}

describe('core boundary', () => {
  it('has a src/core directory to check', () => {
    expect(statSync(coreRoot).isDirectory()).toBe(true);
  });

  it('emits no forbidden imports in the compiled core', () => {
    // Requires `pnpm build` to have run. If dist is missing the test fails loudly rather
    // than passing vacuously, because a silently-skipped boundary check is worse than none.
    expect(
      statSync(distCoreRoot).isDirectory(),
      'dist/src/core not found — run `pnpm build` before the test suite (or use `pnpm verify`).',
    ).toBe(true);

    const files = collectFiles(distCoreRoot, ['.js', '.mjs', '.cjs']);
    expect(files.length).toBeGreaterThan(0);
    assertNoForbiddenImports(files, 'compiled');
  });

  it('declares no forbidden imports in the TypeScript source', () => {
    const files = collectFiles(coreRoot, ['.ts']);
    expect(files.length).toBeGreaterThan(0);
    assertNoForbiddenImports(files, 'source');
  });

  it('uses only core-internal and zod imports, so it is self-contained', () => {
    // zod is the one permitted external dependency: it is a pure schema library with no
    // host dependency, and it is how the document model gets its structural validation.
    // Everything else must be relative, i.e. inside core.
    const files = collectFiles(distCoreRoot, ['.js']);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of importedSpecifiers(source)) {
        const allowed = specifier.startsWith('.') || specifier === 'zod';
        expect(
          allowed,
          `${relative(projectRoot, file)} imports non-relative "${specifier}". ` +
            'core may depend only on itself and zod.',
        ).toBe(true);
      }
    }
  });

  it('does not import the infrastructure layer (dependency direction)', () => {
    // Infrastructure may consume core — that is how the server uses the document model.
    // Core may never consume infrastructure: an import of `server` from `core` would let
    // a filesystem or process dependency leak back into the pure layer, which is the one
    // direction that breaks the browser-preview / export-worker parity mechanism.
    for (const file of collectFiles(coreRoot, ['.ts'])) {
      const source = readFileSync(file, 'utf8');
      for (const specifier of importedSpecifiers(source)) {
        expect(
          specifier.includes('server'),
          `${relative(projectRoot, file)} imports "${specifier}" — core must not depend on infrastructure.`,
        ).toBe(false);
      }
    }
  });

  it('uses no browser DOM globals', () => {
    const files = collectFiles(distCoreRoot, ['.js']);
    for (const file of files) {
      // Strip comments before scanning: prose in a doc comment ("...from a document to a
      // new document") must not be mistaken for code. The check is about what the module
      // *does*, not what it says.
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      // `globalThis` is allowed (ids.ts uses globalThis.crypto, which exists in both Node
      // and browsers). Direct DOM identifiers are not. The word boundary prevents a
      // match on identifiers that merely end in "Document", such as ProjectDocument.
      const domPatterns = [
        /\bdocument\s*\./,
        /\bwindow\s*\./,
        /\blocalStorage\b/,
        /\bnavigator\s*\./,
        /\bHTMLElement\b/,
      ];
      for (const pattern of domPatterns) {
        expect(
          pattern.test(code),
          `${relative(projectRoot, file)} references the DOM global ${pattern}`,
        ).toBe(false);
      }
    }
  });
});

describe('phase 1 scope', () => {
  it('contains no UI directories in src', () => {
    // The web app arrives in Phase 7. Creating it now would be speculative structure
    // with no consumer.
    for (const forbidden of ['web', 'ui', 'components', 'routes']) {
      let exists = true;
      try {
        statSync(join(srcRoot, forbidden));
      } catch {
        exists = false;
      }
      expect(exists, `${forbidden}/ should not exist yet`).toBe(false);
    }
  });

  it('keeps media and transcription out of the server layer', () => {
    // Phase 1 runs ffprobe; it must not transcode (Phase 3), transcribe (Phase 4), or
    // render/export (Phase 8). Those are separate, later capabilities.
    const serverRoot = join(srcRoot, 'server');
    expect(statSync(serverRoot).isDirectory()).toBe(true);
    const files = collectFiles(serverRoot, ['.ts']);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of [
        /\btranscrib/i,
        /\bfaster-whisper\b/i,
        /\bwhisper\b/i,
        /\bsrt\b(?![a-z])/i,
        /\bvtt\b(?![a-z])/i,
        /\bsubtitles=\S/,
        /\bexport\b\s*=\s*['"]video/,
      ]) {
        expect(
          pattern.test(source),
          `${relative(projectRoot, file)} matches ${pattern} — that belongs to a later phase`,
        ).toBe(false);
      }
    }
  });

  it('never spawns ffmpeg — only ffprobe, which is read-only', () => {
    // Phase 1 inspects media. It must not invoke the ffmpeg binary, which is what
    // transcoding and export would use.
    const files = collectFiles(join(srcRoot, 'server'), ['.ts']);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source.includes("'ffmpeg'"), `${relative(projectRoot, file)} spawns ffmpeg`).toBe(
        false,
      );
      expect(source.includes('"ffmpeg"'), `${relative(projectRoot, file)} spawns ffmpeg`).toBe(
        false,
      );
    }
  });

  it('does not depend on a web framework in Phase 1', () => {
    // D-7b deferred the framework decision. The Phase 1 surface is three routes, so the
    // server uses node:http directly. A framework here would be adopting a decision that
    // was explicitly deferred, on no evidence.
    const pkg = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const framework of ['fastify', 'express', 'koa', 'hono', '@hapi/hapi']) {
      expect(
        all[framework],
        `${framework} was deferred and should not be a dependency yet`,
      ).toBeUndefined();
    }
  });
});
