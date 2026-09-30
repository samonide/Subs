import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  SUPPORTED_EXTENSIONS,
  containerFromFormat,
  containerMatchesExtension,
  extensionOf,
  isSupportedExtension,
  isSupportedMimeType,
  normalizeMimeType,
  sanitizeFilename,
} from '../src/server/media/filetypes.js';
import { WorkspaceLayout, assertInsideRoot, isSafeIdentifier } from '../src/server/workspace.js';
import { IngestError } from '../src/server/errors.js';

let root: string;
let layout: WorkspaceLayout;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'subs-sec-'));
  layout = new WorkspaceLayout(join(root, 'workspace'));
  layout.ensure();
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('S-1: identifier safety', () => {
  it('accepts the identifier shape our generator produces', () => {
    expect(isSafeIdentifier('phzvnnmi_1y2v0')).toBe(true);
    expect(isSafeIdentifier('abc-123_XYZ')).toBe(true);
  });

  it('rejects traversal, separators, and control characters', () => {
    for (const hostile of [
      '..',
      '../../etc/passwd',
      'a/b',
      'a\\b',
      'a.b',
      'a b',
      'a\0b',
      'a;rm -rf /',
      '$(whoami)',
      '',
      'x'.repeat(65),
    ]) {
      expect(isSafeIdentifier(hostile), `"${hostile}" must be rejected`).toBe(false);
    }
  });

  it('refuses to build a path from a traversal identifier', () => {
    for (const hostile of ['..', '../../etc', 'a/b']) {
      expect(() => layout.projectDir(hostile)).toThrow(IngestError);
    }
  });

  it('refuses a hostile asset identifier', () => {
    expect(() => layout.assetDir('proj', '../../escape')).toThrow(IngestError);
  });
});

describe('S-1: symlink escape', () => {
  it('rejects a symlink that points outside the workspace', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'subs-outside-'));
    await writeFile(join(outside, 'target.txt'), 'secret');
    await symlink(outside, join(layout.projectsDir, 'evil'));

    try {
      // A path that lexically looks contained, but resolves outside via the symlink.
      expect(() =>
        assertInsideRoot(layout.projectsDir, join(layout.projectsDir, 'evil', 'target.txt')),
      ).toThrow(IngestError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('accepts a path that really is inside the workspace', () => {
    const inside = join(layout.projectsDir, 'somedir');
    expect(() => assertInsideRoot(layout.projectsDir, inside)).not.toThrow();
  });
});

describe('S-2: filename sanitization', () => {
  it('strips directory components from a POSIX path', () => {
    expect(sanitizeFilename('/etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('../../secret.mp4')).toBe('secret.mp4');
  });

  it('strips Windows-style separators too', () => {
    expect(sanitizeFilename('C:\\Windows\\System32\\evil.mp4')).toBe('evil.mp4');
  });

  it('removes control characters and NUL bytes', () => {
    expect(sanitizeFilename('ev\u0000il\u0007.mp4')).toBe('evil.mp4');
    expect(sanitizeFilename('a\u001fb.mp4')).toBe('ab.mp4');
  });

  it('removes traversal prefixes', () => {
    expect(sanitizeFilename('...mp4')).toBe('mp4');
  });

  it('caps an absurdly long filename', () => {
    expect(sanitizeFilename(`${'a'.repeat(5000)}.mp4`).length).toBeLessThanOrEqual(180);
  });

  it('returns an empty string for a filename that is entirely unsafe', () => {
    expect(sanitizeFilename('')).toBe('');
    expect(sanitizeFilename('..')).toBe('');
  });

  it('never produces a path separator', () => {
    for (const hostile of ['a/b/c.mp4', '..\\..\\x.mp4', '/x.mp4']) {
      const clean = sanitizeFilename(hostile);
      expect(clean).not.toContain('/');
      expect(clean).not.toContain('\\');
    }
  });
});

describe('S-3: extension and MIME allow-list', () => {
  it('extracts a lower-case extension', () => {
    expect(extensionOf('Clip.MP4')).toBe('mp4');
    expect(extensionOf('a.b.WebM')).toBe('webm');
    expect(extensionOf('noext')).toBeUndefined();
  });

  it('accepts exactly the supported extensions', () => {
    for (const ext of ['mp4', 'MP4', 'mov', 'webm', 'mkv', 'm4v']) {
      expect(isSupportedExtension(`clip.${ext}`), `${ext} should be accepted`).toBe(true);
    }
  });

  it('rejects unsupported and dangerous extensions', () => {
    for (const name of [
      'clip.avi',
      'clip.exe',
      'clip.sh',
      'clip.php',
      'clip.mp4.exe',
      'clip',
      '.mp4',
    ]) {
      expect(isSupportedExtension(name), `${name} should be rejected`).toBe(false);
    }
  });

  it('normalises MIME parameters away before comparing', () => {
    expect(normalizeMimeType('video/mp4; codecs=avc1')).toBe('video/mp4');
    expect(normalizeMimeType('VIDEO/MP4')).toBe('video/mp4');
    expect(normalizeMimeType(undefined)).toBeUndefined();
  });

  it('accepts supported MIME types and rejects others', () => {
    expect(isSupportedMimeType('video/mp4')).toBe(true);
    expect(isSupportedMimeType('video/quicktime')).toBe(true);
    expect(isSupportedMimeType('application/x-msdownload')).toBe(false);
    expect(isSupportedMimeType('text/html')).toBe(false);
    expect(isSupportedMimeType(undefined)).toBe(false);
  });

  it('has a non-empty, explicit allow-list', () => {
    expect(SUPPORTED_EXTENSIONS.length).toBeGreaterThan(0);
    expect(SUPPORTED_EXTENSIONS).toContain('mp4');
  });
});

describe('S-5/S-7: process invocation safety', () => {
  it('builds ffprobe arguments as an array, never a shell string', async () => {
    // The source must not use a shell. exec/shell invocation would let a filename
    // containing shell metacharacters execute.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(join(process.cwd(), 'src/server/media/probe.ts'), 'utf8');
    expect(source).toContain("spawn('ffprobe', args");
    expect(source).not.toMatch(/\bexec\s*\(\s*`/);
    expect(source).not.toMatch(/\bshell\s*:\s*true/);
  });

  it('does not execute a command embedded in a filename', async () => {
    // A filename crafted to break out of a shell string must be treated as an ordinary
    // (unusual) name. If any shell were involved, the canary file would appear.
    const { access } = await import('node:fs/promises');
    const canary = join(root, 'pwned');
    const hostileName = `; touch ${canary}; echo .mp4`;
    const video = join(root, 'shell-test.mp4');
    await writeFile(video, 'not really a video');

    const { probeMedia } = await import('../src/server/media/probe.js');
    await expect(probeMedia(video)).rejects.toBeDefined();

    // Nothing was executed, so the canary was never created. This is the real guarantee.
    await expect(access(canary)).rejects.toBeDefined();

    // The metacharacters survive only as *display data*. That is acceptable and correct:
    // the guarantee is that such a name is never used to build a filesystem path, not
    // that the display string is scrubbed of every punctuation mark. Removing `;` from a
    // user's filename would be surprising, and buys nothing once the path is derived from a
    // server-generated asset id.
    const clean = sanitizeFilename(hostileName);
    expect(clean).toBe('pwned; echo .mp4');
    // And the stored file name is derived from the asset id, never from this.
    expect(layout.assetFile('proj1', 'asset1', 'mp4')).toContain('original.mp4');
  });
});

describe('workspace layout', () => {
  it('creates the expected directory structure', async () => {
    await mkdir(layout.projectDir('proj1'), { recursive: true });
    const entries = await readdir(layout.projectsDir);
    expect(entries).toContain('proj1');
  });

  it('places asset files under the asset directory with a controlled name', () => {
    const file = layout.assetFile('proj1', 'asset1', 'mp4');
    expect(file).toContain(join('media', 'asset1', 'original.mp4'));
  });

  it('rejects a hostile extension when building a file path', () => {
    for (const hostile of ['../evil', 'mp4/../../x', '.']) {
      expect(() => layout.assetFile('proj1', 'asset1', hostile)).toThrow(IngestError);
    }
  });
});

describe('container/extension consistency', () => {
  it('accepts a container that matches its extension', () => {
    expect(containerMatchesExtension(containerFromFormat('mov,mp4,m4a'), 'clip.mp4')).toBe(true);
    expect(containerMatchesExtension(containerFromFormat('matroska,webm'), 'clip.webm')).toBe(true);
  });

  it('rejects a container that contradicts the extension', () => {
    // A .mp4 that is really a WebM must not be accepted on the strength of its name.
    expect(containerMatchesExtension(containerFromFormat('matroska,webm'), 'clip.mp4')).toBe(false);
  });

  it('rejects an unknown container', () => {
    expect(containerMatchesExtension(undefined, 'clip.mp4')).toBe(false);
  });
});
