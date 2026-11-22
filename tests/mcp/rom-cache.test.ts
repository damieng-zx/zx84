/**
 * The MCP's on-disk ROM cache key.
 *
 * The cache used to be keyed by the file's basename, which silently merged
 * different chips that share a name — `electron/basic.rom` with
 * `memotech/basic.rom`, `electron/os.rom` with `memotech/os.rom`. Whichever was
 * fetched first then answered for both, so a machine booted with the wrong
 * firmware. These tests pin the key to the source's full path.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { CACHE_DIR, cacheFileFor } from '../../mcp/rom-fetch.ts';

describe('MCP ROM cache path', () => {
  it('keeps two machines\' same-named ROMs in different files', () => {
    const electron = cacheFileFor('electron/basic.rom');
    const memotech = cacheFileFor('memotech/basic.rom');
    expect(electron).not.toBe(memotech);
  });

  it('puts a relative source under the cache directory, keeping its path', () => {
    expect(cacheFileFor('sinclair/48.rom')).toBe(path.join(CACHE_DIR, 'sinclair', '48.rom'));
    expect(cacheFileFor('sinclair/48.rom')).toBe(path.join(CACHE_DIR, 'sinclair', '48.rom'));
  });

  it('flattens a bare filename to the cache root', () => {
    expect(cacheFileFor('48.rom')).toBe(path.join(CACHE_DIR, '48.rom'));
  });

  it('keys a full URL by the pathname it names, not by the host', () => {
    const a = cacheFileFor('https://example.com/roms/bbc/os12.rom');
    const b = cacheFileFor('https://mirror.example/roms/bbc/os12.rom');
    expect(a).toBe(b);
    expect(a).toBe(path.join(CACHE_DIR, 'roms', 'bbc', 'os12.rom'));
  });

  it('never escapes the cache directory', () => {
    const out = cacheFileFor('../../../etc/passwd');
    expect(out.startsWith(CACHE_DIR + path.sep)).toBe(true);
    expect(out).toBe(path.join(CACHE_DIR, 'etc', 'passwd'));
  });

  it('treats Windows and POSIX separators the same', () => {
    expect(cacheFileFor('acorn-system\\sysdos80.rom'))
      .toBe(path.join(CACHE_DIR, 'acorn-system', 'sysdos80.rom'));
  });
});
