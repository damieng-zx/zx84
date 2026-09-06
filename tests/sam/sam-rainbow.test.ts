/**
 * The RAINBOW indicator's source count.
 *
 * `SamAsic.midLineWrites` answers one question for the status bar: did the
 * palette or the border change while the display was being drawn? Getting that
 * wrong is not subtle — the SAM ROM reloads its whole palette from the frame
 * interrupt every single frame, sixteen writes deep in vertical blanking, so
 * counting every register write leaves RAINBOW lit from boot to power-off.
 *
 * The other half matters too: the ROM's wallpaper changes a palette entry at
 * the START of each display line rather than part-way along it, and that IS a
 * rainbow — it is what draws the boot screen's colour bands. So the test is
 * "was the beam drawing", not "was the write past the left border".
 */

import { describe, expect, it } from 'vitest';
import { SamAsic } from '@/machines/sam/asic.ts';
import { SamMemory } from '@/machines/sam/sam-memory.ts';
import { createSamConfig } from '@/machines/sam/config.ts';
import {
  SAM_DISPLAY_FIRST_LINE, SAM_DISPLAY_LAST_LINE, SAM_LINES_PER_FRAME,
  SAM_T_PER_CELL, SAM_ASIC_CELL_OFFSET, SAM_DISPLAY_FIRST_CELL,
} from '@/machines/sam/constants.ts';

function asic(): SamAsic {
  return new SamAsic(new SamMemory(createSamConfig('sam512')));
}

/** T-state offset within a line that lands on raster cell `cell`. */
function atCell(cell: number): number {
  return (cell + SAM_ASIC_CELL_OFFSET) * SAM_T_PER_CELL;
}

describe('SamAsic.midLineWrites', () => {
  it('ignores the palette reload the ROM does in vertical blanking', () => {
    const a = asic();
    a.beginFrame();
    // Lines 293-294 are where the ROM's frame-interrupt handler runs.
    for (const line of [293, 294]) {
      a.beginLine(line, 0);
      for (let i = 0; i < 8; i++) a.writeClut(i, i * 3, atCell(SAM_DISPLAY_FIRST_CELL));
    }
    expect(a.midLineWrites).toBe(0);
  });

  it('counts a palette change on a line that is being drawn', () => {
    const a = asic();
    a.beginFrame();
    a.beginLine(SAM_DISPLAY_FIRST_LINE + 40, 0);
    a.writeClut(3, 0x7F, atCell(SAM_DISPLAY_FIRST_CELL + 10));
    expect(a.midLineWrites).toBe(1);
  });

  it('counts the wallpaper, which changes colour at each line start', () => {
    const a = asic();
    a.beginFrame();
    // One write per display line, at the far left — the ROM's boot-screen bands.
    for (let line = SAM_DISPLAY_FIRST_LINE; line < SAM_DISPLAY_FIRST_LINE + 16; line++) {
      a.beginLine(line, 0);
      a.writeClut(0, line & 0x7F, 0);
    }
    expect(a.midLineWrites).toBe(16);
  });

  it('counts a border split, not a border set during blanking', () => {
    const a = asic();
    a.beginFrame();
    a.beginLine(SAM_DISPLAY_LAST_LINE, 0);            // first blanked line
    a.writeBorder(2, false, atCell(SAM_DISPLAY_FIRST_CELL));
    expect(a.midLineWrites).toBe(0);

    a.beginLine(SAM_DISPLAY_LAST_LINE - 1, 0);        // last drawn line
    a.writeBorder(4, false, atCell(SAM_DISPLAY_FIRST_CELL));
    expect(a.midLineWrites).toBe(1);
  });

  it('starts each frame from zero', () => {
    const a = asic();
    a.beginFrame();
    a.beginLine(SAM_DISPLAY_FIRST_LINE, 0);
    a.writeClut(1, 0x40, 0);
    expect(a.midLineWrites).toBe(1);
    a.beginFrame();
    expect(a.midLineWrites).toBe(0);
  });

  it('stays at zero across a whole frame of nothing but blanking writes', () => {
    const a = asic();
    a.beginFrame();
    for (let line = 0; line < SAM_LINES_PER_FRAME; line++) {
      a.beginLine(line, 0);
      if (line >= SAM_DISPLAY_FIRST_LINE && line < SAM_DISPLAY_LAST_LINE) continue;
      a.writeClut(5, line & 0x7F, 0);
    }
    expect(a.midLineWrites).toBe(0);
  });
});
