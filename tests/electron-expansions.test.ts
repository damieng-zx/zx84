/**
 * Acorn Electron Plus 1 and Plus 3 expansions.
 *
 * Plus 1: expansion ROM in page 12, cartridge banks in pages 2/3, ADC / printer
 * port at &FC70-&FC72. Plus 3: ADFS ROM in page 4, drive-control latch at
 * &FCC0, WD1770 at &FCC4-&FCC7 with its DRQ/INTRQ on the CPU's NMI. The ROMs
 * here are synthetic; the real ones are exercised in electron-boot.test.ts.
 */

import { describe, it, expect } from 'vitest';
import { ElectronMachine } from '@/machines/electron/electron-machine.ts';
import { parseAdfs } from '@/media/floppy/adfs.ts';

function makeRom(): Uint8Array {
  const rom = new Uint8Array(0x8000);
  rom.set([0xEA, 0x4C, 0x00, 0xC0], 0x4000);                   // NOP ; JMP $C000
  rom[0x4000 + 0x3FFC] = 0x00; rom[0x4000 + 0x3FFD] = 0xC0;
  rom[0x4000 + 0x3FFE] = 0x00; rom[0x4000 + 0x3FFF] = 0xC0;
  return rom;
}

function machine(plus1 = false, plus3 = false): ElectronMachine {
  const m = new ElectronMachine('electron', null);
  m.loadROM(makeRom());
  m.setExpansions(plus1, plus3);
  m.reset();
  return m;
}

const labelled = (sectors: number): Uint8Array => {
  const d = new Uint8Array(sectors * 256);
  for (let s = 0; s < sectors; s++) for (let i = 0; i < 256; i++) d[s * 256 + i] = (s * 7 + i) & 0xFF;
  return d;
};

describe('Plus 1', () => {
  it('pages its expansion ROM into page 12 only when fitted, repeating a small ROM', () => {
    const m = machine(true);
    m.installPlus1Rom(Uint8Array.from({ length: 0x1000 }, (_, i) => i & 0xFF));   // a 4K ROM
    m.memory.romPage = 12;
    expect(m.memory.readByte(0x8005)).toBe(5);
    expect(m.memory.readByte(0x9005)).toBe(5);                  // repeats through the 16K window
    expect(m.memory.readByte(0xB0FF)).toBe(0xFF);
    m.destroy();
  });

  it('presents a 32K cartridge as pages 2 (lower bank) and 3 (upper bank)', () => {
    const m = machine(true);
    const cart = new Uint8Array(0x8000);
    cart.fill(0x11, 0, 0x4000); cart.fill(0x22, 0x4000);
    m.insertCartridge(cart, 'game.rom');
    m.memory.romPage = 2;
    expect(m.memory.readByte(0x8000)).toBe(0x11);
    m.memory.romPage = 3;
    expect(m.memory.readByte(0x8000)).toBe(0x22);
    m.memory.romPage = 13;                                      // a plain cartridge doesn't answer here
    expect(m.memory.readByte(0x8000)).toBe(0xFF);
    expect(m.cartridgeName).toBe('game.rom');
    m.destroy();
  });

  it('repeats a 16K cartridge in both banks and removes it on eject', () => {
    const m = machine(true);
    m.insertCartridge(new Uint8Array(0x4000).fill(0x33), 'small.rom');
    m.memory.romPage = 3;
    expect(m.memory.readByte(0x9000)).toBe(0x33);
    m.ejectCartridge();
    expect(m.memory.readByte(0x9000)).toBe(0xFF);
    expect(m.cartridgeName).toBe('');
    m.destroy();
  });

  it('beats a user ROM in the same page', () => {
    const m = machine(true);
    m.loadPagedRom(2, new Uint8Array(0x4000).fill(0x44));
    m.insertCartridge(new Uint8Array(0x4000).fill(0x55), 'c.rom');
    m.memory.romPage = 2;
    expect(m.memory.readByte(0x8000)).toBe(0x55);
    m.ejectCartridge();
    expect(m.memory.readByte(0x8000)).toBe(0x44);
    m.destroy();
  });

  it('reports status &7F-ish: conversion done, no fire, printer ready, and a centred ADC', () => {
    const m = machine(true);
    expect(m.memory.readByte(0xFC72)).toBe(0x7F);
    m.memory.writeByte(0xFC70, 0x01);                           // convert channel 1
    expect(m.memory.readByte(0xFC70)).toBe(0x80);
    m.memory.writeByte(0xFC71, 0x41);
    m.memory.writeByte(0xFC71, 0x42);
    expect(m.plus1.printed).toEqual([0x41, 0x42]);
    m.destroy();
  });

  it('floats FRED high when not fitted', () => {
    const m = machine(false);
    expect(m.memory.readByte(0xFC72)).toBe(0xFF);
    expect(m.memory.readByte(0xFC70)).toBe(0xFF);
    m.memory.writeByte(0xFC71, 0x41);
    expect(m.plus1.printed).toEqual([]);
    m.destroy();
  });

  it('exposes the cartridge slot and .rom media only while fitted', async () => {
    const bare = machine(false);
    expect(bare.services.roms.cartridge).toBeNull();
    expect(bare.services.media.accepts().map(t => t.ext)).not.toContain('.rom');
    const refused = await bare.services.media.mount(new Uint8Array(0x4000), 'c.rom');
    expect(refused.ok).toBe(false);
    bare.destroy();

    const fitted = machine(true);
    expect(fitted.services.roms.cartridge).not.toBeNull();
    expect(fitted.services.media.accepts().map(t => t.ext)).toContain('.rom');
    const ok = await fitted.services.media.mount(new Uint8Array(0x4000).fill(0x66), 'c.rom');
    expect(ok).toMatchObject({ ok: true, target: 'cartridge' });
    expect(fitted.cartridgeName).toBe('c.rom');
    fitted.destroy();
  });

  describe('two-file cartridges (Name_1.rom + Name_2.rom)', () => {
    const half = (fill: number): Uint8Array => new Uint8Array(0x4000).fill(fill);
    const bank = (m: ElectronMachine, page: number): number => {
      m.memory.romPage = page;
      return m.memory.readByte(0x8000);
    };

    it('joins _1 and _2 into lower and upper banks, in either order', async () => {
      for (const order of [[1, 2], [2, 1]] as const) {
        const m = machine(true);
        for (const n of order) {
          const r = await m.services.media.mount(half(n === 1 ? 0xA1 : 0xB2), `Doom_${n}.rom`);
          expect(r.ok).toBe(true);
        }
        expect(bank(m, 2)).toBe(0xA1);
        expect(bank(m, 3)).toBe(0xB2);
        m.destroy();
      }
    });

    it('leaves a lone half mirrored across both banks', async () => {
      const m = machine(true);
      await m.services.media.mount(half(0xB2), 'Doom_2.rom');
      expect(bank(m, 2)).toBe(0xB2);
      expect(bank(m, 3)).toBe(0xB2);
      m.destroy();
    });

    it('does not join halves of different cartridges', async () => {
      const m = machine(true);
      await m.services.media.mount(half(0xA1), 'Doom_1.rom');
      await m.services.media.mount(half(0xB2), 'Other_2.rom');
      expect(bank(m, 2)).toBe(0xB2);
      expect(bank(m, 3)).toBe(0xB2);
      m.destroy();
    });

    it('does not join once the first half has been ejected or replaced', async () => {
      const m = machine(true);
      await m.services.media.mount(half(0xA1), 'Doom_1.rom');
      m.services.roms.cartridge!.eject();
      await m.services.media.mount(half(0xB2), 'Doom_2.rom');
      expect(bank(m, 2)).toBe(0xB2);
      expect(bank(m, 3)).toBe(0xB2);

      await m.services.media.mount(half(0xA1), 'Doom_1.rom');
      await m.services.media.mount(half(0xCC), 'plain.rom');
      await m.services.media.mount(half(0xB2), 'Doom_2.rom');
      expect(bank(m, 2)).toBe(0xB2);
      m.destroy();
    });

    it('treats a full 32K _1 image as a cartridge in its own right', async () => {
      const m = machine(true);
      const full = new Uint8Array(0x8000);
      full.fill(0x11, 0, 0x4000); full.fill(0x22, 0x4000);
      await m.services.media.mount(full, 'Big_1.rom');
      await m.services.media.mount(half(0x33), 'Big_2.rom');
      expect(bank(m, 2)).toBe(0x33);
      expect(bank(m, 3)).toBe(0x33);
      m.destroy();
    });
  });

  it('boots a cartridge with SHIFT held, releasing it after the OS has had time to look', () => {
    const m = machine(true);
    m.services.roms.cartridge!.insert(new Uint8Array(0x4000), 'c.rom');
    expect(m.keyboard.isPressed(13, 3)).toBe(true);
    for (let i = 0; i < 30; i++) m.tick();
    expect(m.keyboard.isPressed(13, 3)).toBe(false);
    m.destroy();
  });

  it('takes the cartridge out when the Plus 1 is removed', () => {
    const m = machine(true);
    m.insertCartridge(new Uint8Array(0x4000).fill(1), 'c.rom');
    m.setExpansions(false, false);
    m.memory.romPage = 2;
    expect(m.memory.readByte(0x8000)).toBe(0xFF);
    expect(m.cartridgeName).toBe('');
    m.destroy();
  });
});

describe('Plus 3', () => {
  /** Run a polled sector read the way ADFS does: command, then status/data. */
  function readSector(m: ElectronMachine, track: number, sector: number): number[] {
    const plus3 = m.plus3;
    m.memory.writeByte(0xFCC0, 0x21);                           // drive 0, controller running
    m.memory.writeByte(0xFCC5, track);                          // track register (pretend we're there)
    m.memory.writeByte(0xFCC6, sector);
    m.memory.writeByte(0xFCC4, 0x80);                           // READ SECTOR
    const bytes: number[] = [];
    let guard = 0;
    while (bytes.length < 256 && guard++ < 100000) {
      plus3.tick(8);
      if (m.memory.readByte(0xFCC4) & 0x02) bytes.push(m.memory.readByte(0xFCC7));
    }
    return bytes;
  }

  it('pages the ADFS ROM into page 4 and the controller onto &FCC4-&FCC7 only when fitted', () => {
    const bare = machine(false, false);
    expect(bare.memory.readByte(0xFCC4)).toBe(0xFF);
    bare.destroy();
    const m = machine(false, true);
    m.installPlus3Rom(new Uint8Array(0x4000).fill(0x77));
    m.memory.romPage = 4;
    expect(m.memory.readByte(0x8000)).toBe(0x77);
    expect(m.memory.readByte(0xFCC0)).toBe(0xFF);               // the latch is write-only
    expect(m.memory.readByte(0xFCC4) & 0x80).toBe(0x00);        // motor off until a command
    m.destroy();
  });

  it('reads a sector through the status/data registers, one DRQ per byte', () => {
    const m = machine(false, true);
    const img = labelled(16 * 40);
    m.services.disks.insert('a', parseAdfs(img), 'd.adf');
    const got = readSector(m, 0, 3);
    expect(got).toEqual(Array.from(img.subarray(3 * 256, 4 * 256)));
    m.destroy();
  });

  it('drops DRQ once a byte is taken, until the next is offered', () => {
    const m = machine(false, true);
    m.services.disks.insert('a', parseAdfs(labelled(16 * 40)), 'd.adf');
    m.memory.writeByte(0xFCC0, 0x21);
    m.memory.writeByte(0xFCC6, 0);
    m.memory.writeByte(0xFCC4, 0x80);
    m.plus3.tick(1000);
    expect(m.memory.readByte(0xFCC4) & 0x02).toBe(0x02);
    m.memory.readByte(0xFCC7);
    expect(m.memory.readByte(0xFCC4) & 0x02).toBe(0x00);        // the byte was taken
    m.plus3.tick(1000);
    expect(m.memory.readByte(0xFCC4) & 0x02).toBe(0x02);
    m.destroy();
  });

  it('raises NMI when a command completes', () => {
    const m = machine(false, true);
    let nmis = 0;
    const nmi = m.cpu.nmi.bind(m.cpu);
    m.cpu.nmi = () => { nmis++; nmi(); };
    m.services.disks.insert('a', parseAdfs(labelled(16 * 40)), 'd.adf');
    m.memory.writeByte(0xFCC0, 0x21);
    m.memory.writeByte(0xFCC4, 0x00);                           // RESTORE
    m.plus3.tick(2000);
    expect(nmis).toBeGreaterThan(0);
    m.destroy();
  });

  it('selects the drive and side from the control latch', () => {
    const m = machine(false, true);
    m.memory.writeByte(0xFCC0, 0x22 | 0x04);                    // drive 1, side 1
    expect(m.plus3.currentDrive).toBe(1);
    m.memory.writeByte(0xFCC0, 0x21);
    expect(m.plus3.currentDrive).toBe(0);
    m.destroy();
  });

  it('advances the controller from the machine clock so a read completes under CPU control', () => {
    const m = machine(false, true);
    const img = labelled(16 * 40);
    m.services.disks.insert('a', parseAdfs(img), 'd.adf');
    // Poll loop in OS ROM space: LDX #0 ; loop: LDA $FCC4 ; AND #2 ; BEQ loop ; LDA $FCC7 ; STA $0200,X ; INX ; JMP loop
    const rom = makeRom();
    rom.set([0xA2, 0x00, 0xAD, 0xC4, 0xFC, 0x29, 0x02, 0xF0, 0xF9,
      0xAD, 0xC7, 0xFC, 0x9D, 0x00, 0x02, 0xE8, 0x4C, 0x02, 0xC0], 0x4000);
    // The controller's DRQ/INTRQ edges are NMIs; the OS leaves an RTI behind its NMI vector.
    rom[0x4000 + 0x100] = 0x40;
    rom[0x4000 + 0x3FFA] = 0x00; rom[0x4000 + 0x3FFB] = 0xC1;
    m.loadROM(rom);
    m.reset();
    m.services.disks.insert('a', parseAdfs(img), 'd.adf');
    m.memory.writeByte(0xFCC0, 0x21);
    m.memory.writeByte(0xFCC6, 5);
    m.memory.writeByte(0xFCC4, 0x80);
    for (let i = 0; i < 6; i++) m.tick();
    expect(Array.from(m.memory.ram.subarray(0x200, 0x300))).toEqual(Array.from(img.subarray(5 * 256, 6 * 256)));
    m.destroy();
  });

  it('serves ADFS discs only once fitted, boots drive 0 with SHIFT+BREAK and saves .adl', async () => {
    const bare = machine(false, false);
    expect(bare.services.media.accepts().map(t => t.ext)).not.toContain('.adl');
    expect(bare.services.disks.drives).toHaveLength(0);
    expect((await bare.services.media.mount(new Uint8Array(655360), 'x.adl')).ok).toBe(false);
    bare.destroy();

    const m = machine(false, true);
    expect(m.services.media.accepts().map(t => t.ext)).toEqual(
      expect.arrayContaining(['.adf', '.adl', '.ads', '.adm']));
    expect(m.services.disks.drives.map(d => d.id)).toEqual(['a', 'b']);
    const res = await m.services.media.mount(labelled(2560), 'x.adl');
    expect(res).toMatchObject({ ok: true, target: 'a' });
    expect(m.keyboard.isPressed(13, 3)).toBe(true);             // SHIFT+BREAK
    const saved = m.services.disks.save('a')!;
    expect(saved.name).toBe('x.adl');
    expect(saved.data.length).toBe(655360);
    expect(m.services.disks.drives[0].loaded).toBe(true);
    const second = await m.services.media.mount(labelled(1280), 'y.adf', 'b');
    expect(second).toMatchObject({ ok: true, target: 'b' });
    expect(m.services.disks.save('b')!.name).toBe('y.adm');
    m.destroy();
  });

  it('ejects discs when the Plus 3 is removed', () => {
    const m = machine(false, true);
    m.services.disks.insert('a', parseAdfs(labelled(640)), 'd.adf');
    m.setExpansions(false, false);
    expect(m.plus3.getDiskImage(0)).toBeNull();
    m.destroy();
  });

  it('asks for the Plus 1 and Plus 3 ROMs only for the expansions that are fitted', () => {
    const m = new ElectronMachine('electron', null);
    const view = (on: string[]) => ({ get: <T,>(k: string, f: T): T => (on.includes(k) ? (true as T) : f) });
    expect(m.prepare(view([]))).toEqual([]);
    expect(m.prepare(view(['electron-plus1'])).map(r => r.source)).toEqual(['electron/plus1.rom']);
    expect(m.prepare(view(['electron-plus3'])).map(r => r.source)).toEqual(['electron/plus3.rom']);
    expect(m.prepare(view(['electron-plus1', 'electron-plus3'])).map(r => r.source))
      .toEqual(['electron/plus1.rom', 'electron/plus3.rom']);
    m.destroy();
  });
});
