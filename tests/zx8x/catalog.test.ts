import { describe, expect, it } from 'vitest';
import {
  matchesZx8xGenreFilter, matchesZx8xHardwareFilters, resolveZx8xGame, resolveZx8xGamesForModel,
  type RawZx8xCatalog,
} from '@/library/zx8x-catalog.ts';
import { zx81HiResModeForTags, zx8xLaunchHardware } from '@/library/zx8x-hardware.ts';

describe('ZX80/ZX81 catalog schema', () => {
  it('expands dictionary values and the native model', () => {
    const catalog: RawZx8xCatalog = {
      genres: ['Arcade Game: Action'],
      publishers: ['Sinclair Research Ltd'],
      games: [],
    };
    expect(resolveZx8xGame({ i: 9, t: 'Maze', m: 81, y: 1982, g: 0, p: 0, f: '/maze.p.zip' }, catalog)).toEqual({
      id: 9,
      title: 'Maze',
      model: 'zx81',
      year: 1982,
      genre: 'Arcade Game: Action',
      publisher: 'Sinclair Research Ltd',
      file: '/maze.p.zip',
      screen: '',
      ramKb: null,
      hiRes: null,
      enhancedGraphics: [],
    });
  });

  it('maps ZX80 rows and tolerates optional metadata', () => {
    const catalog: RawZx8xCatalog = { genres: [], publishers: [], games: [] };
    const game = resolveZx8xGame({ i: 1, t: 'Chess', m: 80, f: '/chess.o.zip' }, catalog);
    expect(game.model).toBe('zx80');
    expect(game.year).toBeNull();
    expect(game.genre).toBe('');
  });

  it('keeps the ZX80 and ZX81 libraries strictly separate', () => {
    const catalog: RawZx8xCatalog = {
      genres: [],
      publishers: [],
      games: [
        { i: 80, t: 'ZX80 Chess', m: 80, f: '/chess.o.zip' },
        { i: 81, t: 'ZX81 Chess', m: 81, f: '/chess.p.zip' },
      ],
    };

    expect(resolveZx8xGamesForModel(catalog, 'zx80').map(game => game.id)).toEqual([80]);
    expect(resolveZx8xGamesForModel(catalog, 'zx81').map(game => game.id)).toEqual([81]);
  });

  it('applies compact and curated ZX81 hardware requirements', () => {
    const catalog: RawZx8xCatalog = {
      genres: [],
      publishers: [],
      graphics: ['ZX81 Hi-res: UDG Card (Mapped at 3000h)'],
      games: [],
    };
    const pack = resolveZx8xGame({ i: 31906, t: '1K hires gamepack', m: 81, f: '/pack.p.zip' }, catalog);
    expect(pack.ramKb).toBe(1);
    expect(pack.hiRes).toBe('wrx');

    const explicit = resolveZx8xGame({ i: 7, t: 'UDG game', m: 81, r: 16, h: 'u', x: [0], f: '/udg.p.zip' }, catalog);
    expect(explicit.ramKb).toBe(16);
    expect(explicit.hiRes).toBe('udg');
    expect(explicit.enhancedGraphics).toEqual(['ZX81 Hi-res: UDG Card (Mapped at 3000h)']);
  });

  it('selects 1KB and WRX when launching the 1K hi-res gamepack', () => {
    expect(zx8xLaunchHardware({ ramKb: 1, hiRes: 'wrx' }, {
      ram16k: true,
      udgRam: true,
      udg128Ram: false,
      wrxHires: false,
      memotechHrg: false,
      quickSilvaHrg: false,
    })).toEqual({
      ram16k: false, udgRam: false, udg128Ram: false, wrxHires: true,
      memotechHrg: false, quickSilvaHrg: false,
    });
  });

  it('maps every implemented ZXDB graphics tag to its required board', () => {
    expect(zx81HiResModeForTags([13002])).toBe('memotech');
    expect(zx81HiResModeForTags([13003])).toBe('quicksilva');
    expect(zx81HiResModeForTags([13004])).toBe('wrx');
    expect(zx81HiResModeForTags([13006])).toBe('wrx');
    expect(zx81HiResModeForTags([13007])).toBe('udg');
    expect(zx81HiResModeForTags([13008])).toBe('udg128');
    expect(zx81HiResModeForTags([13001, 13010])).toBe('software');
    expect(zx81HiResModeForTags([13010])).toBeNull();
  });

  it('unions memory choices and intersects them with the Video filter', () => {
    const catalog: RawZx8xCatalog = { genres: [], publishers: [], games: [] };
    const wrx1k = resolveZx8xGame({ i: 31906, t: 'WRX 1K', m: 81, f: '/wrx.p.zip' }, catalog);
    const udg16k = resolveZx8xGame({ i: 32023, t: 'UDG 16K', m: 81, f: '/udg.p.zip' }, catalog);
    const ordinary = resolveZx8xGame({ i: 999, t: 'Ordinary game', m: 81, f: '/game.p.zip' }, catalog);

    expect(matchesZx8xHardwareFilters(wrx1k, new Set(), new Set([1, 16]))).toBe(true);
    expect(matchesZx8xHardwareFilters(udg16k, new Set(), new Set([1]))).toBe(false);
    expect(ordinary.ramKb).toBeNull();
    expect(matchesZx8xHardwareFilters(ordinary, new Set(), new Set([16]))).toBe(true);
    expect(matchesZx8xHardwareFilters(ordinary, new Set(), new Set([1]))).toBe(false);
    expect(matchesZx8xHardwareFilters(
      wrx1k,
      new Set(['ZX81 Hi-res: UDG Card (Mapped at 3000h)']),
      new Set([1]),
    )).toBe(false);
  });

  it('filters exact ZXDB genres and leaves an empty Genre selection inactive', () => {
    const catalog: RawZx8xCatalog = {
      genres: ['Arcade Game: Action', 'Strategy Game: Chess'],
      publishers: [],
      games: [],
    };
    const action = resolveZx8xGame({ i: 1, t: 'Action', m: 81, g: 0, f: '/action.p.zip' }, catalog);

    expect(matchesZx8xGenreFilter(action, new Set())).toBe(true);
    expect(matchesZx8xGenreFilter(action, new Set(['Arcade Game: Action']))).toBe(true);
    expect(matchesZx8xGenreFilter(action, new Set(['Strategy Game: Chess']))).toBe(false);
  });
});
