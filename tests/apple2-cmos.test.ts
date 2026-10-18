/**
 * The CMOS Apple II models: the Enhanced //e and the //c. A 65C02 instead of the
 * NMOS 6502, MouseText in the alternate character set, and (on the //c) a
 * machine with no slots. Synthetic ROMs stand in for the real ones.
 */

import { describe, it, expect } from 'vitest';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';
import { apple2Entry } from '@/machines/apple2/descriptor.ts';
import { Apple2eCharset } from '@/machines/apple2/apple2-charset.ts';
import { apple2ModelInfo } from '@/machines/apple2/models.ts';
import { ocrApple2Text } from '@/ocr/apple2.ts';
import { disasmOne, stripMarkers } from '@/debug/m6502/disasm.ts';

const view = (values: Record<string, unknown> = {}) =>
  ({ get: (key: string, fallback: unknown) => (key in values ? values[key] : fallback) }) as never;

const rd = (m: Apple2Machine, a: number) => m.memory.readByte(a);
const wr = (m: Apple2Machine, a: number, v: number) => m.memory.writeByte(a, v);

/** A 16K ROM with a distinct internal $C600 byte and a reset vector into $D000. */
function makeRom(): Uint8Array {
  const rom = new Uint8Array(0x4000).fill(0xEA);
  rom[0x0600] = 0x66;            // $C600  internal ROM
  rom[0x1000] = 0xD0;            // $D000
  rom[0x3FFC] = 0x00;
  rom[0x3FFD] = 0xD0;
  return rom;
}

describe('CMOS models: registration', () => {
  it('registers the Enhanced //e and //c with their own ROMs and a shared MouseText character ROM', () => {
    expect(apple2Entry.models).toEqual(expect.arrayContaining(['apple2e-enhanced', 'apple2c']));
    expect(apple2Entry.romSources('apple2e-enhanced')).toEqual(['apple2/apple2e-enhanced.rom']);
    expect(apple2Entry.romSources('apple2c')).toEqual(['apple2/apple2c.rom']);
    expect(apple2ModelInfo('apple2e-enhanced').charsetSource).toBe('apple2/apple2e-enhanced-video.rom');
    expect(apple2ModelInfo('apple2c').charsetSource).toBe('apple2/apple2e-enhanced-video.rom');
  });

  it('gives a 65C02 to exactly the CMOS models', () => {
    for (const [model, cmos] of [
      ['apple2', false], ['apple2-plus', false], ['apple2e', false],
      ['apple2e-enhanced', true], ['apple2c', true],
    ] as const) {
      const m = new Apple2Machine(model, null);
      try {
        expect(m.cpu.cmos).toBe(cmos);
        expect(apple2ModelInfo(model).cmos).toBe(cmos);
      } finally { m.destroy(); }
    }
  });

  it('runs 65C02 code through the machine bus', () => {
    const m = new Apple2Machine('apple2e-enhanced', null);
    try {
      m.loadROM(makeRom());
      m.cpu.reset();
      const prog = [0xA9, 0x40, 0x1A, 0x8D, 0x00, 0x03, 0x9C, 0x01, 0x03];   // LDA #$40; INC A; STA $0300; STZ $0301
      prog.forEach((b, i) => wr(m, 0x0200 + i, b));
      wr(m, 0x0301, 0xFF);
      m.cpu.pc = 0x0200;
      for (let i = 0; i < 4; i++) m.cpu.step();
      expect(rd(m, 0x0300)).toBe(0x41);
      expect(rd(m, 0x0301)).toBe(0);
    } finally { m.destroy(); }
  });
});

describe('CMOS models: disassembly', () => {
  it('knows the 65C02 instructions only when asked', () => {
    const mem = new Uint8Array(0x10000);
    mem.set([0x1A, 0x80, 0x10, 0xB2, 0x20, 0x7C, 0x00, 0x30, 0x64, 0x05], 0x1000);
    const text = (addr: number, cmos: boolean) => stripMarkers(disasmOne(mem, addr, cmos).text);
    expect(text(0x1000, true)).toBe('INC A');
    expect(text(0x1001, true)).toBe('BRA 1013');
    expect(text(0x1003, true)).toBe('LDA (20)');
    expect(text(0x1005, true)).toBe('JMP (3000,X)');
    expect(text(0x1008, true)).toBe('STZ 05');
    expect(text(0x1000, false)).toBe('NOP');       // NMOS: an undocumented NOP
  });

  it('shows the undocumented NMOS opcodes as NOPs on the CMOS part', () => {
    const mem = new Uint8Array(0x10000);
    mem.set([0xA3, 0x5C, 0x12, 0x34, 0xEB], 0x1000);
    expect(disasmOne(mem, 0x1000, true).length).toBe(1);
    expect(stripMarkers(disasmOne(mem, 0x1000, true).text)).toBe('NOP');
    expect(disasmOne(mem, 0x1001, true).length).toBe(3);
    expect(disasmOne(mem, 0x1004, true).length).toBe(1);
    expect(stripMarkers(disasmOne(mem, 0x1000, false).text)).toContain('LAX');
  });
});

describe('Enhanced //e character set: MouseText', () => {
  /** A 2K character ROM where glyph $01 is the flashing '@A-Z' source and $41 is MouseText. */
  function charset(): Apple2eCharset {
    const rom = new Uint8Array(0x800).fill(0xFF);
    for (let r = 0; r < 8; r++) {
      rom[(0x01 << 3) | r] = 0x7F & ~0b0001000;      // a single lit column
      rom[(0x41 << 3) | r] = 0x7F & ~0b1000001;      // MouseText: the outer columns
    }
    const set = new Apple2eCharset();
    set.load(rom);
    return set;
  }

  it("flashes the inverse set's glyphs in the primary set, not the MouseText slots", () => {
    const set = charset();
    for (let row = 0; row < 8; row++) {
      expect(set.glyph(0x41, row, true, false)).toBe(set.glyph(0x01, row, true, false));
    }
  });

  it('shows MouseText for $40-$5F in the alternate set', () => {
    const set = charset();
    expect(set.glyph(0x41, 0, true, true)).not.toBe(set.glyph(0x01, 0, true, false));
    expect(set.glyph(0x41, 0, true, true)).toBe(0b1000001);
  });

  it('leaves MouseText cells unmasked in the OCR', () => {
    const ram = new Uint8Array(0x10000);
    ram[0x400] = 0x41;                // MouseText with the alternate set on
    ram[0x401] = 0xC1;                // a normal 'A'
    const out = ocrApple2Text({
      ram, page2: false, textRows: { first: 0, last: 23 },
      iie: true, altCharset: true, mouseText: true,
    });
    expect(out.mask[0]).toBe(false);
    expect(out.mask[1]).toBe(true);
    expect(out.text.startsWith(' A')).toBe(true);
  });
});

describe('Apple //c', () => {
  const makeC = (settings: Record<string, unknown> = {}) => {
    const m = new Apple2Machine('apple2c', null);
    const requests = m.prepare(view(settings));
    return { m, requests };
  };

  it('has 128K, 80 columns and the disk controller built in, whatever the settings say', () => {
    const { m, requests } = makeC({
      'apple2-disk2': false, 'apple2e-80col': false, 'apple2-mockingboard': true,
    });
    try {
      expect(m.options.disk2).toBe(true);
      expect(m.options.eightyColumn).toBe(true);
      expect(m.options.languageCard).toBe(true);
      expect(m.options.mockingboard).toBe(false);
      expect(m.mmu.auxFitted).toBe(true);
      expect(m.mockingboard).toBeNull();
      // The disk firmware is inside the system ROM, so no controller ROM is fetched.
      expect(requests.map(r => r.cacheKey)).toEqual(['apple2-chargen']);
    } finally { m.destroy(); }
  });

  it('always reads $C100-$CFFF from the internal ROM', () => {
    const { m } = makeC();
    try {
      m.loadROM(makeRom());
      m.memory.loadSlotRom(6, new Uint8Array(0x100).fill(0x99));
      expect(m.mmu.intcxrom).toBe(true);
      expect(rd(m, 0xC600)).toBe(0x66);
      wr(m, 0xC006, 0);                                // INTCXROM off: a no-op on the //c
      wr(m, 0xC00B, 0);                                // SLOTC3ROM on: likewise
      expect(m.mmu.intcxrom).toBe(true);
      expect(m.mmu.slotc3rom).toBe(false);
      expect(rd(m, 0xC600)).toBe(0x66);
      m.reset();
      expect(m.mmu.intcxrom).toBe(true);
    } finally { m.destroy(); }
  });

  it('lets the other //e models switch to their slot ROMs as before', () => {
    const m = new Apple2Machine('apple2e-enhanced', null);
    try {
      m.prepare(view());
      m.loadROM(makeRom());
      m.memory.loadSlotRom(6, new Uint8Array(0x100).fill(0x99));
      expect(rd(m, 0xC600)).toBe(0x99);
      wr(m, 0xC007, 0);                                // INTCXROM on
      expect(rd(m, 0xC600)).toBe(0x66);
    } finally { m.destroy(); }
  });
});
