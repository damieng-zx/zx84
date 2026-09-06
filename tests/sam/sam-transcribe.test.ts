/**
 * The SAM's TEXT overlay.
 *
 * The plain transcription is covered in `sam-ocr.test.ts`; this is about the
 * three things the overlay adds on top, each of which is a way the feature can
 * be wired up and still look broken:
 *
 *  - the driver has to EXIST on the frame probe at all — the descriptor lists
 *    the TEXT indicator, and clicking it is what turns the overlay on, so a
 *    missing driver is a button that does nothing;
 *  - transcribed cells are blanked out of the frame buffer, or the overlay's
 *    text sits on top of the pixels it duplicates;
 *  - the font is followed through CHARS rather than assumed at its power-on
 *    address, so a program that repoints the character set still transcribes.
 */

import { describe, expect, it } from 'vitest';
import { SamMachine } from '@/machines/sam/sam-machine.ts';
import { SAM_BORDER_LEFT, SAM_BORDER_TOP, SAM_SCREEN_WIDTH } from '@/machines/sam/constants.ts';
import { SAM_CHARS_ADDR, SAM_SYSVAR_PAGE, SAM_SYSVAR_WINDOW } from '@/machines/sam/sysvars.ts';
import { SAM_FONT_OFFSET } from '@/ocr/sam.ts';

const CELL_H = 8;
const ROW_PITCH = 9;

/** A toy font: a distinct, recognisable bitmap per printable ASCII code. */
function toyFont(): Uint8Array {
  const font = new Uint8Array(128 * CELL_H);
  for (let c = 33; c < 127; c++) {
    for (let r = 0; r < CELL_H; r++) font[c * CELL_H + r] = ((c * 7 + r * 31) & 0xFE) | 1;
  }
  return font;
}

/** A SAM in mode 4 with a font in place and `text` stamped on its screen. */
function samShowing(text: string, opts: { fontOffset?: number } = {}) {
  const m = new SamMachine('sam512', null);
  const fontOffset = opts.fontOffset ?? SAM_FONT_OFFSET;
  const sysvars = m.memory.getRamBank(SAM_SYSVAR_PAGE);
  sysvars.set(toyFont(), fontOffset);
  // CHARS points 256 bytes below CHR$ 0, in the system page's 0x4000 window.
  const chars = SAM_SYSVAR_WINDOW + fontOffset;
  sysvars[SAM_CHARS_ADDR - SAM_SYSVAR_WINDOW] = chars & 0xFF;
  sysvars[SAM_CHARS_ADDR - SAM_SYSVAR_WINDOW + 1] = chars >> 8;

  // Mode 4, display in pages 2/3 (VMPR: mode 3 in bits 6-5 is "mode 4").
  m.memory.setVmpr((3 << 5) | 2);
  const pageA = m.memory.videoPage(m.memory.videoBasePage);
  const pageB = m.memory.videoPage(m.memory.videoBasePage + 1);
  const poke = (off: number, v: number) => {
    if (off < 0x4000) pageA[off] = v; else pageB[off - 0x4000] = v;
  };
  const putPixel = (x: number, y: number, index: number) => {
    const off = (y << 7) + (x >> 1);
    const cur = off < 0x4000 ? pageA[off] : pageB[off - 0x4000];
    poke(off, (x & 1) ? ((cur & 0xF0) | (index & 0x0F)) : ((cur & 0x0F) | ((index & 0x0F) << 4)));
  };

  const font = toyFont();
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    for (let r = 0; r < CELL_H; r++) {
      const bits = font[code * CELL_H + r];
      for (let b = 0; b < 8; b++) if (bits & (0x80 >> b)) putPixel(i * 8 + b, r, 15);
    }
  }
  return m;
}

describe('SAM TEXT overlay', () => {
  it('is offered by the frame probe, since the descriptor lists the indicator', () => {
    const m = new SamMachine('sam256', null);
    try {
      expect(m.descriptor.ui.statusLeds).toContain('text');
      expect(m.services.probe.transcribe).toBeDefined();
    } finally {
      m.destroy();
    }
  });

  it('transcribes the screen and labels the grid by screen mode', () => {
    const m = samShowing('HELLO');
    try {
      const r = m.services.probe.transcribe.run();
      expect(r.grid).toBe('32x21');
      expect(r.text.split('\n')[0]).toBe('HELLO');
    } finally {
      m.destroy();
    }
  });

  it('wraps each run of same-coloured text in one span', () => {
    const m = samShowing('HI');
    try {
      const html = m.services.probe.transcribe.run().html;
      expect(html).toContain('<span style="color:');
      expect(html).toContain('HI');
      // One span for the run, not one per character.
      expect(html.match(/<span/g)!.length).toBe(1);
    } finally {
      m.destroy();
    }
  });

  it('blanks the cells it transcribed out of the frame buffer', () => {
    const m = samShowing('A');
    try {
      // Ink and paper must resolve to different colours, or "blanked" and
      // "as drawn" look identical and the test proves nothing.
      m.asic.writeClut(0, 0x00, 0);
      m.asic.writeClut(15, 0x7F, 0);
      // Render the field so there are real pixels under the overlay.
      m.tick();
      const px = new Uint32Array(m.pixels.buffer);
      const inCell = (x: number, y: number) => px[(SAM_BORDER_TOP + y) * SAM_SCREEN_WIDTH + SAM_BORDER_LEFT + x];
      const before = new Set<number>();
      for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) before.add(inCell(x, y));
      expect(before.size).toBeGreaterThan(1);   // ink and paper both present

      m.services.probe.transcribe.run();

      const after = new Set<number>();
      for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) after.add(inCell(x, y));
      expect(after.size).toBe(1);               // one flat paper colour
    } finally {
      m.destroy();
    }
  });

  it('follows CHARS when a program repoints the character set', () => {
    const moved = 0x2000;
    expect(moved).not.toBe(SAM_FONT_OFFSET);
    const m = samShowing('OK', { fontOffset: moved });
    try {
      expect(m.services.probe.transcribe.run().text.split('\n')[0]).toBe('OK');
    } finally {
      m.destroy();
    }
  });

  it('reports its own unavailability rather than emitting nonsense', () => {
    // No font anywhere: CHARS still reads 0, so nothing matches.
    const m = new SamMachine('sam256', null);
    try {
      expect(m.ocrScreenForMcp()).toContain('OCR unavailable');
      expect(m.ocrScreenStyled().cells).toBeNull();
      expect(m.services.probe.transcribe.run().text).toBe('');
    } finally {
      m.destroy();
    }
  });

  it('places a row at its own pixel position, not at the next free line', () => {
    const m = samShowing('X');
    try {
      // Stamp a second row three text rows down; the blank rows between must
      // survive into the overlay so the text lines up with the picture.
      const font = toyFont();
      const pageA = m.memory.videoPage(m.memory.videoBasePage);
      for (let r = 0; r < CELL_H; r++) {
        const bits = font['Y'.charCodeAt(0) * CELL_H + r];
        for (let b = 0; b < 8; b++) {
          if (!(bits & (0x80 >> b))) continue;
          const x = b, y = 3 * ROW_PITCH + r;
          const off = (y << 7) + (x >> 1);
          pageA[off] = (x & 1) ? ((pageA[off] & 0xF0) | 15) : ((pageA[off] & 0x0F) | 0xF0);
        }
      }
      const lines = m.services.probe.transcribe.run().text.split('\n');
      expect(lines[0]).toBe('X');
      expect(lines[1]).toBe('');
      expect(lines[2]).toBe('');
      expect(lines[3]).toBe('Y');
    } finally {
      m.destroy();
    }
  });
});
