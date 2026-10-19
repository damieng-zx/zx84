/**
 * Opening a TR-DOS disk (.trd/.scl) from the Load button or a drop runs it:
 * loadFile's `autoBoot` option asks the lifecycle to boot TR-DOS once the image
 * is in Beta Disk drive A. Drive B, an explicit drive insert and a plain loadFile
 * (the library boots for itself) must not.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const booted = vi.hoisted(() => [] as string[]);

vi.mock('@/shell/lifecycle.ts', () => ({
  unpause: () => {},
  autoBootLoad: (method: string) => { booted.push(method); },
}));
vi.mock('@/media/zip.ts', () => ({ unzip: async () => [{ name: 'inner.trd', data: new Uint8Array([1]) }] }));
vi.mock('@/store/persistence.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/store/persistence.ts')>()),
  persistBetaDiskDisk: () => {},
}));

import { setMachine } from '@/shell/context.ts';
import { loadFile } from '@/shell/media.ts';
import type { Machine, MountResult } from '@/machines/machine.ts';

let mounted: string[] = [];

function fakeSpectrum(): Machine {
  return {
    kind: 'spectrum',
    descriptor: { ui: { persistMedia: true, zipPolicy: 'all' } },
    services: {
      media: {
        accepts: () => [{ ext: '.trd', target: 'a' }, { ext: '.scl', target: 'a' }, { ext: '.tap', target: 'tape' }],
        mount: async (_data: Uint8Array, filename: string, target?: string): Promise<MountResult> => {
          mounted.push(filename);
          if (/\.(trd|scl)$/i.test(filename)) {
            const unit = target?.startsWith('unit:') ? Number(target.slice(5)) : 0;
            return { ok: true, target: `beta:${unit}`, message: `Beta Disk loaded: ${filename}` };
          }
          return { ok: true, target: 'tape', message: `Tape loaded: ${filename}` };
        },
      },
      disks: { image: () => null, drives: [] },
      tape: { rawBlocks: [] },
    },
  } as unknown as Machine;
}

const bytes = new Uint8Array([1, 2, 3]);

describe('loadFile autoBoot', () => {
  beforeEach(() => {
    booted.length = 0;
    mounted = [];
    setMachine(fakeSpectrum());
  });

  it('boots TR-DOS for a .trd opened with autoBoot', async () => {
    await loadFile(bytes, 'game.trd', undefined, { autoBoot: true });
    expect(booted).toEqual(['trdos']);
  });

  it('boots TR-DOS for an .scl, including one inside a zip', async () => {
    await loadFile(bytes, 'game.scl', undefined, { autoBoot: true });
    expect(booted).toEqual(['trdos']);
    booted.length = 0;
    await loadFile(bytes, 'game.trd.zip', undefined, { autoBoot: true });
    expect(mounted).toContain('inner.trd');
    expect(booted).toEqual(['trdos']);
  });

  it('leaves a disk alone without autoBoot (library and drive inserts)', async () => {
    await loadFile(bytes, 'game.trd');
    await loadFile(bytes, 'game.trd', 0);
    expect(booted).toEqual([]);
  });

  it('does not boot when the disk goes into drive B', async () => {
    await loadFile(bytes, 'game.trd', 1, { autoBoot: true });
    expect(booted).toEqual([]);
  });

  it('does not boot for other media', async () => {
    await loadFile(bytes, 'game.tap', undefined, { autoBoot: true });
    expect(booted).toEqual([]);
  });
});
