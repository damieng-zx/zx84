import { describe, expect, it } from 'vitest';
import { resolveZx8xGame, resolveZx8xGamesForModel, type RawZx8xCatalog } from '@/library/zx8x-catalog.ts';

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
});
