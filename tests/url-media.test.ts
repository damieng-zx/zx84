import { describe, expect, it, vi } from 'vitest';
import {
  loadStartupMedia, parseStartupMedia,
  type StartupMediaDependencies,
} from '@/shell/url-media.ts';

function response(
  bytes: number[],
  url: string,
  disposition: string | null = null,
  ok = true,
  status = 200,
): Awaited<ReturnType<NonNullable<StartupMediaDependencies['fetch']>>> {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Not Found',
    url,
    headers: { get: (name) => name.toLowerCase() === 'content-disposition' ? disposition : null },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  };
}

describe('startup URL media parameters', () => {
  it('orders snapshot first, disks by zero-based unit, and tape last', () => {
    expect(parseStartupMedia(
      '?tape=https%3A%2F%2Fexample.com%2Fgame.tap'
      + '&disk2=https%3A%2F%2Fexample.com%2Fc.dsk'
      + '&snap=https%3A%2F%2Fexample.com%2Fstate.sna'
      + '&disk0=https%3A%2F%2Fexample.com%2Fa.dsk',
    )).toEqual([
      { param: 'snap', kind: 'snapshot', url: 'https://example.com/state.sna' },
      { param: 'disk0', kind: 'disk', url: 'https://example.com/a.dsk', unit: 0 },
      { param: 'disk2', kind: 'disk', url: 'https://example.com/c.dsk', unit: 2 },
      { param: 'tape', kind: 'tape', url: 'https://example.com/game.tap' },
    ]);
  });

  it('fetches relative and absolute URLs and mounts with decoded filenames', async () => {
    const fetched: string[] = [];
    const mounted: { bytes: number[]; name: string; unit?: number }[] = [];
    await loadStartupMedia(
      '?snap=%2Fmedia%2Fstate%2520one.sna&disk1=https%3A%2F%2Fcdn.example%2Fdisk.dsk',
      {
        baseUrl: 'https://zx84.example/app/',
        fetch: async (url) => {
          fetched.push(url);
          return response([fetched.length], url);
        },
        load: async (data, name, unit) => {
          mounted.push({ bytes: Array.from(data), name, unit });
        },
      },
    );

    expect(fetched).toEqual([
      'https://zx84.example/media/state%20one.sna',
      'https://cdn.example/disk.dsk',
    ]);
    expect(mounted).toEqual([
      { bytes: [1], name: 'state one.sna', unit: undefined },
      { bytes: [2], name: 'disk.dsk', unit: 1 },
    ]);
  });

  it('uses a Content-Disposition filename after redirects', async () => {
    const load = vi.fn(async () => {});
    await loadStartupMedia('?tape=https%3A%2F%2Fexample.com%2Fdownload%3Fid%3D7', {
      fetch: async () => response(
        [0xFF],
        'https://cdn.example/object/7',
        "attachment; filename*=UTF-8''Toado%20%281984%29.mtx",
      ),
      load,
    });

    expect(load).toHaveBeenCalledWith(
      Uint8Array.from([0xFF]),
      'Toado (1984).mtx',
      undefined,
    );
  });

  it('reports a failed fetch and continues with the remaining media', async () => {
    const load = vi.fn(async () => {});
    const status = vi.fn();
    await loadStartupMedia(
      '?snap=https%3A%2F%2Fexample.com%2Fmissing.sna'
      + '&tape=https%3A%2F%2Fexample.com%2Fgame.tap',
      {
        fetch: async (url) => url.endsWith('missing.sna')
          ? response([], url, null, false, 404)
          : response([1, 2], url),
        load,
        status,
      },
    );

    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(Uint8Array.from([1, 2]), 'game.tap', undefined);
    expect(status).toHaveBeenCalledWith('URL media load failed — snap: HTTP 404 Not Found');
  });

  it('rejects non-HTTP protocols without fetching them', async () => {
    const fetchMedia = vi.fn();
    const load = vi.fn();
    const status = vi.fn();
    await loadStartupMedia('?tape=file%3A%2F%2F%2FC%3A%2Fsecret.tap', {
      fetch: fetchMedia,
      load,
      status,
    });

    expect(fetchMedia).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(
      'URL media load failed — tape: unsupported URL protocol file:',
    );
  });
});
