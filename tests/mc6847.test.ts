/**
 * MC6847 VDG — the alphanumeric generator, semigraphics and the graphics mode
 * geometries, checked against the M6847 data sheet and the Atom Technical
 * Manual's character/semigraphic definitions.
 */

import { describe, expect, it } from 'vitest';
import {
  MC6847_FONT, Mc6847, MC6847_PIN_AS, MC6847_PIN_INTEXT, MC6847_PIN_INV,
  MC6847_HEIGHT, MC6847_WIDTH,
} from '@/cores/mc6847.ts';

function render(vdg: Mc6847, vram: Uint8Array): Uint32Array {
  const out = new Uint32Array(MC6847_WIDTH * MC6847_HEIGHT);
  vdg.render(vram, out, MC6847_WIDTH, 0, 0);
  return out;
}

const at = (out: Uint32Array, x: number, y: number): number => out[y * MC6847_WIDTH + x];

describe('mc6847', () => {
  it('has the 64-glyph, 12-row internal character generator', () => {
    expect(MC6847_FONT.length).toBe(64 * 12);
    // Code 1 is 'A'; its crossbar is the 5-pixel row 7 of the cell.
    expect(MC6847_FONT[1 * 12 + 7]).toBe(0x3e);
  });

  it('draws an alphanumeric character in the Atom code set', () => {
    const vdg = new Mc6847();
    vdg.dataPins = Mc6847.atomDataPins;
    vdg.palette[12] = 0xFF000000;     // black paper
    vdg.palette[13] = 0xFFFFFFFF;     // green ink
    const vram = new Uint8Array(0x1800);
    vram[0] = 0x01;                   // 'A'
    const out = render(vdg, vram);
    expect(at(out, 4, 0)).toBe(0xFF000000);   // blank top row
    expect(at(out, 4, 3)).toBe(0xFFFFFFFF);   // apex of the A
    expect(at(out, 2, 7)).toBe(0xFFFFFFFF);   // left end of the crossbar
    expect(at(out, 6, 7)).toBe(0xFFFFFFFF);   // right end of the crossbar
    expect(at(out, 0, 7)).toBe(0xFF000000);
  });

  it('inverts the character when bit 7 is set', () => {
    const vdg = new Mc6847();
    vdg.dataPins = Mc6847.atomDataPins;
    vdg.palette[12] = 0xFF000000;
    vdg.palette[13] = 0xFFFFFFFF;
    const vram = new Uint8Array(0x1800);
    vram[0] = 0x81;                   // inverse 'A'
    const out = render(vdg, vram);
    expect(at(out, 4, 3)).toBe(0xFF000000);   // the apex is paper
    expect(at(out, 0, 0)).toBe(0xFFFFFFFF);   // the blank row is ink
  });

  it('uses the orange pen with CSS when the colour set flips', () => {
    const vdg = new Mc6847();
    vdg.dataPins = Mc6847.atomDataPins;
    vdg.css = true;
    vdg.palette[14] = 0xFF000000;
    vdg.palette[15] = 0xFFFF00FF;
    const vram = new Uint8Array(0x1800);
    vram[0] = 0x01;
    const out = render(vdg, vram);
    expect(at(out, 4, 3)).toBe(0xFFFF00FF);
    expect(at(out, 0, 0)).toBe(0xFF000000);
  });

  it('draws semigraphics 6 as a 2x3 block grid, colour from bits 6-7', () => {
    const vdg = new Mc6847();
    vdg.dataPins = Mc6847.atomDataPins;
    const vram = new Uint8Array(0x1800);
    vram[0] = 0x41;                   // bit 6 set: SG6, block bit 0, colour 1
    const out = render(vdg, vram);
    // Bit 0 lights the bottom-right block (x 4-7, y 8-11).
    expect(at(out, 5, 10)).toBe(vdg.palette[1]);
    expect(at(out, 0, 10)).toBe(vdg.palette[8]);
    expect(at(out, 5, 0)).toBe(vdg.palette[8]);
  });

  it('draws 64x64 four-colour graphics with four screen pixels per dot', () => {
    const vdg = new Mc6847();
    vdg.ag = true;
    const vram = new Uint8Array(0x1800);
    vram[0] = 0xC0;                   // top dot = 3 (red), the other three = 0
    const out = render(vdg, vram);
    expect(at(out, 0, 0)).toBe(vdg.palette[3]);
    expect(at(out, 3, 0)).toBe(vdg.palette[3]);
    expect(at(out, 4, 0)).toBe(vdg.palette[0]);
    expect(at(out, 7, 0)).toBe(vdg.palette[0]);
    // The first row is repeated for three scanlines.
    expect(at(out, 0, 2)).toBe(vdg.palette[3]);
  });

  it('draws 256x192 two-colour graphics one screen pixel per dot', () => {
    const vdg = new Mc6847();
    vdg.ag = true;
    vdg.gm0 = vdg.gm1 = vdg.gm2 = true;
    const vram = new Uint8Array(0x1800);
    vram[0] = 0x80;                   // first dot ink, the rest paper
    const out = render(vdg, vram);
    expect(at(out, 0, 0)).toBe(vdg.palette[9]);
    expect(at(out, 1, 0)).toBe(vdg.palette[8]);
    expect(vdg.bytesPerRow).toBe(32);
    expect(vdg.linesPerRow).toBe(1);
    expect(vdg.pixelsWide).toBe(256);
  });

  it('names the graphics mode and reports the fetch geometry', () => {
    const vdg = new Mc6847();
    expect(vdg.modeName).toBe('text 32x16');
    vdg.ag = true; vdg.gm1 = true;
    expect(vdg.modeName).toBe('128x64 4-colour');
    expect(vdg.bytesPerRow).toBe(32);
    expect(vdg.linesPerRow).toBe(3);
    vdg.gm2 = true;
    expect(vdg.modeName).toBe('128x192 4-colour');
    expect(vdg.bytesPerRow).toBe(32);
    expect(vdg.linesPerRow).toBe(1);
  });

  it('accepts global character pins when no data-pin callback is wired', () => {
    const vdg = new Mc6847();
    vdg.as = true;
    vdg.intext = false;
    vdg.inv = false;
    const vram = new Uint8Array(0x1800);
    vram[0] = 0x0F;                   // SG4 with all four blocks
    const out = render(vdg, vram);
    expect(out.some((c) => c === vdg.palette[(0x0F >> 4) & 7])).toBe(true);
  });

  it('round-trips its mode pins through a snapshot section', () => {
    const vdg = new Mc6847();
    vdg.ag = true; vdg.gm0 = true; vdg.css = true; vdg.inv = true;
    const bytes: number[] = [];
    vdg.saveState({ bool: (v: boolean) => bytes.push(v ? 1 : 0) } as never);
    const restored = new Mc6847();
    let at = 0;
    restored.loadState({ bool: () => bytes[at++] !== 0 } as never);
    expect(restored.ag).toBe(true);
    expect(restored.gm0).toBe(true);
    expect(restored.css).toBe(true);
    expect(restored.inv).toBe(true);
    expect(restored.gm1).toBe(false);
  });

  it('exports the pin bits it documents', () => {
    expect(MC6847_PIN_AS | MC6847_PIN_INTEXT | MC6847_PIN_INV).toBe(7);
    expect(Mc6847.atomDataPins(0x00)).toBe(0);
    expect(Mc6847.atomDataPins(0x40)).toBe(MC6847_PIN_AS | MC6847_PIN_INTEXT);
    expect(Mc6847.atomDataPins(0x80)).toBe(MC6847_PIN_INV);
  });
});
