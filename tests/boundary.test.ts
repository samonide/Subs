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
import { join, relative, sep } from 'node:path';
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

/**
 * Strip comments from TypeScript source.
 *
 * Several scope checks assert that a capability is *absent*. Without this, a comment
 * explaining why a duration check matters would register as an implementation of subtitles —
 * and the fix an agent reaches for is to delete the explanation. Matching code rather than
 * prose is what keeps these checks usable as documentation grows.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
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
  const serverRoot = join(srcRoot, 'server');

  it('keeps later-phase capabilities out of the ingest path', () => {
    // Phase 1 ingests and inspects. Transcoding (Phase 3), transcription (Phase 4), and
    // render/export (Phase 8) are separate capabilities. As each phase lands, its own
    // directory is excluded here rather than the check being deleted — the ingest path must stay
    // free of them, and that is still worth asserting.
    // Paths are relative to the server root, matching `relative(serverRoot, file)`.
    const LATER_PHASE_PATHS = ['transcription', 'media/audio.ts', 'media/ffmpeg.ts', 'jobs'];
    const files = collectFiles(serverRoot, ['.ts']).filter((file) => {
      const rel = relative(serverRoot, file).split(sep).join('/');
      return !LATER_PHASE_PATHS.some(
        (excluded) => rel === excluded || rel.startsWith(`${excluded}/`),
      );
    });

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

  it('spawns ffmpeg only from the Phase 3 media adapter', () => {
    // Phase 1 was read-only (ffprobe only). Phase 3 legitimately introduced transcoding for
    // audio extraction — but only in one adapter. Concentrating argv construction in a single
    // file is what makes the "safe argument array" claim auditable, so the check is not
    // "ffmpeg appears nowhere" but "ffmpeg appears in exactly one place".
    const offenders: string[] = [];
    for (const file of collectFiles(join(srcRoot, 'server'), ['.ts'])) {
      const source = readFileSync(file, 'utf8');
      if (source.includes("'ffmpeg'") || source.includes('"ffmpeg"')) {
        offenders.push(relative(projectRoot, file));
      }
    }
    expect(offenders).toEqual(['src/server/media/ffmpeg.ts']);
  });

  it('does not depend on a web framework', () => {
    // D-7b deferred the framework decision. The server surface is a handful of routes, so it
    // uses node:http directly. A framework here would be adopting a deferred decision on
    // no evidence.
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

describe('phase 2 scope', () => {
  it('contains no editor UI beyond the single browser surface', () => {
    // The editor UI arrives in Phase 7. A `components/` or `ui/` tree now would be
    // speculative structure with no consumer — Phase 2 builds exactly one surface.
    for (const forbidden of ['ui', 'components', 'routes']) {
      let exists = true;
      try {
        statSync(join(srcRoot, forbidden));
      } catch {
        exists = false;
      }
      expect(exists, `${forbidden}/ should not exist yet`).toBe(false);
    }
  });

  it('adds no subtitle editing, styling, or rendering implementation', () => {
    // Phases 0, 2, and 4 built the *shapes*: segment/word/style types, `applyWorkerResult`,
    // ASS/SRT timecode helpers, a provider interface, and one provider adapter. Those are the
    // correct groundwork and must not be flagged.
    //
    // What still does not exist is everything Phase 5 onwards: a timeline, a styling UI, a
    // renderer, an ASS writer, an exporter. Those are what this asserts, so the gate keeps
    // doing its job as the phase boundary moves.
    const forbidden: [RegExp, string][] = [
      [/\bsubtitles=/, 'an ffmpeg subtitle burn-in'],
      [/\bkaraoke/i, 'karaoke highlight rendering'],
      [/renderAss|writeAss|assDocumentFrom/, 'an ASS renderer'],
      [/\bexportVideo|\brenderToFile\b/, 'a video exporter'],
      [/\bfabric\b|\bkonva\b|\bremotion\b/i, 'a canvas or media editor library'],
    ];
    for (const file of collectFiles(srcRoot, ['.ts', '.tsx'])) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const [pattern, description] of forbidden) {
        expect(
          pattern.test(source),
          `${relative(projectRoot, file)} contains ${description} — that belongs to a later phase`,
        ).toBe(false);
      }
    }
  });

  it('keeps the provider boundary: core defines no provider implementations', () => {
    // Core holds the interface and the normalizer — both pure. A concrete adapter means a
    // dependency from core onto a network or a vendor, which would break the boundary the
    // whole architecture rests on.
    for (const file of collectFiles(join(srcRoot, 'core'), ['.ts'])) {
      const source = readFileSync(file, 'utf8');
      expect(
        /from\s*['"][^'"]*(openai|whisper|deepgram|assemblyai|groq)/i.test(source),
        `${relative(projectRoot, file)} imports a concrete provider into core`,
      ).toBe(false);
      expect(source, `${relative(projectRoot, file)} performs network I/O in core`).not.toMatch(
        /\bfetch\s*\(/,
      );
    }
  });

  it('keeps vendor vocabulary inside the adapter', () => {
    // `word`, `probability`, `verbose_json`, and `timestamp_granularities` are OpenAI's names.
    // If any of them reaches core, the provider boundary has leaked and a second provider would
    // have to fight the first one's vocabulary.
    const vendorTerms = [/verbose_json/, /timestamp_granularities/, /\bprobability\b/];
    for (const file of collectFiles(join(srcRoot, 'core'), ['.ts'])) {
      const source = stripComments(readFileSync(file, 'utf8'));
      for (const pattern of vendorTerms) {
        expect(
          pattern.test(source),
          `${relative(projectRoot, file)} contains vendor term ${pattern} in core`,
        ).toBe(false);
      }
    }
  });

  it('keeps React out of core and server', () => {
    // The browser layer may consume core; core and server must never reach up into it.
    for (const dir of ['core', 'server']) {
      for (const file of collectFiles(join(srcRoot, dir), ['.ts', '.tsx'])) {
        const source = readFileSync(file, 'utf8');
        for (const pattern of [/\bfrom\s*['"]react/, /\bfrom\s*['"]react-dom/]) {
          expect(
            pattern.test(source),
            `${relative(projectRoot, file)} imports React — only src/web may`,
          ).toBe(false);
        }
      }
    }
  });

  it('keeps the browser layer free of Node-only APIs', () => {
    // The reverse direction of the core boundary: web code runs in a browser, so it must
    // not reach for the filesystem or spawn processes.
    const forbidden = [/\bfrom\s*['"]node:/, /\brequire\s*\(/, /\bprocess\./];
    for (const file of collectFiles(join(srcRoot, 'web'), ['.ts', '.tsx'])) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of forbidden) {
        expect(
          pattern.test(source),
          `${relative(projectRoot, file)} uses ${pattern} — the browser has no such API`,
        ).toBe(false);
      }
    }
  });

  it('converts browser seconds to milliseconds in exactly one place', () => {
    // The single conversion boundary. Scattering `Math.round(x * 1000)` through components
    // is how two subtly different rounding rules end up producing off-by-one-frame
    // subtitle drift, so the conversion is asserted to exist in one file and nowhere else.
    const offenders: string[] = [];
    for (const file of collectFiles(join(srcRoot, 'web'), ['.ts', '.tsx'])) {
      if (file.endsWith(join('playback', 'time.ts'))) {
        continue; // The boundary itself.
      }
      const source = readFileSync(file, 'utf8');
      // Strip comments so documentation of the rule is not mistaken for a second use.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/Math\.round\([^)]*currentTime[^)]*\*\s*1000/.test(code)) {
        offenders.push(relative(projectRoot, file));
      }
    }
    expect(offenders, 'seconds→ms conversion must live only in playback/time.ts').toEqual([]);
  });

  it('agrees with the server on the port the dev proxy targets', () => {
    // The Vite dev proxy and the API server must listen on the same port, or the browser
    // silently fails to load media in development while every test still passes. A literal
    // repeated in two files drifts; this test exists to catch it when it does.
    const main = readFileSync(join(srcRoot, 'server', 'main.ts'), 'utf8');
    const serverPort = /const DEFAULT_PORT = (\d+);/.exec(main)?.[1];
    expect(serverPort, 'DEFAULT_PORT not found in main.ts').toBeDefined();

    const viteConfig = readFileSync(join(projectRoot, 'vite.config.ts'), 'utf8');
    const proxyPort = /const SERVER_PORT = (\d+);/.exec(viteConfig)?.[1];
    expect(proxyPort, 'SERVER_PORT not found in vite.config.ts').toBeDefined();

    expect(proxyPort, 'dev proxy and API server must use the same port').toBe(serverPort);
  });
});

describe('phase 3 scope', () => {
  it('keeps transcription, subtitle, and rendering out of the media pipeline', () => {
    // Phase 3's job was VIDEO → AUDIO → VERIFIED PROCESSING RESULT. Phase 4 added transcription
    // in `server/transcription/`, so that directory is now legitimate — but the *media* pipeline
    // must stay exactly as narrow as Phase 3 left it: extraction knows nothing about
    // speech-to-text, and knows nothing about subtitles or rendering.
    //
    // Comments are stripped before matching, because prose about *why* audio duration matters
    // mentions subtitles, and a check that flags its own documentation trains the next agent to
    // delete the explanation that makes the code reviewable.
    const files = collectFiles(join(srcRoot, 'server', 'media'), ['.ts']);
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf8'));
      // Patterns name *machinery*, not vocabulary. A plain /subtitle/i would flag the error
      // string that explains why a duration mismatch matters — and the fix an agent reaches
      // for is to delete the one message a user would actually understand.
      for (const pattern of [
        /\bwhisper\b/i,
        /\bfaster-whisper\b/i,
        /\btranscrib/i,
        /subtitles=\S/,
        /\bass=\S/,
        /force_style/,
        /\blibass\b/i,
        /-c:v\s+libx264/,
        /\bSubtitleSegment\b|\bSubtitleTrack\b|\bSubtitleWord\b/,
      ]) {
        expect(
          pattern.test(code),
          `${relative(projectRoot, file)} matches ${pattern} — that belongs to a later phase`,
        ).toBe(false);
      }
    }
  });

  it('keeps the job domain model in core, free of Node and the filesystem', () => {
    // Job types and the state machine are domain logic: the browser may want to render job
    // status, and a future phase may want to run the same transition logic off the server.
    // Putting them in the server would make that impossible.
    const jobsDir = join(srcRoot, 'core', 'jobs');
    expect(statSync(jobsDir).isDirectory()).toBe(true);
    for (const file of collectFiles(jobsDir, ['.ts'])) {
      const code = stripComments(readFileSync(file, 'utf8'));
      expect(code).not.toMatch(/from 'node:/);
      // Timestamps are injected by the caller so transitions stay deterministic; a clock read
      // here would make the same inputs produce different records on every run.
      expect(code).not.toMatch(/Date\.now/);
      expect(code).not.toMatch(/new Date\(/);
    }
  });

  it('keeps worker and job persistence out of core', () => {
    // The dependency direction: core knows nothing about jobs' *execution*. Only the pure
    // model lives there.
    const coreFiles = collectFiles(join(srcRoot, 'core'), ['.ts']);
    for (const file of coreFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/child_process/);
      expect(source).not.toMatch(/'ffmpeg'/);
    }
  });

  it('spawns no subprocess through a shell', () => {
    // An argument array plus a default (non-shell) spawn means a filename cannot become a
    // command. `shell: true` anywhere would void that guarantee entirely.
    for (const file of collectFiles(join(srcRoot, 'server'), ['.ts'])) {
      const source = readFileSync(file, 'utf8');
      expect(
        /shell:\s*true/.test(source),
        `${relative(projectRoot, file)} enables shell execution`,
      ).toBe(false);
      expect(source).not.toMatch(/execSync/);
      expect(source).not.toMatch(/`\$\{[^}]*\}\s*ffmpeg/);
    }
  });

  it('defines exactly the job types the completed phases need', () => {
    // JobType exists so later phases add types in one place rather than scattering strings.
    // This assertion is the phase gate: it fails when a new capability lands, prompting a
    // deliberate update rather than a silent widening of the job surface.
    //
    // Phases 0–3 shipped exactly one (audio extraction). Phase 4 added transcription. Nothing
    // beyond that is implemented, so nothing beyond that may be declared.
    const types = readFileSync(join(srcRoot, 'core', 'jobs', 'types.ts'), 'utf8');
    const block = /export const JobType = \{([^}]*)\}/s.exec(types)?.[1] ?? '';
    const entries = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(entries).toEqual(['media.audio-extract', 'transcription.transcribe']);
  });
});
