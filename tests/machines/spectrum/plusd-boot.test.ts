/**
 * MGT +D booting: the RAM that holds the G+DOS system, and the system file
 * supplied to disks that have none.
 *
 * Expected behaviour comes from the G+DOS ROM (disassembled):
 *   • RUN with no program boots: the ROM searches the disk for a CODE file
 *     matching `+SYS*` (CALL 09A5 at 0x039F, then JP NZ,1652 at 0x03A2 when it is
 *     missing, giving `No "+SYS  " file`), loads it to 0x2000, writes 'D' at
 *     0x3DE4 at 0x03C7, and the system goes on to load and run `AUTO*`.
 *   • Its reset code warm-starts from the 'D' marker, so the +D's RAM is meant
 *     to survive the reset button; only power clears it.
 * The ROM-backed cases need the images under mcp/.cache/sinclair/ (not
 * redistributable) and are skipped when absent: 48.rom, 128-0.rom + 128-1.rom,
 * plus-d.rom, and plus-d-system.bin (the `+SYS` body from a G+DOS system disk).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { MgtPlusD } from '@/machines/spectrum/peripherals/mgt-plusd.ts';
import { parseMgt } from '@/media/floppy/mgt-image.ts';

const CACHE = resolve(__dirname, '../../../mcp/.cache/sinclair');
const have = (names: string[]): boolean => names.every((n) => existsSync(resolve(CACHE, n)));
const read = (name: string): Uint8Array => new Uint8Array(readFileSync(resolve(CACHE, name)));

const MARKER = 0x3DE4;          // 'D' = system loaded, 'X' = initialised without one
const D = 0x44, X = 0x58;

/** A G+DOS ROM image that is blank except for the code the fallback checks. */
function signatureRom(): Uint8Array {
  const rom = new Uint8Array(8192);
  rom.set([0x3E, 0x08, 0xCD, 0xA5, 0x09, 0xC2, 0x52, 0x16], 0x039D); // LD A,8 / CALL 09A5 / JP NZ,1652
  rom.set([0x3E, 0x44, 0x32, 0xE4, 0x3D], 0x03C7);                   // LD A,'D' / LD (3DE4),A
  return rom;
}

/** A 48K with the +D fitted, its ROM mapped in at reset as on power-on. */
function fitted(rom: Uint8Array): Spectrum {
  const s = new Spectrum('zx48k', null);
  s.mgtPlusD.loadROM(rom);
  s.mgtPlusD.enabled = true;
  s.reset();
  return s;
}

/** The byte at a +D RAM address (0x2000-0x3FFF), wherever it currently lives. */
function plusDRam(s: Spectrum, addr: number): number {
  return s.mgtPlusD.pagedIn ? s.memory.getSlot(0)[addr] : s.mgtPlusD.ram[addr - 0x2000];
}

describe('+D RAM across resets', () => {
  it('keeps what the CPU wrote into the +D RAM while it was paged in', () => {
    const s = fitted(signatureRom());
    expect(s.mgtPlusD.pagedIn).toBe(true);
    s.memory.writeByte(MARKER, D);
    s.reset();
    expect(s.mgtPlusD.ram[MARKER - 0x2000]).toBe(D);
  });

  it('keeps it across repeated resets while the +D stays fitted', () => {
    const pd = new MgtPlusD();
    pd.loadROM(signatureRom());
    pd.enabled = true;
    pd.reset();
    pd.ram[0x1000] = 0xA5;
    pd.reset();
    pd.reset();
    expect(pd.ram[0x1000]).toBe(0xA5);
  });

  it('clears it when the +D is fitted again after being removed (a power-on)', () => {
    const pd = new MgtPlusD();
    pd.loadROM(signatureRom());
    pd.enabled = true;
    pd.reset();
    pd.ram[0x1000] = 0xA5;
    pd.enabled = false;
    pd.reset();
    pd.enabled = true;
    pd.reset();
    expect(pd.ram[0x1000]).toBe(0);
  });

  it('clearRam empties the live slot-0 RAM too when the +D is paged in', () => {
    const s = fitted(signatureRom());
    s.memory.writeByte(MARKER, D);
    s.mgtPlusD.clearRam(s.memory);
    expect(s.memory.getSlot(0)[MARKER]).toBe(0);
    s.mgtPlusD.pageOut(s.memory);
    expect(s.mgtPlusD.ram[MARKER - 0x2000]).toBe(0);
  });
});

describe('system file fallback', () => {
  it('loads the system where the ROM would, with its header, and resumes after the load', () => {
    const s = fitted(signatureRom());
    s.mgtPlusD.loadSystemFile(new Uint8Array([0x11, 0x22, 0x33]));
    s.cpu.pc = 0x03A2;
    s.cpu.f = 0x00;                                  // NZ: the +SYS* search failed
    s.mgtPlusD.checkM1Page(s.cpu, s.memory);
    expect(s.cpu.pc).toBe(0x03C7);
    const slot = s.memory.getSlot(0);
    expect([...slot.subarray(0x2000, 0x2003)]).toEqual([0x11, 0x22, 0x33]);
    // CODE, length 3, start 0x2000, then 0xFFFF / 0x0000: what a +SYS entry carries.
    expect([...slot.subarray(0x3E29, 0x3E32)]).toEqual([0x03, 0x03, 0x00, 0x00, 0x20, 0xFF, 0xFF, 0x00, 0x00]);
    expect(slot[0x3AD0]).toBe(0x09);                 // IX+0D, IX = 0x3AC3
  });

  it('leaves a successful search alone, so a disk with its own +SYS uses it', () => {
    const s = fitted(signatureRom());
    s.mgtPlusD.loadSystemFile(new Uint8Array([0x11]));
    s.cpu.pc = 0x03A2;
    s.cpu.f = 0x40;                                  // Z: found
    s.mgtPlusD.checkM1Page(s.cpu, s.memory);
    expect(s.cpu.pc).toBe(0x03A2);
    expect(s.memory.getSlot(0)[0x2000]).toBe(0);
  });

  it('does nothing without a system file: the ROM reports the missing file', () => {
    const s = fitted(signatureRom());
    s.cpu.pc = 0x03A2;
    s.cpu.f = 0x00;
    s.mgtPlusD.checkM1Page(s.cpu, s.memory);
    expect(s.cpu.pc).toBe(0x03A2);
  });

  it('does nothing on a ROM revision whose boot code differs', () => {
    const rom = signatureRom();
    rom[0x03A3] = 0x55;                              // JP NZ to somewhere else
    const s = fitted(rom);
    s.mgtPlusD.loadSystemFile(new Uint8Array([0x11]));
    expect(s.mgtPlusD.canSupplySystem).toBe(false);
    s.cpu.pc = 0x03A2;
    s.cpu.f = 0x00;
    s.mgtPlusD.checkM1Page(s.cpu, s.memory);
    expect(s.cpu.pc).toBe(0x03A2);
  });

  it('only acts while the +D ROM is paged in (0x03A2 is other code in the Spectrum ROM)', () => {
    const s = fitted(signatureRom());
    s.mgtPlusD.loadSystemFile(new Uint8Array([0x11]));
    s.mgtPlusD.pageOut(s.memory);
    s.cpu.pc = 0x03A2;
    s.cpu.f = 0x00;
    s.mgtPlusD.checkM1Page(s.cpu, s.memory);
    expect(s.cpu.pc).toBe(0x03A2);
  });

  it('rejects an empty system file and one too long to fit below the workspace', () => {
    const pd = new MgtPlusD();
    expect(pd.loadSystemFile(new Uint8Array(0))).toBe(false);
    expect(pd.loadSystemFile(new Uint8Array(0x1A01))).toBe(false);
    expect(pd.systemFile).toBeNull();
    expect(pd.loadSystemFile(new Uint8Array(0x1A00))).toBe(true);
  });
});

// ── A +D disk built byte by byte ─────────────────────────────────────────

interface DiskFile { type: number; name: string; header: number[]; body: Uint8Array }

/** An 800K .mgt image holding `files`, laid out from track 4 sector 1 as G+DOS
 *  does: an 80-entry directory on tracks 0-3 (side 0), each file a chain of
 *  510-byte sectors whose last two bytes give the next track/sector (0,0 ends),
 *  the file data starting with the same 9-byte header the entry carries. */
function mgtDisk(files: DiskFile[]): Uint8Array {
  const img = new Uint8Array(819200);
  const at = (track: number, sector: number) => ((track & 0x7F) * 2 + (track >> 7)) * 5120 + (sector - 1) * 512;
  let track = 4, sector = 1;
  files.forEach((f, i) => {
    const data = new Uint8Array([...f.header, ...f.body]);
    const count = Math.ceil(data.length / 510);
    const entry = at(Math.floor(i / 20), Math.floor((i % 20) / 2) + 1) + (i % 2) * 256;
    img[entry] = f.type;
    img.set([...f.name.padEnd(10, ' ')].map((c) => c.charCodeAt(0)), entry + 1);
    img[entry + 11] = count >> 8;
    img[entry + 12] = count & 0xFF;
    img[entry + 13] = track;
    img[entry + 14] = sector;
    img.set(f.header, entry + 211);
    for (let n = 0; n < count; n++) {
      const used = (track - 4) * 10 + (sector - 1);
      img[entry + 15 + (used >> 3)] |= 1 << (used & 7);
      const off = at(track, sector);
      img.set(data.subarray(n * 510, n * 510 + 510), off);
      if (++sector > 10) { sector = 1; track++; }
      if (n < count - 1) { img[off + 510] = track; img[off + 511] = sector; }
    }
  });
  return img;
}

/** `10 POKE 16384,255` as tokenised BASIC: marks the first screen byte. */
const POKE_PROGRAM = new Uint8Array([
  0x00, 0x0A, 23, 0x00,
  0xF4, 0x31, 0x36, 0x33, 0x38, 0x34, 0x0E, 0x00, 0x00, 0x00, 0x40, 0x00,
  0x2C, 0x32, 0x35, 0x35, 0x0E, 0x00, 0x00, 0xFF, 0x00, 0x00, 0x0D,
]);

/** A BASIC file that autostarts at line 10. */
function autoFile(): DiskFile {
  const len = POKE_PROGRAM.length;
  return { type: 1, name: 'AUTO', body: POKE_PROGRAM, header: [0x00, len & 0xFF, len >> 8, 0xCB, 0x5C, len & 0xFF, len >> 8, 10, 0] };
}

/** The G+DOS system as a CODE file loading at 0x2000. */
function sysFile(body: Uint8Array): DiskFile {
  return { type: 4, name: '+SYS', body, header: [0x03, body.length & 0xFF, body.length >> 8, 0x00, 0x20, 0xFF, 0xFF, 0x00, 0x00] };
}

function machine(model: 'zx48k' | 'zx128k'): Spectrum {
  const s = new Spectrum(model, null);
  if (model === 'zx48k') s.loadROM(read('48.rom'));
  else {
    const rom = new Uint8Array(32768);
    rom.set(read('128-0.rom'), 0);
    rom.set(read('128-1.rom'), 16384);
    s.loadROM(rom);
  }
  s.mgtPlusD.loadROM(read('plus-d.rom'));
  s.mgtPlusD.enabled = true;
  s.reset();
  return s;
}

/** Insert the disk in drive 1, arm the +D boot (RUN at the editor) and run
 *  until the AUTO program has poked the screen, or the frame budget is spent. */
function boot(s: Spectrum, disk: Uint8Array, frames = 1200): void {
  s.loadPlusDDisk(parseMgt(disk, 'mgt')!, 0);
  s.armBootTrap('plusd');
  for (let f = 0; f < frames && s.memory.readByte(0x4000) !== 0xFF; f++) s.tick();
}

describe.skipIf(!have(['48.rom', 'plus-d.rom', 'plus-d-system.bin']))('booting a +D disk (real G+DOS ROM)', () => {
  const system = read('plus-d-system.bin');

  it('the hosted ROM is the revision the fallback knows', () => {
    const s = machine('zx48k');
    s.mgtPlusD.loadSystemFile(system);
    expect(s.mgtPlusD.canSupplySystem).toBe(true);
  });

  it('a disk with its own +SYS file boots it and runs AUTO', () => {
    const s = machine('zx48k');
    boot(s, mgtDisk([sysFile(system), autoFile()]));
    expect(plusDRam(s, MARKER)).toBe(D);
    expect(s.memory.readByte(0x4000)).toBe(0xFF);
  });

  it('a disk without one does not boot when no system file is supplied', () => {
    const s = machine('zx48k');
    boot(s, mgtDisk([autoFile()]), 400);
    expect(plusDRam(s, MARKER)).toBe(X);
    expect(s.memory.readByte(0x4000)).toBe(0);
  });

  it('a disk without one boots from the supplied system file and runs its AUTO', () => {
    const s = machine('zx48k');
    s.mgtPlusD.loadSystemFile(system);
    boot(s, mgtDisk([autoFile()]));
    expect(plusDRam(s, MARKER)).toBe(D);
    // The system body is in place (its last byte is the ROM's checksum slot).
    for (const a of [0x2080, 0x2800, 0x39FE]) expect(plusDRam(s, a)).toBe(system[a - 0x2000]);
    expect(s.memory.readByte(0x4000)).toBe(0xFF);
  });

  it('the loaded system survives the reset button', () => {
    const s = machine('zx48k');
    s.mgtPlusD.loadSystemFile(system);
    boot(s, mgtDisk([autoFile()]));
    s.reset();
    for (let f = 0; f < 150; f++) s.tick();
    expect(plusDRam(s, MARKER)).toBe(D);
    expect(plusDRam(s, 0x2800)).toBe(system[0x0800]);
  });

  it('booting again starts from a powered-off +D, so the new disk is booted in full', () => {
    const s = machine('zx48k');
    s.mgtPlusD.loadSystemFile(system);
    boot(s, mgtDisk([autoFile()]));
    s.reset();
    s.mgtPlusD.systemFile = null;                    // the second boot must not find a system anywhere
    boot(s, mgtDisk([autoFile()]), 400);
    expect(plusDRam(s, MARKER)).toBe(X);
  });

  describe.skipIf(!have(['128-0.rom', '128-1.rom']))('on a 128K', () => {
    it('selects 48 BASIC and boots the same way', () => {
      const s = machine('zx128k');
      s.mgtPlusD.loadSystemFile(system);
      boot(s, mgtDisk([autoFile()]), 1500);
      expect(plusDRam(s, MARKER)).toBe(D);
      expect(s.memory.readByte(0x4000)).toBe(0xFF);
    });
  });
});
