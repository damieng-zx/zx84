import { describe, expect, it } from 'vitest';
import { Zx8xMachine } from '@/machines/zx8x/zx8x-machine.ts';
import { pickZx8xLoader, zx8xArchiveTape } from '@/machines/zx8x/services/tape.ts';

/** The ROM's LOAD ($0340), IN-NAME ($0364) and SLOW/FAST ($0207) byte
 *  sequences the trap keys on, as in tape-trap.test.ts. */
function cassetteRom(): Uint8Array {
  const rom = new Uint8Array(0x2000);
  rom.set([0xcd, 0xa8, 0x03, 0xcb, 0x12, 0xcb, 0x0a, 0xcd, 0x4c, 0x03], 0x0340);
  rom.set([0x62, 0x6b, 0xcd, 0x4c, 0x03], 0x0364);
  rom.set([0xcd, 0xa8, 0x03, 0x38, 0xf9, 0xeb], 0x02f6);
  rom.set([0x21, 0x3b, 0x40, 0x76], 0x0207);
  rom[0x034c] = 0x18; rom[0x034d] = 0xfe;
  return rom;
}

const file = (name: string, bytes: number[]) => ({ name, data: new Uint8Array(bytes) });

describe('multi-file ZX81 archives: which program starts', () => {
  // File lists are the real TOSEC multipart zips from the ZX81 collection.
  it.each([
    ['Dan\'s Revenge v2.0 (1996)(McDonald, Steven).zip', ['DRCODE.P', 'DRDATA.P', 'DRDFILE.P', 'DRSCRNS.P', 'REVENGE.P'], 4],
    ['Rock Crush v2.1 (1985)(McDonald, Steven).zip', ['CRUSH.P', 'RCCODE.P', 'RCDATA.P', 'RCDFILE.P', 'RCSCRNS.P'], 0],
    ['Encounter (1982)(Pixel Productions).zip', ['EN.P', 'LOADER-E.P'], 1],
    ['Starship \'Starquest\' (1982)(Pixel Productions).zip', ['LOADERS.P', 'ST.P'], 0],
    ['Trader (19xx)(Pixel Productions).zip', ['T1.P', 'T2.P', 'T3.P', 'TRADER-I.P'], 3],
    ['Ocean Trader (1982)(Quicksilva).zip', ['OCEAN.P', 'OCEAN2.P'], 0],
    ['Snorth Games (1985)(Syncware).zip', ['MR.P', 'NFLX.P', 'SL3.P', 'SNORTH.P', 'SS.P'], 3],
    ['Hi-Res Chess (1985)(Psion Software).zip', ['CHESS.P', 'HRCHESS.P'], 0],
    // Nothing in the names says which is first: the first file.
    ['Black Crystal (1982)(Carnell Software).zip', ['MAP 1.P', 'MAP 2.P', 'TEST.P'], 0],
  ])('%s', (archive, names, expected) => {
    expect(pickZx8xLoader(names, archive)).toBe(expected);
  });
});

describe('multi-file ZX81 archives: the tape', () => {
  it('puts the loader first, then the rest in archive order, each under its file name', () => {
    const tape = zx8xArchiveTape('zx81', [
      file('PART1.P', [1]), file('PART2.P', [2]), file('GAME.P', [3]),
    ], 'Game (1983)(Somebody).zip')!;
    expect(tape.programs.map(p => p.name)).toEqual(['GAME', 'PART1', 'PART2']);
    expect(tape.first.name).toBe('GAME');
    // Each program is its own block group, so the blocks of one do not overlap another's.
    const starts = tape.programs.map(p => p.startBlock);
    expect(new Set(starts).size).toBe(3);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it('declines an archive with fewer than two programs', () => {
    expect(zx8xArchiveTape('zx81', [file('ONLY.P', [1]), file('README.TXT', [2])], 'x.zip')).toBeNull();
  });

  it('does not take ZX80 images for a ZX81 or the reverse', () => {
    expect(zx8xArchiveTape('zx81', [file('A.O', [1]), file('B.O', [2])], 'x.zip')).toBeNull();
    expect(zx8xArchiveTape('zx80', [file('A.P', [1]), file('B.P', [2])], 'x.zip')).toBeNull();
  });
});

describe('multi-file ZX81 archives: mounting', () => {
  function mounted() {
    const m = new Zx8xMachine('zx81');
    m.loadROM(cassetteRom());
    return m;
  }

  it('runs the loader and leaves the other parts on the tape for LOAD "NAME"', async () => {
    const m = mounted();
    const res = await m.services.media.mountArchive!([
      file('PART2.P', [0x22, 0x23]), file('GAME.P', [0x11, 0x12]),
    ], 'Game (1983)(Somebody).zip');
    expect(res).toMatchObject({ ok: true, target: 'tape' });
    expect([m.memory.readByte(0x4009), m.memory.readByte(0x400a)]).toEqual([0x11, 0x12]);
    expect(m.cassette.programs.map(p => p.name)).toEqual(['GAME', 'PART2']);

    // The loader now does LOAD "PART2": P=$35 A=$26 R=$37 T=$39 2=$1E, last with bit 7 set.
    const name = [0x35, 0x26, 0x37, 0x39, 0x1e | 0x80];
    name.forEach((c, i) => m.memory.writeByte(0x4200 + i, c));
    m.cpu.d = 0x42; m.cpu.e = 0x00;
    m.cpu.pc = 0x0347;
    m.cpu.sp = 0x43f0;
    m.breakpoints.add(0x020a); // the HALT after SLOW/FAST's first instruction: the trap's resume point
    m.tick();
    expect(m.breakpointHit).toBe(0x020a);
    expect([m.memory.readByte(0x4009), m.memory.readByte(0x400a)]).toEqual([0x22, 0x23]);
  });

  it('hands a single-program zip back to the shell', async () => {
    const m = mounted();
    expect(await m.services.media.mountArchive!([file('ONLY.P', [1])], 'only.zip')).toBeNull();
  });

  it('refuses a loader too big for the RAM fitted', async () => {
    const m = mounted();
    const res = await m.services.media.mountArchive!([
      file('BIG.P', new Array(2000).fill(1)), file('B.P', [1]),
    ], 'Big (19xx).zip');
    expect(res?.ok).toBe(false);
    expect(res?.message).toMatch(/16KB/);
  });
});
