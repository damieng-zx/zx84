/**
 * Game library catalog helpers.
 *
 * Game files are tried CDN-first (the R2 public domain), then the zxfileserver
 * Worker; fileUrls returns those candidates in order. Absolute http(s) links are
 * the sole candidate. The bases are hard-coded here independently of the
 * implementation so a wrong base in the code is caught.
 */

import { describe, it, expect } from 'vitest';
import { fileUrls, basename, shortPublisher, resolveGame, planLoad, gameNeeds, parseLibraryQuery, type RawCatalog } from '@/library/catalog.ts';

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

  it('expands genre/publisher indices and exposes the tape/disk slots', () => {
    const g = resolveGame({ i: 7, t: 'Jetpac', y: 1983, g: 0, p: 0, f: '/pub/a.tzx.zip', k: '/pub/a128.tzx.zip', d: '/pub/a.dsk.zip', s: '/pub/a.scr' }, cat);
    expect(g).toEqual({
      id: 7, title: 'Jetpac', year: 1983, genre: 'Arcade: Action', publisher: 'Ultimate',
      tape48: '/pub/a.tzx.zip', tape128: '/pub/a128.tzx.zip', disk: '/pub/a.dsk.zip',
      diskSides: [], isDiskOnly: false, screen: '/pub/a.scr',
    });
  });

  it('flags a disk-only game', () => {
    expect(resolveGame({ i: 1, t: 'D', d: '/pub/d.dsk.zip' }, cat).isDiskOnly).toBe(true);
    expect(resolveGame({ i: 2, t: 'T', f: '/pub/t.tzx.zip', d: '/pub/t.dsk.zip' }, cat).isDiskOnly).toBe(false);
  });

  it('defaults empty slots and tolerates missing year/genre/publisher', () => {
    const g = resolveGame({ i: 3, t: 'Homebrew', f: '/pub/h.tzx.zip' }, cat);
    expect(g.tape128).toBe('');
    expect(g.disk).toBe('');
    expect(g.screen).toBe('');
    expect(g.year).toBeNull();
    expect(g.genre).toBe('');
    expect(g.publisher).toBe('');
  });
});

describe('planLoad / gameNeeds', () => {
  const cat: RawCatalog = { genres: [], publishers: [], games: [] };
  const mk = (raw: Omit<RawCatalog['games'][number], 'i'>) => resolveGame({ i: 1, ...raw }, cat);
  const tape48 = mk({ t: 'T48', f: '/pub/48.tzx.zip' });
  const tape128 = mk({ t: 'T128', k: '/pub/128.tzx.zip' });
  const bothTapes = mk({ t: 'BT', f: '/pub/48.tzx.zip', k: '/pub/128.tzx.zip' });
  const diskOnly = mk({ t: 'D', d: '/pub/x.dsk.zip' });
  const tapeAndDisk = mk({ t: 'TD', f: '/pub/48.tzx.zip', d: '/pub/x.dsk.zip' });

  it('48K: a 48 tape jumps the ROM loader, staying on 48K', () => {
    expect(planLoad(tape48, '48k')).toEqual({ target: '48k', link: '/pub/48.tzx.zip', isDisk: false, boot: 'rom48k' });
  });

  it('48K: a 128-only tape upgrades to 128K and uses the menu', () => {
    expect(planLoad(tape128, '48k')).toEqual({ target: '128k', link: '/pub/128.tzx.zip', isDisk: false, boot: 'menu' });
  });

  it('48K: a disk-only game upgrades to +3', () => {
    expect(planLoad(diskOnly, '48k')).toEqual({ target: '+3', link: '/pub/x.dsk.zip', isDisk: true, boot: 'menu' });
  });

  it('128K: a tape stays on the current machine, preferring the 128K tape', () => {
    expect(planLoad(bothTapes, '+2A')).toEqual({ target: '+2A', link: '/pub/128.tzx.zip', isDisk: false, boot: 'menu' });
  });

  it('128K: a disk-only game upgrades to +3', () => {
    expect(planLoad(diskOnly, '128k')).toEqual({ target: '+3', link: '/pub/x.dsk.zip', isDisk: true, boot: 'menu' });
  });

  it('+3: prefers the disk over the tape', () => {
    expect(planLoad(tapeAndDisk, '+3')).toEqual({ target: '+3', link: '/pub/x.dsk.zip', isDisk: true, boot: 'menu' });
  });

  it('+3: a tape-only game still loads via the menu', () => {
    expect(planLoad(tape48, '+3')).toEqual({ target: '+3', link: '/pub/48.tzx.zip', isDisk: false, boot: 'menu' });
  });

  it('returns null when the game has neither tape nor disk', () => {
    expect(planLoad(mk({ t: 'None' }), '48k')).toBeNull();
  });

  it('gameNeeds reports the minimum machine', () => {
    expect(gameNeeds(tape48)).toBe('48');
    expect(gameNeeds(tape128)).toBe('128');
    expect(gameNeeds(diskOnly)).toBe('+3');
    expect(gameNeeds(bothTapes)).toBe('48');
  });
});
