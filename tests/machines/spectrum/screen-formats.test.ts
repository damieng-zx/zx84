/**
 * Timex and multicolour screen dumps: reading them, and saving them.
 *
 * Reading is a standalone decode; the emulator's ULA is the independent
 * reference it is held against in the round-trip tests below (a dump saved from
 * a machine must read back as exactly what the ULA drew).
 *
 * File layouts, from the formats' own descriptions (and checked against real
 * ZXDB files: a Uridium .mlt reads as legible text only with its attributes in
 * plain line order, and a hi-res .scr ends in the port 0xFF byte):
 *   .mlt 12288   bitmap (screen layout) + 6144 attributes, one per 8x1, in line order
 *   .scr 12288   bitmap + 6144 attributes laid out like the bitmap (Timex hi-colour)
 *   .scr 12289   screen 0 + screen 1 + port 0xFF; 512x192, columns alternating
 * The hi-res colour pairs are the Timex table: ink = the value, paper = its
 * complement, both bright.
 */

import { describe, it, expect } from 'vitest';
import { PALETTES, ULA, vramBitmapAddr } from '@/machines/spectrum/ula.ts';
import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { decodeExtendedScreen } from '@/machines/spectrum/screen-formats.ts';
import { spectrumDescriptor } from '@/machines/spectrum/descriptor.ts';

const pal = PALETTES.basic;
const rowOff = (y: number): number => vramBitmapAddr(y) - 0x4000;

/** ABGR pixel (x, y) of a decoded picture. */
function at(d: { width: number; pixels: Uint8Array }, x: number, y: number): number {
  return new Uint32Array(d.pixels.buffer, d.pixels.byteOffset, d.pixels.length >> 2)[y * d.width + x];
}

describe('reading a .mlt: an attribute per 8x1 line, in plain line order', () => {
  /** Bitmap with pixel 0 of lines 0 and 1 set; line attributes red-ink then green-ink. */
  function mlt(): Uint8Array {
    const d = new Uint8Array(12288);
    d[rowOff(0)] = 0x80;
    d[rowOff(1)] = 0x80;
    d[6144 + 0 * 32] = 0x02;      // line 0, column 0: ink red
    d[6144 + 1 * 32] = 0x04;      // line 1, column 0: ink green (32 bytes on, not 0x100)
    return d;
  }

  it('gives every line its own ink', () => {
    const d = decodeExtendedScreen(mlt(), 'mlt')!;
    expect(d.width).toBe(256);
    expect(d.height).toBe(192);
    expect(at(d, 0, 0)).toBe(pal[2]);
    expect(at(d, 0, 1)).toBe(pal[4]);
    expect(at(d, 1, 0)).toBe(pal[0]);     // paper black
  });

  it('is not the same bytes read as a .scr, whose attributes follow the bitmap\'s own layout', () => {
    const asScr = decodeExtendedScreen(mlt(), 'scr')!;
    expect(at(asScr, 0, 0)).toBe(pal[2]);             // line 0 is at offset 0 either way
    expect(at(asScr, 0, 1)).toBe(pal[0]);             // line 1's attribute would be 0x100 on, which is 0: black ink
  });
});

describe('reading a 12288-byte .scr: Timex hi-colour', () => {
  it('takes an attribute per 8x1 line from the second screen, laid out like the bitmap', () => {
    const d = new Uint8Array(12288);
    d[rowOff(1)] = 0x80;
    d[6144 + rowOff(1)] = 0x05;           // line 1: ink cyan
    d[6144 + 32] = 0x02;                  // where a .mlt would put it: must not be used
    const img = decodeExtendedScreen(d, 'scr')!;
    expect(img.width).toBe(256);
    expect(at(img, 0, 1)).toBe(pal[5]);
  });

  it('applies bright and paper like any attribute', () => {
    const d = new Uint8Array(12288);
    d[0] = 0x00;
    d[6144] = 0x7A;                       // bright, paper 7, ink 2
    const img = decodeExtendedScreen(d, 'scr')!;
    expect(at(img, 0, 0)).toBe(pal[7 + 8]);   // a clear pixel: bright white paper
  });
});

describe('reading a 12289-byte .scr: Timex hi-res', () => {
  /** Left byte 0xAA from screen 0, right byte 0xF0 from screen 1, then port 0xFF. */
  const hires = (dec: number): Uint8Array => {
    const d = new Uint8Array(12289);
    d[0] = 0xAA;
    d[6144] = 0xF0;
    d[12288] = dec;
    return d;
  };
  const row = (img: { width: number; pixels: Uint8Array }): number[] => Array.from({ length: 16 }, (_, x) => at(img, x, 0));

  it('is 512 wide, with the two screens\' bytes alternating along each line', () => {
    const img = decodeExtendedScreen(hires(0x36), 'scr')!;       // mode 6, colour 6
    expect(img.width).toBe(512);
    expect(img.height).toBe(192);
    const i = pal[6 + 8], p = pal[1 + 8];                         // yellow on blue
    expect(row(img)).toEqual([i, p, i, p, i, p, i, p, i, i, i, i, p, p, p, p]);
  });

  it('reads the colour from bits 3-5 of the last byte: the eight pairs', () => {
    for (let c = 0; c < 8; c++) {
      const img = decodeExtendedScreen(hires(0x06 | (c << 3)), 'scr')!;
      expect(at(img, 0, 0), `ink ${c}`).toBe(pal[c + 8]);
      expect(at(img, 1, 0), `paper ${c}`).toBe(pal[(7 - c) + 8]);
    }
  });

  it('is hi-res whatever mode the last byte names', () => {
    expect(decodeExtendedScreen(hires(0x00), 'scr')!.width).toBe(512);
    expect(decodeExtendedScreen(hires(0x3F), 'scr')!.width).toBe(512);
  });
});

describe('what is not an extended dump', () => {
  it('leaves standard sizes to the ordinary renderer', () => {
    for (const n of [6144, 6912, 6976, 12290]) {
      expect(decodeExtendedScreen(new Uint8Array(n), 'scr'), `${n}-byte .scr`).toBeNull();
    }
    expect(decodeExtendedScreen(new Uint8Array(6912), 'mlt')).toBeNull();
    expect(decodeExtendedScreen(new Uint8Array(12289), 'mlt')).toBeNull();     // only a .scr has the port byte
  });
});

// ── Saving ─────────────────────────────────────────────────────────────────

/** Fill a Spectrum's 16K display bank with deterministic noise. */
function fillDisplay(s: Spectrum, seed: number): void {
  let x = seed;
  for (let a = 0x4000; a < 0x8000; a++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    s.memory.writeByte(a, x >>> 16);
  }
}

/** What the ULA itself draws from a bank in a mode, with no border. */
function drawn(bank: Uint8Array, dec: number, perByte = false): { width: number; pixels: Uint8Array } {
  const ula = new ULA({ readHalfRows: () => 0xFF });
  ula.timexEnabled = !perByte;
  ula.attrPerByte = perByte;
  ula.setBorderMode(0);
  ula.setTimexVideo(dec);
  ula.renderFrame(bank, 0x4000);
  return { width: ula.screenWidth, pixels: ula.pixels.slice() };
}

const sameImage = (a: { width: number; pixels: Uint8Array }, b: { width: number; pixels: Uint8Array }): boolean =>
  a.width === b.width && a.pixels.length === b.pixels.length && a.pixels.every((v, i) => v === b.pixels[i]);

function tc2048(dec: number): Spectrum {
  const s = new Spectrum('tc2048', null);
  s.cpu.portOutHandler!(0x00FF, dec);
  fillDisplay(s, 0x5eed + dec);
  return s;
}

describe('saving a .scr from a Timex', () => {
  it('is 6912 bytes in the ordinary modes, from the screen on show', () => {
    const s0 = tc2048(0x00);
    const out0 = s0.screenExportBytes('scr')!;
    expect(out0).toHaveLength(6912);
    expect(Array.from(out0.subarray(0, 16))).toEqual(Array.from(s0.memory.screenBank.subarray(0, 16)));
    const s1 = tc2048(0x01);
    const out1 = s1.screenExportBytes('scr')!;
    expect(out1).toHaveLength(6912);
    expect(Array.from(out1.subarray(0, 16))).toEqual(Array.from(s1.memory.screenBank.subarray(0x2000, 0x2010)));
  });

  it('is 12288 bytes in hi-colour, and 12289 in hi-res with the mode and colour in the last byte', () => {
    expect(tc2048(0x02).screenExportBytes('scr')).toHaveLength(12288);
    for (const mode of [4, 5, 6, 7]) {
      const out = tc2048(mode | (3 << 3)).screenExportBytes('scr')!;
      expect(out, `mode ${mode}`).toHaveLength(12289);
      expect(out[12288], `mode ${mode} colour byte`).toBe(0x06 | (3 << 3));
    }
  });

  it('reads back as exactly the picture the ULA drew, in every mode', () => {
    for (let dec = 0; dec < 8; dec++) {
      for (const colour of dec >= 4 ? [0, 3, 5, 7] : [0]) {
        const s = tc2048(dec | (colour << 3));
        const bank = s.memory.screenBank.slice();
        const saved = s.screenExportBytes('scr')!;
        const direct = drawn(bank, dec | (colour << 3));
        const extended = decodeExtendedScreen(saved, 'scr');
        if (extended) {
          expect(sameImage(extended, direct), `mode ${dec} colour ${colour}`).toBe(true);
        } else {
          // A standard dump: it holds the bitmap and attributes the ULA drew from.
          const base = dec & 1 ? 0x2000 : 0;
          expect(Array.from(saved), `mode ${dec}`).toEqual(Array.from(bank.subarray(base, base + 6912)));
        }
      }
    }
  });
});

describe('saving a .mlt', () => {
  it('is 12288 bytes, and null in hi-res where there are no attributes', () => {
    expect(tc2048(0x00).screenExportBytes('mlt')).toHaveLength(12288);
    expect(tc2048(0x02).screenExportBytes('mlt')).toHaveLength(12288);
    for (const mode of [4, 5, 6, 7]) expect(tc2048(mode).screenExportBytes('mlt'), `mode ${mode}`).toBeNull();
  });

  it('writes a hi-colour screen\'s attributes in plain line order', () => {
    const s = tc2048(0x02);
    s.memory.writeByte(0x6000 + rowOff(1), 0x2A);     // line 1, column 0
    s.memory.writeByte(0x6000 + rowOff(9) + 5, 0x13); // line 9, column 5
    const mlt = s.screenExportBytes('mlt')!;
    expect(mlt[6144 + 1 * 32 + 0]).toBe(0x2A);
    expect(mlt[6144 + 9 * 32 + 5]).toBe(0x13);
  });

  it('gives an 8x8 attribute to each of its eight lines', () => {
    const s = tc2048(0x00);
    s.memory.writeByte(0x5800 + 2 * 32 + 7, 0x47);    // cell row 2, column 7
    const mlt = s.screenExportBytes('mlt')!;
    for (let line = 16; line < 24; line++) expect(mlt[6144 + line * 32 + 7], `line ${line}`).toBe(0x47);
    expect(mlt[6144 + 24 * 32 + 7]).not.toBe(0x47);
  });

  it('reads back as exactly the picture the ULA drew, in the ordinary and hi-colour modes', () => {
    for (const dec of [0x00, 0x01, 0x02, 0x03]) {
      const s = tc2048(dec);
      const direct = drawn(s.memory.screenBank.slice(), dec);
      const back = decodeExtendedScreen(s.screenExportBytes('mlt')!, 'mlt')!;
      expect(sameImage(back, direct), `mode ${dec}`).toBe(true);
    }
  });
});

describe('saving from a Pentagon 1024 in hardware multicolour', () => {
  function multicolour(): Spectrum {
    const s = new Spectrum('pentagon1024', null);
    s.ula.attrPerByte = true;
    fillDisplay(s, 0xBEEF);
    return s;
  }

  it('writes the .scr as 12288 bytes and the .mlt as 12288, and each reads back as the picture drawn', () => {
    const s = multicolour();
    const bank = s.memory.screenBank.slice();
    const direct = drawn(bank, 0, true);
    const scr = s.screenExportBytes('scr')!;
    expect(scr).toHaveLength(12288);
    expect(sameImage(decodeExtendedScreen(scr, 'scr')!, direct)).toBe(true);
    expect(sameImage(decodeExtendedScreen(s.screenExportBytes('mlt')!, 'mlt')!, direct)).toBe(true);
  });
});

describe('a plain Spectrum\'s saves are unchanged', () => {
  it('writes the 6912-byte .scr, and an .mlt of it with each cell\'s attribute on its eight lines', () => {
    const s = new Spectrum('zx48k', null);
    fillDisplay(s, 1);
    expect(s.screenExportBytes('scr')).toHaveLength(6912);
    expect(Array.from(s.screenExportBytes('scr')!)).toEqual(Array.from(s.memory.screenBank.subarray(0, 6912)));
    const mlt = s.screenExportBytes('mlt')!;
    expect(mlt).toHaveLength(12288);
    expect(mlt[6144 + 5 * 32 + 3]).toBe(s.memory.readByte(0x5800 + 0 * 32 + 3));
    expect(mlt[6144 + 8 * 32 + 3]).toBe(s.memory.readByte(0x5800 + 1 * 32 + 3));
  });
});

describe('the Save menu', () => {
  it('offers the multicolour screen only where the hardware has an attribute per 8x1 line', () => {
    for (const m of ['tc2048', 'pentagon1024'] as const) {
      expect(spectrumDescriptor(m).ui.saveMenu, m).toContain('screen-mlt');
    }
    for (const m of ['zx48k', 'zx128k', 'pentagon128', 'scorpion256'] as const) {
      expect(spectrumDescriptor(m).ui.saveMenu, m).not.toContain('screen-mlt');
    }
  });

  it('keeps every Spectrum\'s .scr, and leaves snapshots to the service', () => {
    // The menu holds only non-snapshot exports now; snapshot entries are built
    // from SnapshotService.formats() (see the save-service tests).
    expect(spectrumDescriptor('zx48k').ui.saveMenu).toEqual(['tape-tap', 'screenshot-png', 'screen-scr', 'ram-bin']);
    expect(spectrumDescriptor('pentagon1024').ui.saveMenu).toEqual(['tape-tap', 'screenshot-png', 'screen-scr', 'screen-mlt', 'ram-bin']);
  });
});
