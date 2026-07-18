/**
 * Game library catalog helpers.
 *
 * Game files are tried CDN-first (the R2 public domain), then the zxfileserver
 * Worker; fileUrls returns those candidates in order. Absolute http(s) links are
 * the sole candidate. The bases are hard-coded here independently of the
 * implementation so a wrong base in the code is caught.
 */

import { describe, it, expect } from 'vitest';
import { fileUrls, basename, shortPublisher, resolveGame, planLoad, hasFormat, availableFormats, supportsMachine, parseLibraryQuery, type RawCatalog } from '@/library/catalog.ts';

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
      .toEqual({ text: 'manic', negTerms: [], yearMin: 1983, yearMax: 1983, publisher: 'ocean' });
  });

  it('joins multiple free words and lower-cases everything', () => {
    expect(parseLibraryQuery('Jet Set Willy'))
      .toEqual({ text: 'jet set willy', negTerms: [], yearMin: null, yearMax: null, publisher: '' });
  });

  it('returns empty for a blank query', () => {
    expect(parseLibraryQuery('   ')).toEqual({ text: '', negTerms: [], yearMin: null, yearMax: null, publisher: '' });
  });

  it('ignores a non-numeric year token', () => {
    expect(parseLibraryQuery('year:abc thing').yearMin).toBeNull();
    expect(parseLibraryQuery('year:abc thing').yearMax).toBeNull();
    expect(parseLibraryQuery('year:abc thing').text).toBe('thing');
  });

  it('collects -word tokens as negative terms, keeping positive words', () => {
    expect(parseLibraryQuery('manic -demo -editor'))
      .toEqual({ text: 'manic', negTerms: ['demo', 'editor'], yearMin: null, yearMax: null, publisher: '' });
  });

  it('a bare "-" is not a negative term', () => {
    expect(parseLibraryQuery('- thing'))
      .toEqual({ text: '- thing', negTerms: [], yearMin: null, yearMax: null, publisher: '' });
  });

  it('parses a year range and normalises a reversed one', () => {
    expect(parseLibraryQuery('year:1983-1989'))
      .toEqual({ text: '', negTerms: [], yearMin: 1983, yearMax: 1989, publisher: '' });
    expect(parseLibraryQuery('year:1989-1983'))
      .toEqual({ text: '', negTerms: [], yearMin: 1983, yearMax: 1989, publisher: '' });
  });

  it('ignores open-ended year ranges (both bounds required)', () => {
    expect(parseLibraryQuery('year:1985-'))
      .toEqual({ text: '', negTerms: [], yearMin: null, yearMax: null, publisher: '' });
    expect(parseLibraryQuery('year:-1985'))
      .toEqual({ text: '', negTerms: [], yearMin: null, yearMax: null, publisher: '' });
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

  it('expands genre/publisher indices and exposes every retained media slot', () => {
    const g = resolveGame({ i: 7, t: 'Jetpac', y: 1983, g: 0, p: 0, a: '/pub/a16.tzx.zip', f: '/pub/a.tzx.zip', k: '/pub/a128.tzx.zip', d: '/pub/a.dsk.zip', m: '/pub/a.mgt.zip', mk: '/pub/a128.mgt.zip', u: '/pub/a.mdr.zip', uk: '/pub/a128.mdr.zip', n16: '/pub/a16.szx.zip', n: '/pub/a.z80.zip', nk: '/pub/a128.szx.zip', s: '/pub/a.scr' }, cat);
    expect(g).toEqual({
      id: 7, title: 'Jetpac', year: 1983, genre: 'Arcade: Action', publisher: 'Ultimate',
      tape16: '/pub/a16.tzx.zip', tape48: '/pub/a.tzx.zip', tape128: '/pub/a128.tzx.zip', plus3Disk: '/pub/a.dsk.zip',
      diskSides: [], mgt48: '/pub/a.mgt.zip', mgt128: '/pub/a128.mgt.zip', microdrive48: '/pub/a.mdr.zip', microdrive128: '/pub/a128.mdr.zip',
      snap16: '/pub/a16.szx.zip', snap48: '/pub/a.z80.zip', snap128: '/pub/a128.szx.zip', screen: '/pub/a.scr', rom: '',
    });
  });

  it('exposes the ROM cartridge slot', () => {
    const g = resolveGame({ i: 8, t: 'Chess', r: '/pub/chess.rom.zip' }, cat);
    expect(g.rom).toBe('/pub/chess.rom.zip');
  });

  it('exposes snapshot slots', () => {
    const g = resolveGame({ i: 9, t: 'Snap', n: '/pub/s.z80.zip', nk: '/pub/s128.szx.zip' }, cat);
    expect(g.snap48).toBe('/pub/s.z80.zip');
    expect(g.snap128).toBe('/pub/s128.szx.zip');
    expect(g.snap16).toBe('');
  });

  it('defaults empty slots and tolerates missing year/genre/publisher', () => {
    const g = resolveGame({ i: 3, t: 'Homebrew', f: '/pub/h.tzx.zip' }, cat);
    expect(g.tape16).toBe('');
    expect(g.tape128).toBe('');
    expect(g.plus3Disk).toBe('');
    expect(g.mgt48).toBe('');
    expect(g.microdrive48).toBe('');
    expect(g.screen).toBe('');
    expect(g.year).toBeNull();
    expect(g.genre).toBe('');
    expect(g.publisher).toBe('');
  });
});

describe('library media selection', () => {
  const cat: RawCatalog = { genres: [], publishers: [], games: [] };
  const mk = (raw: Omit<RawCatalog['games'][number], 'i'>) => resolveGame({ i: 1, ...raw }, cat);
  const tape16 = mk({ t: 'T16', a: '/pub/16.tzx.zip' });
  const tape48 = mk({ t: 'T48', f: '/pub/48.tzx.zip' });
  const tape128 = mk({ t: 'T128', k: '/pub/128.tzx.zip' });
  const bothTapes = mk({ t: 'BT', f: '/pub/48.tzx.zip', k: '/pub/128.tzx.zip' });
  const diskOnly = mk({ t: 'D', d: '/pub/x.dsk.zip' });
  const mgt = mk({ t: 'MGT', m: '/pub/x.mgt.zip' });
  const microdrive = mk({ t: 'MDR', uk: '/pub/x.mdv.zip' });
  const everyFormat = mk({ t: 'All', a: '/pub/16.tzx.zip', d: '/pub/x.dsk.zip', m: '/pub/x.mgt.zip', n: '/pub/x.z80.zip', r: '/pub/x.rom.zip', u: '/pub/x.mdr.zip' });
  const tapeAndDisk = mk({ t: 'TD', f: '/pub/48.tzx.zip', d: '/pub/x.dsk.zip' });
  const snap16Only = mk({ t: 'S16', n16: '/pub/s16.szx.zip' });
  const snap48Only = mk({ t: 'S48', n: '/pub/s.z80.zip' });
  const snap128Only = mk({ t: 'S128', nk: '/pub/s128.szx.zip' });
  const romOnly = mk({ t: 'R', r: '/pub/x.rom.zip' });
  const romAndTapeAndDisk = mk({ t: 'RTD', f: '/pub/48.tzx.zip', d: '/pub/x.dsk.zip', r: '/pub/x.rom.zip' });

  it('16K: a 16K tape stays on 16K and a 48K tape upgrades', () => {
    expect(planLoad(tape16, '16k')).toEqual({ target: '16k', link: '/pub/16.tzx.zip', kind: 'tape', boot: 'rom48k' });
    expect(planLoad(tape48, '16k')).toEqual({ target: '48k', link: '/pub/48.tzx.zip', kind: 'tape', boot: 'rom48k' });
  });

  it('48K: a 48 tape jumps the ROM loader, staying on 48K', () => {
    expect(planLoad(tape48, '48k')).toEqual({ target: '48k', link: '/pub/48.tzx.zip', kind: 'tape', boot: 'rom48k' });
  });

  it('48K: a 128-only tape upgrades to 128K and a +3 disk upgrades to +3', () => {
    expect(planLoad(tape128, '48k')).toEqual({ target: '128k', link: '/pub/128.tzx.zip', kind: 'tape', boot: 'menu' });
    expect(planLoad(diskOnly, '48k')).toEqual({ target: '+3', link: '/pub/x.dsk.zip', kind: 'plus3-disk', boot: 'menu' });
  });

  it('128K: a tape stays on the current machine, preferring the 128K tape', () => {
    expect(planLoad(bothTapes, '+2A')).toEqual({ target: '+2A', link: '/pub/128.tzx.zip', kind: 'tape', boot: 'menu' });
  });

  it('128K: a disk-only game upgrades to +3', () => {
    expect(planLoad(diskOnly, '128k')).toEqual({ target: '+3', link: '/pub/x.dsk.zip', kind: 'plus3-disk', boot: 'menu' });
  });

  it('+3: prefers the disk over the tape', () => {
    expect(planLoad(tapeAndDisk, '+3')).toEqual({ target: '+3', link: '/pub/x.dsk.zip', kind: 'plus3-disk', boot: 'menu' });
  });

  it('+3: a tape-only game still loads via the menu', () => {
    expect(planLoad(tape48, '+3')).toEqual({ target: '+3', link: '/pub/48.tzx.zip', kind: 'tape', boot: 'menu' });
  });

  it('returns null when the game has no playable file at all', () => {
    expect(planLoad(mk({ t: 'None' }), '48k')).toBeNull();
  });

  it('snapshot-only: falls back to the snapshot on its native model, boot snapshot', () => {
    expect(planLoad(snap16Only, '16k')).toEqual({ target: '16k', link: '/pub/s16.szx.zip', kind: 'snapshot', boot: 'snapshot' });
    expect(planLoad(snap48Only, '48k')).toEqual({ target: '48k', link: '/pub/s.z80.zip', kind: 'snapshot', boot: 'snapshot' });
    expect(planLoad(snap128Only, '48k')).toEqual({ target: '128k', link: '/pub/s128.szx.zip', kind: 'snapshot', boot: 'snapshot' });
    // Even on a +3, a snapshot-only game loads its snapshot directly.
    expect(planLoad(snap48Only, '+3')).toEqual({ target: '48k', link: '/pub/s.z80.zip', kind: 'snapshot', boot: 'snapshot' });
  });

  it('selects MGT +D and microdrive media with their required peripheral', () => {
    expect(planLoad(mgt, '48k')).toEqual({ target: '48k', link: '/pub/x.mgt.zip', kind: 'mgt-disk', peripheral: 'plusd', boot: 'peripheral' });
    expect(planLoad(microdrive, '128k')).toEqual({ target: '128k', link: '/pub/x.mdv.zip', kind: 'microdrive', peripheral: 'interface1', boot: 'peripheral' });
    expect(planLoad(mgt, '+2A')).toEqual({ target: '128k', link: '/pub/x.mgt.zip', kind: 'mgt-disk', peripheral: 'plusd', boot: 'peripheral' });
  });

  it('honours the selected format over the default current-machine preference', () => {
    const tapeAndMicrodrive = mk({ t: 'TMD', f: '/pub/tape.tzx.zip', u: '/pub/cart.mdr.zip' });
    expect(planLoad(tapeAndMicrodrive, '48k')).toEqual({ target: '48k', link: '/pub/tape.tzx.zip', kind: 'tape', boot: 'rom48k' });
    expect(planLoad(tapeAndMicrodrive, '48k', ['microdrive'])).toEqual({ target: '48k', link: '/pub/cart.mdr.zip', kind: 'microdrive', peripheral: 'interface1', boot: 'peripheral' });
  });

  it('a ROM cartridge always wins — switches down to 48K even from a +3', () => {
    expect(planLoad(romOnly, '16k')).toEqual({ target: '16k', link: '/pub/x.rom.zip', kind: 'rom', boot: 'rom' });
    expect(planLoad(romOnly, '+3')).toEqual({ target: '48k', link: '/pub/x.rom.zip', kind: 'rom', boot: 'rom' });
    expect(planLoad(romOnly, '128k')).toEqual({ target: '48k', link: '/pub/x.rom.zip', kind: 'rom', boot: 'rom' });
  });

  it('a ROM cartridge takes priority over a tape/disk on the same entry', () => {
    expect(planLoad(romAndTapeAndDisk, '+3')).toEqual({ target: '48k', link: '/pub/x.rom.zip', kind: 'rom', boot: 'rom' });
  });

  it('keeps formats independent and expands each one to compatible machines', () => {
    expect(availableFormats(everyFormat)).toEqual(['tape', 'plus3-disk', 'mgt-disk', 'snapshot', 'rom', 'microdrive']);
    expect(hasFormat(everyFormat, 'mgt-disk')).toBe(true);
    expect(hasFormat(tape48, 'snapshot')).toBe(false);
    expect(supportsMachine(tape16, '16')).toBe(true);
    expect(supportsMachine(tape16, '+3')).toBe(true);
    expect(supportsMachine(tape128, '48')).toBe(false);
    expect(supportsMachine(diskOnly, '+3')).toBe(true);
    expect(supportsMachine(diskOnly, '128')).toBe(false);
    expect(supportsMachine(mgt, '48')).toBe(true);
    expect(supportsMachine(mgt, '+3')).toBe(false);
    expect(supportsMachine(microdrive, '128')).toBe(true);
    expect(supportsMachine(romOnly, '16')).toBe(true);
    expect(supportsMachine(romOnly, '128')).toBe(false);
  });
});
