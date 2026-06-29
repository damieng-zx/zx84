/**
 * Regression: the progressive (high/mid) renderer must draw display cell 0 when
 * a render chunk ends exactly on the left display edge.
 *
 * renderPendingScanlines advances nextDisplayCol by the Ferranti "+1" cell
 * offset (render the cell the beam is entering). When the beam lands precisely
 * on borderLeft, that yields colEnd=1 (draw col 0), but renderLineSegment used
 * to gate the draw on `xEnd > borderLeft` — strictly greater — so at xEnd ==
 * borderLeft it skipped col 0 while nextDisplayCol still advanced past it. Col 0
 * was then never drawn that frame and kept the previous frame's pixels: on a
 * FLASH cell at column 0 (e.g. the editing cursor at the bottom-left) this shows
 * as a single scanline with inverted flash bits. The HALT idle loop produces
 * exactly these borderLeft-aligned beam chunks, so it only bit in real time.
 */
import { describe, it, expect } from 'vitest';
import { Spectrum } from '@/spectrum.ts';
import { vramBitmapAddr, vramAttrAddr } from '@/cores/ula.ts';

function tagRom(): Uint8Array {
  const rom = new Uint8Array(64 * 1024);
  for (let p = 0; p < 4; p++) { rom[p * 16384] = 0xA0 + p; rom[p * 16384 + 1] = p; }
  return rom;
}

describe('progressive renderer — left-edge cell boundary', () => {
  it('draws display col 0 when a render chunk ends exactly on borderLeft', () => {
    const s = new Spectrum('48k', null);
    s.loadROM(tagRom());
    const ula = s.ula;

    // A solid white-ink cell at display line 0, column 0.
    s.memory.writeByte(vramBitmapAddr(0) + 0, 0xFF);
    s.memory.writeByte(vramAttrAddr(0, 0), 0x07); // ink 7 (white), paper 0 (black)
    ula.flashState = false;

    const px = new Uint32Array(ula.pixels.buffer);
    const idx = ula.borderTop * ula.screenWidth + ula.borderLeft; // line 0, col 0, pixel 0
    const SENTINEL = 0x12345678;
    px[idx] = SENTINEL;

    // A render chunk on display line 0 whose beam ends EXACTLY on the left
    // display edge, asking for cells [0, 1) — the +1-offset boundary case.
    (s as unknown as {
      renderLineSegment(i: number, xs: number, xe: number, cs: number, ce: number): void;
    }).renderLineSegment(ula.borderTop, ula.borderLeft - 8, ula.borderLeft, 0, 1);

    // Col 0 must have been drawn (white ink), not left as the previous frame's pixel.
    expect(px[idx]).toBe(ula.palette[7]);
    expect(px[idx]).not.toBe(SENTINEL);
  });
});
