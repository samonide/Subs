// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

import { App } from '../src/web/App.js';
import { PROJECT_ID_STORAGE_KEY } from '../src/web/storage.js';

const DESCRIPTOR = {
  projectId: 'proj1',
  name: 'Test project',
  asset: {
    assetId: 'asset1',
    meta: {
      durationMs: 10_000,
      width: 160,
      height: 120,
      frameRateNum: 30000,
      frameRateDen: 1001,
      frameRateMode: 'cfr',
      codec: 'h264',
    },
  },
  mediaUrl: '/media/proj1/asset1',
};

/**
 * A video element jsdom will never actually decode. Stubbing the *media network* is
 * legitimate — the server is tested for real elsewhere — but element playback is
 * uncontrollable here, so tests drive it through dispatched events.
 */
function installVideoStub(): {
  setDuration: (seconds: number) => void;
  setTime: (seconds: number) => void;
} {
  let currentTime = 0;
  let duration = 0;
  let paused = true;

  const proto = window.HTMLMediaElement.prototype;
  vi.spyOn(proto, 'duration', 'get').mockImplementation(() => duration);
  vi.spyOn(proto, 'currentTime', 'get').mockImplementation(() => currentTime);
  Object.defineProperty(proto, 'currentTime', {
    set(this: HTMLMediaElement, value: number) {
      currentTime = value;
    },
    configurable: true,
  });
  vi.spyOn(proto, 'paused', 'get').mockImplementation(() => paused);
  vi.spyOn(proto, 'play').mockImplementation(() => {
    paused = false;
    const el = document.querySelector('video');
    el?.dispatchEvent(new Event('play'));
    el?.dispatchEvent(new Event('playing'));
    return Promise.resolve();
  });
  vi.spyOn(proto, 'pause').mockImplementation(() => {
    paused = true;
    document.querySelector('video')?.dispatchEvent(new Event('pause'));
  });

  return {
    setDuration(seconds: number) {
      duration = seconds;
    },
    setTime(seconds: number) {
      currentTime = seconds;
    },
  };
}

function stubFetch(impl: (url: string) => unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      // A `Request` stringifies to "[object Request]", which would silently stop matching
      // the routes, so the URL is read from the property that actually holds it.
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const result = impl(url) as { status?: number; body?: unknown };
      const status = result?.status ?? 200;
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(result.body),
      } as Response);
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App — project loading', () => {
  it('prompts for a project when none is remembered', () => {
    stubFetch(() => ({ status: 404, body: {} }));
    render(<App />);
    expect(screen.getByText(/enter a project id/i)).toBeInTheDocument();
  });

  it('loads a project and shows its media metadata', async () => {
    stubFetch(() => ({ status: 200, body: DESCRIPTOR }));
    window.localStorage.setItem(PROJECT_ID_STORAGE_KEY, 'proj1');
    installVideoStub();

    render(<App />);

    await waitFor(() => expect(screen.getByText(/Test project/)).toBeInTheDocument());
    // The exact rational rate, never a rounded decimal.
    expect(screen.getByText(/30000\/1001 fps/)).toBeInTheDocument();
    expect(document.querySelector('video')).toBeTruthy();
  });

  it('reports a project with no video as a state, not an error', async () => {
    stubFetch(() => ({
      status: 200,
      body: { ...DESCRIPTOR, asset: null, mediaUrl: null },
    }));
    window.localStorage.setItem(PROJECT_ID_STORAGE_KEY, 'proj1');
    installVideoStub();

    render(<App />);

    await waitFor(() => expect(screen.getByText(/no ingested video/i)).toBeInTheDocument());
    expect(screen.getByText('No media loaded')).toBeInTheDocument();
  });

  it('shows a useful message when a project cannot be loaded', async () => {
    stubFetch(() => ({
      status: 404,
      body: { error: { code: 'PROJECT_NOT_FOUND', message: 'Project nosuch does not exist.' } },
    }));
    window.localStorage.setItem(PROJECT_ID_STORAGE_KEY, 'nosuch');
    installVideoStub();

    render(<App />);

    await waitFor(() => expect(screen.getByText(/does not exist/)).toBeInTheDocument());
  });
});

describe('App — transport controls', () => {
  beforeEach(() => {
    stubFetch(() => ({ status: 200, body: DESCRIPTOR }));
    window.localStorage.setItem(PROJECT_ID_STORAGE_KEY, 'proj1');
  });

  it('disables frame stepping until metadata is available', async () => {
    installVideoStub();
    render(<App />);
    await screen.findByText(/Test project/);

    const next = screen.getByRole('button', { name: 'Next frame' });
    const prev = screen.getByRole('button', { name: 'Previous frame' });
    // No duration yet, so there is no frame grid to step on.
    expect(next).toBeDisabled();
    expect(prev).toBeDisabled();
  });

  it('enables frame stepping once the media reports a duration', async () => {
    const video = installVideoStub();
    render(<App />);
    await screen.findByText(/Test project/);

    const element = document.querySelector('video') as HTMLVideoElement;
    video.setDuration(10);
    element.dispatchEvent(new Event('durationchange'));
    element.dispatchEvent(new Event('loadedmetadata'));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Next frame' })).toBeEnabled());
  });

  it('disables frame stepping for variable frame rate media, and explains why', async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        ...DESCRIPTOR,
        asset: { ...DESCRIPTOR.asset, meta: { ...DESCRIPTOR.asset.meta, frameRateMode: 'vfr' } },
      },
    }));
    const video = installVideoStub();
    render(<App />);
    await screen.findByText(/Test project/);

    const element = document.querySelector('video') as HTMLVideoElement;
    video.setDuration(10);
    element.dispatchEvent(new Event('durationchange'));
    element.dispatchEvent(new Event('loadedmetadata'));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Next frame' })).toBeDisabled());
    // The reason is stated, not left to guesswork.
    expect(screen.getByText(/variable frame rate/i)).toBeInTheDocument();
  });

  it('shows the frame rate as unknown rather than assuming one', async () => {
    stubFetch(() => ({
      status: 200,
      body: {
        ...DESCRIPTOR,
        asset: {
          assetId: 'asset1',
          meta: { durationMs: 10_000, width: 160, height: 120 },
        },
      },
    }));
    const video = installVideoStub();
    render(<App />);
    await screen.findByText(/Test project/);

    const element = document.querySelector('video') as HTMLVideoElement;
    video.setDuration(10);
    element.dispatchEvent(new Event('durationchange'));
    element.dispatchEvent(new Event('loadedmetadata'));

    await waitFor(() => expect(screen.getByText('frame rate unknown')).toBeInTheDocument());
    // The readout degrades to milliseconds rather than inventing a frame count.
    expect(screen.getByText('00:00:10.000')).toBeInTheDocument();
  });
});

describe('App — keyboard controls', () => {
  beforeEach(() => {
    stubFetch(() => ({ status: 200, body: DESCRIPTOR }));
    window.localStorage.setItem(PROJECT_ID_STORAGE_KEY, 'proj1');
  });

  it('toggles playback with Space', async () => {
    installVideoStub();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/Test project/);

    const element = document.querySelector('video') as HTMLVideoElement;
    const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'play');

    await user.keyboard(' ');
    expect(playSpy).toHaveBeenCalled();
    expect(element.paused).toBe(false);
  });

  it('does not fire shortcuts while typing in an input', async () => {
    installVideoStub();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/Test project/);

    const input: HTMLInputElement = screen.getByPlaceholderText(/paste a project id/);
    const playSpy = vi.spyOn(window.HTMLMediaElement.prototype, 'play');

    await user.click(input);
    await user.keyboard(' ');

    // A space typed into a field must stay a space.
    expect(playSpy).not.toHaveBeenCalled();
    expect(input.value).toContain(' ');
  });

  it('steps frames with the arrow keys', async () => {
    const video = installVideoStub();
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText(/Test project/);

    const element = document.querySelector('video') as HTMLVideoElement;
    video.setDuration(10);
    element.dispatchEvent(new Event('durationchange'));
    element.dispatchEvent(new Event('loadedmetadata'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next frame' })).toBeEnabled());

    // Sit on frame 0's own start, so a single step must land on frame 1.
    video.setTime(0);
    element.dispatchEvent(new Event('timeupdate'));

    await user.keyboard('{ArrowRight}');
    // Frame 1 at 30000/1001 begins at 34ms. At 30fps it would be 34ms too, but the
    // *following* frame diverges — 67ms vs 67ms here, 100ms at 30fps — which is why the
    // exact rational matters and is covered exhaustively in playback-time.test.ts.
    await waitFor(() => expect(Math.round(element.currentTime * 1000)).toBe(34));

    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(Math.round(element.currentTime * 1000)).toBe(67));
  });
});

describe('App — error state', () => {
  it('surfaces a media decode failure with a recoverable message', async () => {
    stubFetch(() => ({ status: 200, body: DESCRIPTOR }));
    window.localStorage.setItem(PROJECT_ID_STORAGE_KEY, 'proj1');
    installVideoStub();
    render(<App />);
    await screen.findByText(/Test project/);

    const element = document.querySelector('video') as HTMLVideoElement;
    Object.defineProperty(element, 'error', { get: () => ({ code: 4 }), configurable: true });
    element.dispatchEvent(new Event('error'));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/not supported by your browser/i);
    });
    // Never a stack trace or a path.
    expect(screen.getByRole('alert').textContent).not.toMatch(/at Object/);
    expect(screen.getByRole('alert').textContent).not.toContain('/');
  });
});
