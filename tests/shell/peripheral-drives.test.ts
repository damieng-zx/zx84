/**
 * The +D and Beta Disk drive helpers: one shared load / eject / save / blank
 * path, parametrised by add-on. Pins the messages, which drive-id and which
 * pane slot (C:/D:) each add-on's units reach, and that a bad image leaves the
 * drive untouched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/shell/lifecycle.ts', () => ({ unpause: () => {}, autoBootLoad: () => {} }));
const persisted = vi.hoisted(() => ({ plusd: [] as string[], beta: [] as string[], clearedPlusd: [] as number[], clearedBeta: [] as number[] }));
vi.mock('@/store/persistence.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/store/persistence.ts')>()),
  persistPlusDDisk: (unit: number, _d: Uint8Array, name: string) => { persisted.plusd.push(`${unit}:${name}`); },
  persistBetaDiskDisk: (unit: number, _d: Uint8Array, name: string) => { persisted.beta.push(`${unit}:${name}`); },
  clearPlusDDisk: (unit: number) => { persisted.clearedPlusd.push(unit); },
  clearBetaDiskDisk: (unit: number) => { persisted.clearedBeta.push(unit); },
}));

import { setMachine } from '@/shell/context.ts';
import { statusText } from '@/state/machine-state.ts';
import { currentDiskNameC, currentDiskNameD } from '@/state/disk-state.ts';
import {
  loadPlusDDisk, ejectPlusDDisk, insertBlankPlusDDisk,
  loadBetaDiskDisk, ejectBetaDiskDisk, insertBlankBetaDiskDisk,
} from '@/shell/media.ts';
import { blankTrdDisk, serializeTrd } from '@/media/floppy/trd-image.ts';
import type { Machine } from '@/machines/machine.ts';

let inserted: Array<{ id: string; name: string }>;
let ejected: string[];

function fakeSpectrum(fitted: string[]): Machine {
  return {
    kind: 'spectrum',
    descriptor: { ui: {} },
    services: {
      disks: {
        drives: fitted.map(id => ({ id })),
        insert: (id: string, _media: unknown, name: string) => { inserted.push({ id, name }); },
        eject: (id: string) => { ejected.push(id); },
        save: () => null,
        image: () => null,
      },
    },
  } as unknown as Machine;
}

beforeEach(() => {
  inserted = [];
  ejected = [];
  persisted.plusd.length = persisted.beta.length = persisted.clearedPlusd.length = persisted.clearedBeta.length = 0;
  setMachine(fakeSpectrum(['plusd:0', 'plusd:1', 'beta:0', 'beta:1']));
});

describe('+D drives', () => {
  it('says to fit the +D when its drive is absent', () => {
    setMachine(fakeSpectrum([]));
    loadPlusDDisk(new Uint8Array(4), 'x.mgt', 0);
    expect(statusText()).toBe('Enable the MGT +D in Hardware first');
    expect(inserted).toEqual([]);
  });

  it('ejects unit 1 from drive plusd:1 and clears slot D', () => {
    ejectPlusDDisk(1);
    expect(ejected).toEqual(['plusd:1']);
    expect(persisted.clearedPlusd).toEqual([1]);
    expect(currentDiskNameD()).toBe('');
    expect(statusText()).toBe('+D disk D: ejected');
  });

  it('inserts a blank .mgt into unit 0, shows it in slot C and persists it', () => {
    insertBlankPlusDDisk(0, { tracks: 80, sides: 2 });
    expect(inserted).toEqual([{ id: 'plusd:0', name: 'BLANK.mgt' }]);
    expect(currentDiskNameC()).toBe('BLANK.mgt');
    expect(persisted.plusd).toEqual(['0:BLANK.mgt']);
  });
});

describe('Beta Disk drives', () => {
  it('says to fit the Beta Disk when its drive is absent', () => {
    setMachine(fakeSpectrum(['plusd:0']));
    loadBetaDiskDisk(new Uint8Array(4), 'x.trd', 0);
    expect(statusText()).toBe('Enable the Beta Disk in Hardware first');
  });

  it('loads a .trd into beta:0 as drive A, in pane slot C', () => {
    loadBetaDiskDisk(serializeTrd(blankTrdDisk(80, 2)), 'game.trd', 0);
    expect(inserted).toEqual([{ id: 'beta:0', name: 'game.trd' }]);
    expect(currentDiskNameC()).toBe('game.trd');
    expect(persisted.beta).toEqual(['0:game.trd']);
    expect(statusText()).toBe('Beta Disk A: loaded: game.trd');
  });

  it('names unit 1 drive B and puts it in pane slot D', () => {
    loadBetaDiskDisk(serializeTrd(blankTrdDisk(80, 2)), 'b.trd', 1);
    expect(currentDiskNameD()).toBe('b.trd');
    expect(statusText()).toBe('Beta Disk B: loaded: b.trd');
  });

  it('reports an unreadable image and leaves the drive alone', () => {
    loadBetaDiskDisk(new Uint8Array(10), 'junk.trd', 0);
    expect(inserted).toEqual([]);
    expect(persisted.beta).toEqual([]);
    expect(statusText()).toBe('Beta Disk error: Invalid TRD image size: 10');
  });

  it('ejects and clears the persisted copy', () => {
    ejectBetaDiskDisk(0);
    expect(ejected).toEqual(['beta:0']);
    expect(persisted.clearedBeta).toEqual([0]);
    expect(statusText()).toBe('Beta Disk A: ejected');
  });

  it('inserts a blank .scl as an 80x2 disk', () => {
    insertBlankBetaDiskDisk(0, undefined, true);
    expect(inserted).toEqual([{ id: 'beta:0', name: 'BLANK.scl' }]);
  });
});
