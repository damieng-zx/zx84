/**
 * Game library catalog helpers.
 *
 * Game files are tried CDN-first (the R2 public domain), then the zxfileserver
 * Worker; fileUrls returns those candidates in order. Absolute http(s) links are
 * the sole candidate. The bases are hard-coded here independently of the
 * implementation so a wrong base in the code is caught.
 */

import { describe, it, expect } from 'vitest';
import { fileUrls, basename, shortPublisher, resolveGame, parseLibraryQuery, type RawCatalog } from '@/library/catalog.ts';

const CDN = 'https://zx84files.bitsparse.com/library';
const PROXY = 'https://zxfileserver.envytech.workers.dev';

describe('fileUrls', () => {
  it('tries the CDN first, then the worker, for /pub/ links', () => {
    expect(fileUrls('/pub/sinclair/games/m/ManicMiner.tzx.zip')).toEqual([
      `${CDN}/pub/sinclair/games/m/ManicMiner.tzx.zip`,
      `${PROXY}/pub/sinclair/games/m/ManicMiner.tzx.zip`,
    ]);
  });

  it('tries the CDN first, then the worker, for /zxdb/ links', () => {
    expect(fileUrls('/zxdb/sinclair/entries/0000001/Thing.tap.zip')).toEqual([
      `${CDN}/zxdb/sinclair/entries/0000001/Thing.tap.zip`,
      `${PROXY}/zxdb/sinclair/entries/0000001/Thing.tap.zip`,
    ]);
  });

  it('returns an absolute http(s) link as the sole candidate', () => {
    expect(fileUrls('https://example.com/Game.tzx.zip')).toEqual(['https://example.com/Game.tzx.zip']);
  });

  it('returns no candidates for an empty/missing link', () => {
    expect(fileUrls('')).toEqual([]);
    expect(fileUrls(undefined)).toEqual([]);
    expect(fileUrls(null)).toEqual([]);
  });

  it('handles a link without a leading slash without doubling it', () => {
    expect(fileUrls('other/x.zip')).toEqual([`${CDN}/other/x.zip`, `${PROXY}/other/x.zip`]);
  });
});

describe('parseLibraryQuery', () => {
  it('separates free title text from year: and publisher: tokens', () => {
    expect(parseLibraryQuery('manic year:1983 publisher:ocean'))
      .toEqual({ text: 'manic', year: 1983, publisher: 'ocean' });
  });

  it('joins multiple free words and lower-cases everything', () => {
    expect(parseLibraryQuery('Jet Set Willy'))
      .toEqual({ text: 'jet set willy', year: null, publisher: '' });
  });

  it('returns empty for a blank query', () => {
    expect(parseLibraryQuery('   ')).toEqual({ text: '', year: null, publisher: '' });
  });

  it('ignores a non-numeric year token', () => {
    expect(parseLibraryQuery('year:abc thing').year).toBeNull();
    expect(parseLibraryQuery('year:abc thing').text).toBe('thing');
  });
});

describe('shortPublisher', () => {
  it('strips trailing legal suffixes', () => {
    expect(shortPublisher('Mastertronic Ltd')).toBe('Mastertronic');
    expect(shortPublisher('Ocean Software Ltd')).toBe('Ocean Software');
    expect(shortPublisher('Domark Ltd')).toBe('Domark');
    expect(shortPublisher('CRL Group PLC')).toBe('CRL Group');
    expect(shortPublisher('Erbe Software, S.A.')).toBe('Erbe Software');
  });

  it('leaves brand-internal words and short names intact', () => {
    expect(shortPublisher('U.S. Gold Ltd')).toBe('U.S. Gold');   // "Gold" is not a suffix
    expect(shortPublisher('Virgin Games Ltd')).toBe('Virgin Games');
    expect(shortPublisher('CCS')).toBe('CCS');
    expect(shortPublisher('The Guild')).toBe('The Guild');
  });

  it('never returns empty', () => {
    expect(shortPublisher('Ltd')).toBe('Ltd');
  });
});

describe('basename', () => {
  it('extracts the filename from a deep path', () => {
    expect(basename('/pub/sinclair/games/m/ManicMiner.tzx.zip')).toBe('ManicMiner.tzx.zip');
  });

  it('returns the input when there is no slash', () => {
    expect(basename('JetPac.tap.zip')).toBe('JetPac.tap.zip');
  });
});

describe('resolveGame', () => {
  const cat: RawCatalog = {
    genres: ['Arcade: Action', 'Utility'],
    publishers: ['Ultimate', 'Ocean'],
    games: [],
  };

  it('expands genre/publisher indices and prefers the tape over the disk', () => {
    const g = resolveGame({ t: 'Jetpac', y: 1983, g: 0, p: 0, f: '/pub/a.tzx.zip', d: '/pub/a.dsk.zip', s: '/pub/a.scr' }, cat);
    expect(g).toEqual({
      title: 'Jetpac', year: 1983, genre: 'Arcade: Action', publisher: 'Ultimate',
      fileLink: '/pub/a.tzx.zip', isDisk: false, screen: '/pub/a.scr',
    });
  });

  it('defaults screen to empty when absent', () => {
    expect(resolveGame({ t: 'Homebrew', f: '/pub/h.tzx.zip' }, cat).screen).toBe('');
  });

  it('falls back to the disk image and flags it when there is no tape', () => {
    const g = resolveGame({ t: 'CP/M Thing', g: 1, p: 1, d: '/pub/b.dsk.zip' }, cat);
    expect(g.fileLink).toBe('/pub/b.dsk.zip');
    expect(g.isDisk).toBe(true);
  });

  it('tolerates missing year/genre/publisher', () => {
    const g = resolveGame({ t: 'Homebrew', f: '/pub/h.tzx.zip' }, cat);
    expect(g.year).toBeNull();
    expect(g.genre).toBe('');
    expect(g.publisher).toBe('');
  });
});
