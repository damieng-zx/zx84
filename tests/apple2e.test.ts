/**
 * Apple //e (unenhanced) tests — the MMU and auxiliary memory, the //e soft
 * switches, its keyboard and character set, 80-column text and double hi-res.
 * A synthetic ROM stands in for the real one, so these run anywhere.
 */

import { describe, it, expect } from 'vitest';
import { Apple2Machine } from '@/machines/apple2/apple2-machine.ts';
import { apple2Entry } from '@/machines/apple2/descriptor.ts';
import { Apple2eCharset } from '@/machines/apple2/apple2-charset.ts';
import { apple2eKeyByte } from '@/machines/apple2/apple2-keyboard.ts';
import { ocrApple2Text, apple2eChar } from '@/ocr/apple2.ts';
import { hiresRowBase, textRowBase } from '@/machines/apple2/apple2-video.ts';
import type { Apple2VideoMode } from '@/machines/apple2/apple2-video.ts';
import {
  APPLE2_BORDER_LEFT, APPLE2_BORDER_TOP, APPLE2_SCREEN_WIDTH,
} from '@/machines/apple2/constants.ts';
import type { HostKeyEvent } from '@/machines/machine.ts';

const view = (values: Record<string, unknown> = {}) =>
  ({ get: (key: string, fallback: unknown) => (key in values ? values[key] : fallback) }) as never;

/** A //e with the extended 80-column card fitted (the default) or not. */
function makeIie(withCard = true): Apple2Machine {
  const m = new Apple2Machine('apple2e', null);
  m.prepare(view({ 'apple2e-80col': withCard }));
  return m;
}

/** A 16K //e ROM with recognisable bytes: internal $C100/$C300/$C800, ROM $D000. */
function makeRom(): Uint8Array {
  const rom = new Uint8Array(0x4000).fill(0xEA);
  rom[0x0100] = 0x11;            // $C100  internal ROM
  rom[0x0300] = 0x33;            // $C300  internal 80-column firmware
  rom[0x0800] = 0x88;            // $C800  internal expansion ROM
  rom[0x0FFF] = 0xCF;            // $CFFF
  rom[0x1000] = 0xD0;            // $D000  system ROM
  rom[0x3FFC] = 0x00;            // reset vector -> $D000
  rom[0x3FFD] = 0xD0;
  return rom;
}

const rd = (m: Apple2Machine, a: number) => m.memory.readByte(a);
const wr = (m: Apple2Machine, a: number, v: number) => m.memory.writeByte(a, v);

describe('apple //e registration', () => {
  it('is registered and uses its own ROM and character generator', () => {
    expect(apple2Entry.models).toContain('apple2e');
    expect(apple2Entry.romSources('apple2e')).toEqual(['apple2/apple2e.rom']);
    const m = makeIie();
    try {
      expect(m.isIie).toBe(true);
      const requests = m.prepare(view());
      expect(requests.find(r => r.failId === 'apple2-chargen')?.source).toBe('apple2/apple2e-video.rom');
    } finally { m.destroy(); }
  });
});

describe('apple //e memory: main and auxiliary RAM', () => {
  it('reads and writes the main bank by default', () => {
    const m = makeIie();
    try {
      wr(m, 0x3000, 0x12);
      expect(m.mmu.ram[0x3000]).toBe(0x12);
      expect(m.mmu.aux[0x3000]).toBe(0);
    } finally { m.destroy(); }
  });

  it('selects the auxiliary bank for reads and writes independently', () => {
    const m = makeIie();
    try {
      wr(m, 0xC005, 0);                  // RAMWRT on
      wr(m, 0x3000, 0xAA);               // lands in aux
      expect(m.mmu.aux[0x3000]).toBe(0xAA);
      expect(m.mmu.ram[0x3000]).toBe(0);
      expect(rd(m, 0x3000)).toBe(0);     // RAMRD still off: reads main
      wr(m, 0xC003, 0);                  // RAMRD on
      expect(rd(m, 0x3000)).toBe(0xAA);
      wr(m, 0xC004, 0);                  // RAMWRT off
      wr(m, 0x3000, 0x55);
      expect(m.mmu.ram[0x3000]).toBe(0x55);
      expect(rd(m, 0x3000)).toBe(0xAA);  // still reading aux
    } finally { m.destroy(); }
  });

  it('moves zero page and stack with ALTZP', () => {
    const m = makeIie();
    try {
      wr(m, 0x0010, 0x01);
      wr(m, 0xC009, 0);                  // ALTZP on
      expect(rd(m, 0x0010)).toBe(0);
      wr(m, 0x0010, 0x02);
      expect(m.mmu.aux[0x10]).toBe(0x02);
      wr(m, 0xC008, 0);                  // ALTZP off
      expect(rd(m, 0x0010)).toBe(0x01);
    } finally { m.destroy(); }
  });

  it('lets PAGE2 pick the bank for the text page under 80STORE, ignoring RAMRD/RAMWRT', () => {
    const m = makeIie();
    try {
      wr(m, 0xC001, 0);                  // 80STORE on
      wr(m, 0x0400, 0x41);               // PAGE2 off: main
      rd(m, 0xC055);                     // PAGE2 on
      wr(m, 0x0400, 0x42);               // -> aux
      expect(m.mmu.ram[0x400]).toBe(0x41);
      expect(m.mmu.aux[0x400]).toBe(0x42);
      expect(rd(m, 0x0400)).toBe(0x42);
      wr(m, 0xC002, 0);                  // RAMRD on does not override 80STORE
      rd(m, 0xC054);                     // PAGE2 off
      expect(rd(m, 0x0400)).toBe(0x41);
      wr(m, 0x0800, 0x77);               // outside the text page: RAMWRT/RAMRD rule
      expect(m.mmu.ram[0x800]).toBe(0x77);
    } finally { m.destroy(); }
  });

  it('pages the hi-res area by PAGE2 only when HIRES is on', () => {
    const m = makeIie();
    try {
      wr(m, 0xC001, 0);                  // 80STORE on
      rd(m, 0xC055);                     // PAGE2 on
      wr(m, 0x2000, 0x01);               // HIRES off: ordinary RAMWRT rule -> main
      expect(m.mmu.ram[0x2000]).toBe(0x01);
      rd(m, 0xC057);                     // HIRES on
      wr(m, 0x2000, 0x02);               // now follows PAGE2 -> aux
      expect(m.mmu.aux[0x2000]).toBe(0x02);
    } finally { m.destroy(); }
  });

  it('reads status of every MMU switch back in bit 7', () => {
    const m = makeIie();
    try {
      for (const [setAddr, readAddr] of [
        [0xC001, 0xC018], [0xC003, 0xC013], [0xC005, 0xC014], [0xC007, 0xC015],
        [0xC009, 0xC016], [0xC00B, 0xC017], [0xC00D, 0xC01F], [0xC00F, 0xC01E],
      ] as const) {
        expect(rd(m, readAddr) & 0x80, `before ${setAddr.toString(16)}`).toBe(0);
        wr(m, setAddr, 0);
        expect(rd(m, readAddr) & 0x80, `after ${setAddr.toString(16)}`).toBe(0x80);
        wr(m, setAddr - 1, 0);
        expect(rd(m, readAddr) & 0x80, `cleared ${setAddr.toString(16)}`).toBe(0);
      }
    } finally { m.destroy(); }
  });

  it('floats the auxiliary side without the extended 80-column card', () => {
    const m = makeIie(false);
    try {
      wr(m, 0xC005, 0); wr(m, 0xC003, 0);
      wr(m, 0x3000, 0x99);
      expect(rd(m, 0x3000)).toBe(0xFF);
      expect(m.mmu.ram[0x3000]).toBe(0);
    } finally { m.destroy(); }
  });

  it('clears every MMU switch on reset', () => {
    const m = makeIie();
    try {
      m.loadROM(makeRom());
      for (const a of [0xC001, 0xC003, 0xC005, 0xC007, 0xC009, 0xC00B, 0xC00D, 0xC00F]) wr(m, a, 0);
      m.reset();
      for (const a of [0xC018, 0xC013, 0xC014, 0xC015, 0xC016, 0xC017, 0xC01F, 0xC01E]) {
        expect(rd(m, a) & 0x80, a.toString(16)).toBe(0);
      }
    } finally { m.destroy(); }
  });
});

describe('apple //e memory: ROM and language card', () => {
  it('maps the 16K ROM: internal $C100-$CFFF and system $D000-$FFFF', () => {
    const m = makeIie();
    try {
      m.loadROM(makeRom());
      wr(m, 0xC007, 0);                  // INTCXROM on
      expect(rd(m, 0xC100)).toBe(0x11);
      expect(rd(m, 0xD000)).toBe(0xD0);
      expect(rd(m, 0xFFFD)).toBe(0xD0);
    } finally { m.destroy(); }
  });

  it('shows the built-in 80-column firmware at $C300 unless SLOTC3ROM selects the card', () => {
    const m = makeIie();
    try {
      m.loadROM(makeRom());
      m.memory.loadSlotRom(3, new Uint8Array(256).fill(0x77));
      m.memory.loadSlotRom(2, new Uint8Array(256).fill(0x22));
      expect(rd(m, 0xC300)).toBe(0x33);  // internal, though a card is in slot 3
      expect(rd(m, 0xC200)).toBe(0x22);  // other slots show their cards
      wr(m, 0xC00B, 0);                  // SLOTC3ROM on
      expect(rd(m, 0xC300)).toBe(0x77);
    } finally { m.destroy(); }
  });

  it('latches the internal $C800 ROM when $C3xx is touched, until $CFFF is read', () => {
    const m = makeIie();
    try {
      m.loadROM(makeRom());
      expect(rd(m, 0xC800)).toBe(0xFF);  // nothing owns $C800 yet
      rd(m, 0xC300);                     // internal 80-column firmware selects it
      expect(rd(m, 0xC800)).toBe(0x88);
      rd(m, 0xCFFF);                     // any $CFFF access releases it
      expect(rd(m, 0xC800)).toBe(0xFF);
    } finally { m.destroy(); }
  });

  it('keeps separate language-card RAM for ALTZP', () => {
    const m = makeIie();
    try {
      m.loadROM(makeRom());
      rd(m, 0xC083); rd(m, 0xC083);      // LC: read RAM, write enabled (bank 2)
      wr(m, 0xD000, 0x61);
      wr(m, 0xC009, 0);                  // ALTZP on: the auxiliary card
      wr(m, 0xD000, 0x62);
      expect(rd(m, 0xD000)).toBe(0x62);
      wr(m, 0xC008, 0);
      expect(rd(m, 0xD000)).toBe(0x61);
      expect(rd(m, 0xC011) & 0x80).toBe(0x80);   // BSRBANK2
      expect(rd(m, 0xC012) & 0x80).toBe(0x80);   // BSRREADRAM
    } finally { m.destroy(); }
  });

  it('snapshots the current mapping without tripping any switch', () => {
    const m = makeIie();
    try {
      m.loadROM(makeRom());
      wr(m, 0xC005, 0); wr(m, 0x3000, 0xAA); wr(m, 0xC004, 0); wr(m, 0xC003, 0);
      const snap = m.memory.snapshot();
      expect(snap[0x3000]).toBe(0xAA);       // reading aux
      expect(snap[0xD000]).toBe(0xD0);
      expect(m.mmu.intc8rom).toBe(false);    // snapshot() touched no latch
    } finally { m.destroy(); }
  });
});

describe('apple //e soft switches', () => {
  it('reads the display switches back and keeps 80STORE paging in step', () => {
    const m = makeIie();
    try {
      expect(rd(m, 0xC01A) & 0x80).toBe(0x80);   // TEXT on at power-up
      rd(m, 0xC050); rd(m, 0xC052); rd(m, 0xC057);
      expect(rd(m, 0xC01A) & 0x80).toBe(0);
      expect(rd(m, 0xC01D) & 0x80).toBe(0x80);   // HIRES
      expect(rd(m, 0xC01B) & 0x80).toBe(0);
      rd(m, 0xC053);
      expect(rd(m, 0xC01B) & 0x80).toBe(0x80);   // MIXED
      rd(m, 0xC055);
      expect(rd(m, 0xC01C) & 0x80).toBe(0x80);   // PAGE2
      expect(m.mmu.hires).toBe(true);
    } finally { m.destroy(); }
  });

  it('turns double hi-res on at $C05E and off at $C05F', () => {
    const m = makeIie();
    try {
      rd(m, 0xC05E);
      expect(m.dhires).toBe(true);
      expect(rd(m, 0xC07F) & 0x80).toBe(0x80);
      wr(m, 0xC05F, 0);
      expect(m.dhires).toBe(false);
    } finally { m.destroy(); }
  });

  it('reports vertical blanking inverted ($C019 is high while the beam draws)', () => {
    const m = makeIie();
    try {
      expect(rd(m, 0xC019) & 0x80).toBe(0x80);   // start of the frame: drawing
    } finally { m.destroy(); }
  });

  it('returns any-key-down from $C010 and clears the strobe', () => {
    const m = makeIie();
    try {
      m.keyboard.setKey(0x41, true);
      expect(rd(m, 0xC000)).toBe(0xC1);          // key with the strobe
      expect(rd(m, 0xC010) & 0x80).toBe(0x80);   // still held
      expect(rd(m, 0xC000) & 0x80).toBe(0);      // strobe cleared
      m.keyboard.setKey(0x41, false);
      expect(rd(m, 0xC010) & 0x80).toBe(0);
    } finally { m.destroy(); }
  });
});

describe('apple //e keyboard', () => {
  const key = (code: string, k: string, mods: Partial<HostKeyEvent> = {}): HostKeyEvent =>
    ({ code, key: k, shift: false, ctrl: false, alt: false, ...mods });

  it('types lowercase when CAPS LOCK is up and SHIFT is not held', () => {
    expect(apple2eKeyByte(key('KeyA', 'a'), false)).toBe(0x61);
    expect(apple2eKeyByte(key('KeyA', 'A', { shift: true }), false)).toBe(0x41);
    expect(apple2eKeyByte(key('KeyA', 'a'), true)).toBe(0x41);          // caps lock down
  });

  it('types the host character for punctuation, whatever the layout', () => {
    expect(apple2eKeyByte(key('Digit2', '"', { shift: true }), true)).toBe(0x22);
    expect(apple2eKeyByte(key('Quote', '@', { shift: true }), true)).toBe(0x40);
    expect(apple2eKeyByte(key('Digit1', '1'), true)).toBe(0x31);
  });

  it('produces control codes and the cursor keys', () => {
    expect(apple2eKeyByte(key('KeyC', 'c', { ctrl: true }), true)).toBe(0x03);
    expect(apple2eKeyByte(key('Enter', 'Enter'), true)).toBe(0x0D);
    expect(apple2eKeyByte(key('ArrowRight', 'ArrowRight'), true)).toBe(0x15);
    expect(apple2eKeyByte(key('Delete', 'Delete'), true)).toBe(0x7F);
  });

  it('starts with CAPS LOCK down and toggles it with the host key', () => {
    const m = makeIie();
    try {
      m.keyboard.handleEvent(key('KeyA', 'a'), true);
      expect(rd(m, 0xC000)).toBe(0xC1);              // upper case
      m.keyboard.handleEvent(key('CapsLock', 'CapsLock'), true);
      m.keyboard.handleEvent(key('KeyB', 'b'), true);
      expect(rd(m, 0xC000)).toBe(0xE2);              // now lower case
    } finally { m.destroy(); }
  });

  it('reads the Apple keys and SHIFT as buttons 0-2', () => {
    const m = makeIie();
    try {
      expect(rd(m, 0xC061) & 0x80).toBe(0);
      m.keyboard.handleEvent(key('AltLeft', 'Alt'), true);
      m.keyboard.handleEvent(key('AltRight', 'Alt'), true);
      m.keyboard.handleEvent(key('ShiftLeft', 'Shift'), true);
      expect(rd(m, 0xC061) & 0x80).toBe(0x80);
      expect(rd(m, 0xC062) & 0x80).toBe(0x80);
      expect(rd(m, 0xC063) & 0x80).toBe(0x80);
      m.keyboard.handleEvent(key('AltLeft', 'Alt'), false);
      expect(rd(m, 0xC061) & 0x80).toBe(0);
    } finally { m.destroy(); }
  });
});

describe('apple //e character set', () => {
  /** A ROM whose glyph for code c has row 0 = c, stored the //e's way (bit0 = leftmost, lit = clear). */
  const font = (): Apple2eCharset => {
    const f = new Apple2eCharset();
    const rom = new Uint8Array(0x800);
    for (let c = 0; c < 256; c++) for (let r = 0; r < 8; r++) rom[c * 8 + r] = ~(c === 0x41 ? 0x01 : c === 0xC1 ? 0x01 : c === 0x61 ? 0x02 : c === 0xE1 ? 0x02 : 0) & 0x7F;
    f.load(rom);
    return f;
  };

  it('lights the dot a clear ROM bit selects, leftmost dot in bit 0', () => {
    const f = font();
    expect(f.glyph(0xC1, 0, false, false)).toBe(0x40);   // bit 0 -> leftmost = bit 6
    expect(f.glyph(0xE1, 0, false, true)).toBe(0x20);    // alternate set shows the lowercase shape
  });

  it('shows lowercase codes as upper case until the alternate set is selected', () => {
    const f = font();
    expect(f.glyph(0xE1, 0, false, false)).toBe(f.glyph(0xC1, 0, false, false));
    expect(f.glyph(0xE1, 0, false, true)).not.toBe(f.glyph(0xC1, 0, false, true));
  });

  it('flashes $40-$7F in the primary set only', () => {
    const f = font();
    const a = f.glyph(0x41, 0, true, false);
    const b = f.glyph(0x41, 0, false, false);
    expect(a ^ b).toBe(0x7F);                            // the two flash phases are complements
    expect(f.glyph(0x41, 0, true, true)).toBe(f.glyph(0x41, 0, false, true));   // no flashing in the alternate set
  });

  it('names the character each byte shows for OCR', () => {
    expect(apple2eChar(0xC1, false)).toBe('A');
    expect(apple2eChar(0xE1, false)).toBe('A');          // primary set: lowercase codes are capitals
    expect(apple2eChar(0xE1, true)).toBe('a');
    expect(apple2eChar(0x01, true)).toBe('A');           // inverse
    expect(apple2eChar(0xA0, false)).toBe(' ');
  });
});

describe('apple //e video: 80 columns and double hi-res', () => {
  const state = (m: Apple2Machine, mode: Apple2VideoMode, over: object = {}) => ({
    ram: m.mmu.ram, aux: m.mmu.aux, textMode: true, mixed: false, page2: false, hires: false,
    charset: m.charset, flashPhase: false, mode, col80: true, dhires: false, altCharset: false, ...over,
  });
  const pixel = (m: Apple2Machine, x: number, y: number): number[] => {
    const at = ((APPLE2_BORDER_TOP + y) * APPLE2_SCREEN_WIDTH + APPLE2_BORDER_LEFT + x) * 4;
    return [m.pixels[at], m.pixels[at + 1], m.pixels[at + 2]];
  };

  it('draws 80 columns across 560 pixels, even columns from auxiliary RAM', () => {
    const m = makeIie();
    try {
      // A font whose glyph $C1 is solid on row 0 and $C2 is blank.
      const rom = new Uint8Array(0x800).fill(0xFF);
      for (let r = 0; r < 8; r++) rom[0xC1 * 8 + r] = 0x00;
      m.charset.load(rom);
      m.mmu.aux[0x400] = 0xC1;       // column 0 (aux)
      m.mmu.ram[0x400] = 0xC2;       // column 1 (main): blank
      m.mmu.aux[0x401] = 0xC1;       // column 2 (aux)
      m.video.render(state(m, 'mono') as never);
      expect(pixel(m, 3, 0)[0]).toBe(0xFF);           // column 0 solid
      expect(pixel(m, 7 + 3, 0)[0]).toBe(0x00);       // column 1 blank
      expect(pixel(m, 14 + 3, 0)[0]).toBe(0xFF);      // column 2 solid
      expect(pixel(m, 559, 0)[0]).toBe(0x00);         // last column still blank
    } finally { m.destroy(); }
  });

  it('draws only 40 columns from main RAM when 80COL is off', () => {
    const m = makeIie();
    try {
      const rom = new Uint8Array(0x800).fill(0xFF);
      for (let r = 0; r < 8; r++) rom[0xC1 * 8 + r] = 0x00;
      m.charset.load(rom);
      m.mmu.aux[0x400] = 0xC1;       // would be column 0 in 80-column mode
      m.mmu.ram[0x400] = 0xC1;
      m.video.render(state(m, 'mono', { col80: false }) as never);
      expect(pixel(m, 13, 0)[0]).toBe(0xFF);          // 40-column cell is 14 pixels wide
      expect(pixel(m, 14, 0)[0]).toBe(0x00);
    } finally { m.destroy(); }
  });

  it('lays out double hi-res as auxiliary byte then main byte, bit 0 leftmost', () => {
    const m = makeIie();
    try {
      m.charset.load(new Uint8Array(0x800));
      const a = hiresRowBase('page1', 0);
      m.mmu.aux[a] = 0x01;           // dot 0
      m.mmu.ram[a] = 0x01;           // dot 7 (first dot of the main byte)
      m.video.render(state(m, 'mono', { textMode: false, hires: true, dhires: true }) as never);
      const lit = (x: number) => pixel(m, x, 0)[0] === 0xFF;
      expect([0, 1, 6, 7, 8].map(lit)).toEqual([true, false, false, true, false]);
    } finally { m.destroy(); }
  });

  it('renders a solid double hi-res colour from a repeating four-dot pattern', () => {
    // Dots "1100" repeated is the saturated colour a lit hi-res pixel alternating
    // with a dark one makes at 280 dots: violet in the first phase.
    const m = makeIie();
    try {
      m.charset.load(new Uint8Array(0x800));
      const a = hiresRowBase('page1', 0);
      for (let col = 0; col < 40; col++) {
        // 14 dots per column pair = 3.5 patterns, so alternate to stay in step.
        const even = col % 2 === 0;
        m.mmu.aux[a + col] = even ? 0x33 : 0x4C;   // dots 1100110 / 0011001 -> continues the pattern
        m.mmu.ram[a + col] = even ? 0x4C : 0x33;
      }
      m.video.render(state(m, 'ntsc', { textMode: false, hires: true, dhires: true }) as never);
      const [r, g, b] = pixel(m, 280, 0);
      expect(g, 'not grey').toBeLessThan(Math.min(r, b) - 20);   // violet: red and blue up, green down
    } finally { m.destroy(); }
  });

  it('reads 80-column text for OCR, interleaving auxiliary and main', () => {
    const m = makeIie();
    try {
      m.loadROM(makeRom());
      m.mmu.aux[0x400] = 0xC8; m.mmu.ram[0x400] = 0xC9;   // "HI" in columns 0, 1
      wr(m, 0xC00D, 0);                                    // 80COL on
      const r = ocrApple2Text({
        ram: m.mmu.ram, aux: m.mmu.aux, col80: true, altCharset: false, iie: true,
        page2: false, textRows: { first: 0, last: 23 },
      });
      expect(r.cols).toBe(80);
      expect(r.text.split('\n')[0].slice(0, 2)).toBe('HI');
      expect(textRowBase('page1', 0)).toBe(0x400);
    } finally { m.destroy(); }
  });
});
