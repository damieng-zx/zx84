/**
 * BBC Micro Mode 7 text OCR.
 *
 * Mode 7 stores the SAA5050 display bytes directly, so transcription is a read
 * of the 40×25 field — these tests pin the code mapping (control/alpha/mosaic,
 * the flash bit), the overlay result shape, the framebuffer blanking and the
 * frame-probe wiring.
 */
import { describe, expect, it } from 'vitest';
import { BbcMachine } from '@/machines/bbc/bbc-machine.ts';
import {
  BbcScreenText, BBC_MODE7_COLS, BBC_MODE7_ROWS,
  BBC_MODE7_ORIGIN_X, BBC_MODE7_ORIGIN_Y,
} from '@/ocr/bbc.ts';
import {
  BBC_BORDER_LEFT, BBC_BORDER_TOP, BBC_SCREEN_WIDTH,
} from '@/machines/bbc/constants.ts';

/** Byte offset of active-picture pixel (x, y) in the bordered frame buffer. */
const at = (x: number, y: number): number =>
  ((y + BBC_BORDER_TOP) * BBC_SCREEN_WIDTH + x + BBC_BORDER_LEFT) * 4;

const DISPLAY_START = 0x7C00;
/** For MA 0x7C00 the teletext translation is the identity. */
const BASE = DISPLAY_START;

function makeMode7(): BbcMachine {
  const m = new BbcMachine('bbc-b', null);
  m.videoUlaControl = 0x02;              // teletext select
  m.crtc.regs[1] = BBC_MODE7_COLS;       // 40 MA units per row
  m.crtc.regs[12] = DISPLAY_START >> 8;
  m.crtc.regs[13] = DISPLAY_START & 0xFF;
  m.memory.ram.fill(0x20, BASE, BASE + BBC_MODE7_COLS * BBC_MODE7_ROWS);
  return m;
}

/** Write text at teletext cell (row, col). */
function put(m: BbcMachine, row: number, col: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    m.memory.ram[BASE + row * BBC_MODE7_COLS + col + i] = text.charCodeAt(i);
  }
}

const input = (m: BbcMachine) => ({
  ram: m.memory.ram,
  displayStart: m.crtc.displayStart,
  stride: m.crtc.regs[1],
  palette: m.video.activePalette(),
});

describe('BbcScreenText.ocr', () => {
  it('reads the teletext field back as text', () => {
    const m = makeMode7();
    try {
      put(m, 0, 0, 'BBC BASIC');
      expect(new BbcScreenText().ocr(input(m))).toBe('BBC BASIC');
    } finally {
      m.destroy();
    }
  });

  it('drops the flash bit (bit 7) so a flashing glyph still reads', () => {
    const m = makeMode7();
    try {
      // 0x41 'A' with the flash bit set reads as 'A'.
      m.memory.ram[BASE] = 0x41 | 0x80;
      expect(new BbcScreenText().ocr(input(m))).toBe('A');
    } finally {
      m.destroy();
    }
  });

  it('renders control codes (0x00-0x1F) as blank cells', () => {
    const m = makeMode7();
    try {
      // 0x01 is "red alpha" — it colors the rest of the field but draws nothing,
      // so it reads as a blank cell in column 0.
      m.memory.ram[BASE] = 0x01;
      m.memory.ram[BASE + 1] = 0x41;
      expect(new BbcScreenText().ocr(input(m))).toBe(' A');
    } finally {
      m.destroy();
    }
  });

  it('blanks a mosaic cell once the graphics control code is active', () => {
    const m = makeMode7();
    try {
      // 0x09 selects graphics; the following 'A' byte draws a mosaic, not text.
      m.memory.ram[BASE] = 0x09;
      m.memory.ram[BASE + 1] = 0x41;
      expect(new BbcScreenText().ocr(input(m))).toBe('');
    } finally {
      m.destroy();
    }
  });
});

describe('BbcMachine Mode 7 OCR wiring', () => {
  it('exposes screen text through ocrScreenForMcp', () => {
    const m = makeMode7();
    try {
      put(m, 2, 5, 'Ready');
      // Leading blank rows and the row's left margin are preserved; only
      // trailing blanks are trimmed (as the other machines' ocr() does).
      expect(m.ocrScreenForMcp()).toBe('\n\n     Ready');
    } finally {
      m.destroy();
    }
  });

  it('reports an empty screen for the bitmap modes', () => {
    const m = makeMode7();
    try {
      put(m, 0, 0, 'ABCDE');
      m.videoUlaControl = 0x18;          // mode 1 (bitmap)
      expect(m.ocrScreenForMcp()).toBe('');
      expect(m.ocrScreenStyled().mask).toHaveLength(0);
    } finally {
      m.destroy();
    }
  });

  it('masks recognised cells and reports their paper pen', () => {
    const m = makeMode7();
    try {
      put(m, 0, 0, 'A');
      const result = m.ocrScreenStyled();
      expect(result.grid).toBe('40x25');
      expect(result.cols).toBe(40);
      expect(result.rows).toBe(25);
      expect(result.mask[0]).toBe(true);         // 'A'
      expect(result.mask[1]).toBe(false);        // the space beside it
      expect(result.paper?.[0]).toBe(0);         // black paper
      expect(result.html.startsWith('<span style="color:#ffffff">A</span>')).toBe(true);
    } finally {
      m.destroy();
    }
  });

  it('blanks matched cells to their paper colour in the framebuffer', () => {
    const m = makeMode7();
    try {
      put(m, 0, 0, 'A');
      const result = m.ocrScreenStyled();
      m.pixels.fill(0xFF);                        // paint the whole buffer white
      m.blankCells(result.mask, result.cols, result.rows, result.paper);
      const px = at(BBC_MODE7_ORIGIN_X, BBC_MODE7_ORIGIN_Y);
      expect([m.pixels[px], m.pixels[px + 1], m.pixels[px + 2], m.pixels[px + 3]])
        .toEqual([0, 0, 0, 255]);                 // black, per paper pen 0
      const next = at(BBC_MODE7_ORIGIN_X + 12, BBC_MODE7_ORIGIN_Y);
      expect(m.pixels[next]).toBe(0xFF);          // the space cell is untouched
    } finally {
      m.destroy();
    }
  });
});

describe('BbcFrameProbe transcribe driver', () => {
  it('runs the overlay and anchors it to the teletext window', () => {
    const m = makeMode7();
    try {
      put(m, 0, 0, 'HELLO');
      const transcribe = m.services.probe.transcribe;
      expect(transcribe.active).toBe(false);
      transcribe.activate();
      expect(transcribe.active).toBe(true);
      const result = transcribe.run();
      expect(result.grid).toBe('40x25');
      expect(result.text.split('\n')[0].startsWith('HELLO')).toBe(true);
      // The 480×500 teletext box centred in the 640×512 picture, inside the border.
      expect(result.field).toEqual({
        x: BBC_BORDER_LEFT + 80, y: BBC_BORDER_TOP + 6, width: 480, height: 500,
      });
      transcribe.deactivate();
      expect(transcribe.active).toBe(false);
    } finally {
      m.destroy();
    }
  });

  it('lists the BASIC program through the panes provider', () => {
    const m = makeMode7();
    try {
      // 10 PRINT 1, laid at PAGE 0x0E00 with its leading 0x0D and &FF terminator.
      m.memory.ram[0x18] = 0x0E;
      m.memory.ram.set([0x0D, 0x00, 0x0A, 0x07, 0xF1, 0x20, 0x31, 0x0D, 0xFF], 0x0E00);
      expect(m.services.probe.panes?.basicListing?.())
        .toEqual([{ lineNumber: 10, text: 'PRINT 1' }]);
    } finally {
      m.destroy();
    }
  });
});
describe('BBC bitmap-mode OCR', () => {
  /** An 'H' as the MOS draws it (MSB = leftmost pixel). */
  const GLYPH_H = [0x66, 0x66, 0x66, 0x7E, 0x66, 0x66, 0x66, 0x00];

  /** Mode 4 (1bpp, 40 columns) at 0x5800 with a font holding only 'H'. */
  function makeBitmap(): BbcMachine {
    const m = new BbcMachine('bbc-b', null);
    m.videoUlaControl = 0x88;       // low clock, 40 cols -> mode 4
    m.crtc.regs[1] = 40;
    m.crtc.regs[6] = 32;
    m.crtc.regs[9] = 7;
    m.crtc.regs[12] = 0x0B;         // 0xB00 << 3 = 0x5800
    m.crtc.regs[13] = 0x00;
    m.palette[0] = 0;
    m.palette[1] = 7;
    m.memory.osRom.fill(0, 0, 768);
    m.memory.osRom.set(GLYPH_H, ('H'.charCodeAt(0) - 32) * 8);
    return m;
  }

  it('matches a cell against the MOS font', () => {
    const m = makeBitmap();
    try {
      m.memory.ram.set(GLYPH_H, 0x5800);            // cell (0,0): 8 bytes, one per scanline
      const r = m.ocrScreenStyled();
      expect(r.cols).toBe(40);
      expect(r.rows).toBe(32);
      expect(r.text.startsWith('H ')).toBe(true);
      expect(r.mask[0]).toBe(true);
      expect(r.mask[1]).toBe(false);
    } finally {
      m.destroy();
    }
  });

  it('reads inverse video (ink and paper swapped)', () => {
    const m = makeBitmap();
    try {
      m.memory.ram.set(GLYPH_H.map(b => b ^ 0xFF), 0x5808);   // cell (1,0), inverted
      const r = m.ocrScreenStyled();
      expect(r.text[1]).toBe('H');
      expect(r.paper?.[1]).toBe(7);                  // white paper (logical 1)
    } finally {
      m.destroy();
    }
  });

  it('decodes a 2bpp cell across its two interleaved bytes', () => {
    const m = makeBitmap();
    try {
      m.videoUlaControl = 0x18;       // high clock, 40 cols -> mode 1 (2bpp, 40 chars)
      m.crtc.regs[1] = 80;            // 80 display bytes per scanline row
      // Draw 'H' in logical colour 2 (high bit only): for the left 4 pixels the
      // high bits are the byte's top nibble, so each glyph nibble goes there.
      for (let ra = 0; ra < 8; ra++) {
        m.memory.ram[0x5800 + ra] = GLYPH_H[ra] & 0xF0;          // pixels 0-3
        m.memory.ram[0x5808 + ra] = (GLYPH_H[ra] << 4) & 0xF0;   // pixels 4-7
      }
      const r = m.ocrScreenStyled();
      expect(r.cols).toBe(40);
      expect(r.text[0]).toBe('H');
    } finally {
      m.destroy();
    }
  });

  it('anchors the overlay to the bitmap rows inside the border', () => {
    const m = makeBitmap();
    try {
      m.memory.ram.set(GLYPH_H, 0x5800);
      const result = m.services.probe.transcribe.run();
      expect(result.grid).toBe('40x32');
      // 32 rows of 8 doubled scanlines fill the whole 640×512 picture.
      expect(result.field).toEqual({
        x: BBC_BORDER_LEFT, y: BBC_BORDER_TOP, width: 640, height: 512,
      });
    } finally {
      m.destroy();
    }
  });
});
