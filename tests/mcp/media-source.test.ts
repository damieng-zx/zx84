import { describe, expect, it, vi } from 'vitest';
import { resolveMediaSource, type MediaFetcher } from '../../mcp/media-source.ts';

function response(
  data: number[],
  url: string,
  disposition: string | null = null,
  ok = true,
  status = 200,
): Awaited<ReturnType<MediaFetcher>> {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Not Found',
    url,
    headers: { get: (name) => name.toLowerCase() === 'content-disposition' ? disposition : null },
    arrayBuffer: async () => Uint8Array.from(data).buffer,
  };
}

describe('MCP media source URLs', () => {
  it('downloads bytes and decodes the redirected URL filename', async () => {
    const fetcher = vi.fn(async () => response(
      [0x01, 0x02],
      'https://cdn.example/tapes/Toado%20(1984).mtx',
    ));

    await expect(resolveMediaSource('https://example.com/download?id=7', fetcher))
      .resolves.toEqual({
        data: Uint8Array.from([0x01, 0x02]),
        filename: 'Toado (1984).mtx',
        source: 'https://example.com/download?id=7',
      });
    expect(fetcher).toHaveBeenCalledWith('https://example.com/download?id=7');
  });

  it('prefers and sanitises a Content-Disposition filename', async () => {
    const source = await resolveMediaSource(
      'https://example.com/object/7',
      async () => response(
        [0xFF],
        'https://cdn.example/object/7',
        "attachment; filename*=UTF-8''folder%2Fgame.tap",
      ),
    );

    expect(source.filename).toBe('game.tap');
  });

  it('reports HTTP failures without returning partial media', async () => {
    await expect(resolveMediaSource(
      'https://example.com/missing.dsk',
      async (url) => response([], url, null, false, 404),
    )).rejects.toThrow(
      'Download failed: HTTP 404 Not Found (https://example.com/missing.dsk)',
    );
  });

  it('rejects URL protocols other than HTTP(S)', async () => {
    const fetcher = vi.fn();
    await expect(resolveMediaSource('ftp://example.com/game.tap', fetcher))
      .rejects.toThrow('Unsupported media URL protocol: ftp:');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
