/**
 * CPC horizontal display centring.
 *
 * A real CPC centres the active display on the monitor regardless of its width:
 * the standard 40-char display sits with equal left/right borders, and overscan
 * games (wider R1) pull the HSYNC position in so the wider display stays centred
 * rather than overflowing one side. The renderer models this by centring the
 * active area (hDisplayed chars × 16 px) in the 768-px framebuffer.
 *
 * Expectations are derived from that geometry, not the implementation:
 *   start = (768 − hDisplayed·16) / 2
 *   - 40 chars → 64  (== CPC_BORDER_LEFT; standard display is unchanged)
 *   - 48 chars → 0   (full-width overscan, centred — was clipped off the right
 *                     edge when anchored at a fixed 64, e.g. Crazy Cars II)
 *   - 32 chars → 128 (narrow display, centred)
 */

import { describe, it, expect } from 'vitest';
import { GateArray } from '@/machines/cpc/gate-array.ts';
import { Asic } from '@/machines/cpc/asic.ts';
import { CPC_SCREEN_WIDTH, CPC_SCREEN_HEIGHT, CPC_BORDER_LEFT, CPC_PALETTE } from '@/machines/cpc/constants.ts';

// Expose the protected render start for direct assertion.
class TestGateArray extends GateArray {
  startX(hDisplayed: number): number { return this.renderStartX(hDisplayed); }
}
class TestAsic extends Asic {
  startX(hDisplayed: number): number { return this.renderStartX(hDisplayed); }
}

describe('Gate Array — horizontal centring', () => {
  it('centres a standard 40-char display at CPC_BORDER_LEFT (unchanged)', () => {
    expect(new TestGateArray().startX(40)).toBe(CPC_BORDER_LEFT);   // 64
  });

  it('centres a 48-char overscan display at the left edge', () => {
    // 48·16 = 768 = full width → start 0, so nothing overflows the right edge.
    expect(new TestGateArray().startX(48)).toBe(0);
  });

  it('centres a 46-char display so both ends stay on screen', () => {
    // (768 − 46·16)/2 = (768 − 736)/2 = 16.
    expect(new TestGateArray().startX(46)).toBe(16);
  });

  it('centres a narrow 32-char display', () => {
    expect(new TestGateArray().startX(32)).toBe(128);
  });
});

describe('ASIC — horizontal centring composes with hscroll/extendBorder', () => {
  it('locked ASIC centres by width like the plain Gate Array', () => {
    const a = new TestAsic();            // locked at construction
    expect(a.startX(40)).toBe(64);
    expect(a.startX(48)).toBe(0);
  });

  it('soft scroll and border extend leave the display window where it is', () => {
    // CPCWiki "ASIC", SSCR: both act on the pixels inside the window.
    const a = new TestAsic();
    a.locked = false;
    a.hscroll = 5;
    a.extendBorder = true;
    expect(a.startX(40)).toBe(64);
  });
});

describe('ASIC soft scroll register (&6804) on the rendered line', () => {
  // CPCWiki "ASIC", SSCR: bits 3..0 delay the line by 0-15 mode-2 pixels, so
  // the image moves right and its last pixels are lost behind the right
  // border; bit 7 extends the border over the first 2 bytes (16 mode-2
  // pixels) of each line. Mode 2 here: byte 0x80 lights one pixel (pen 1) at
  // the left of each byte.
  const BORDER = 0xFF000001;
  const PEN0 = 0xFF000010;
  const PEN1 = 0xFF000020;

  function render(hscroll: number, extend: boolean, readVideo: (addr: number) => number): Uint32Array {
    const a = new Asic();
    a.locked = false;
    a.asicPalette[0] = PEN0;
    a.asicPalette[1] = PEN1;
    a.asicPalette[16] = BORDER;
    a.cpuWrite(0x2804, (extend ? 0x80 : 0) | hscroll);
    a.write(0x80 | 0x02);                 // RMR: mode 2
    a.onHSync();                          // latch the mode
    const px = new Uint32Array(CPC_SCREEN_WIDTH * CPC_SCREEN_HEIGHT);
    a.renderScanline(px, 0, { maRow: 0x3000, ra: 0, hDisplayed: 40, vDisplay: true }, readVideo);
    return px;
  }
  const firstByteOnly = (addr: number): number => (addr === 0xC000 ? 0x80 : 0x00);

  it('no scroll: the first pixel of the line is at the window start', () => {
    const px = render(0, false, firstByteOnly);
    expect(px[64]).toBe(PEN1);
    expect(px[65]).toBe(PEN0);
  });

  it('a delay of 5 moves that pixel 5 mode-2 pixels right', () => {
    const px = render(5, false, firstByteOnly);
    expect(px[64 + 5]).toBe(PEN1);
    expect(px[64]).toBe(PEN0);            // the gap holds data, not border
  });

  it("the delayed line's last pixels go behind the right border", () => {
    const px = render(5, false, () => 0xFF);
    expect(px[64 + 640 - 1]).toBe(PEN1);  // still the window's last pixel
    expect(px[64 + 640]).toBe(BORDER);    // nothing spills past the window
  });

  it('border extend covers the first 16 pixels of the line with the border colour', () => {
    const px = render(0, true, () => 0xFF);
    expect(px[64]).toBe(BORDER);
    expect(px[64 + 15]).toBe(BORDER);
    expect(px[64 + 16]).toBe(PEN1);
    expect(px[64 + 639]).toBe(PEN1);      // the right edge is unchanged
  });

  it('while locked the register has no effect', () => {
    const a = new Asic();
    a.cpuWrite(0x2804, 0x85);
    const px = new Uint32Array(CPC_SCREEN_WIDTH * CPC_SCREEN_HEIGHT);
    a.write(0x01);                        // pen 1 ...
    a.write(0x40 | 0x0A);                 // ... hardware colour 10 (border stays 0)
    a.write(0x80 | 0x02);
    a.onHSync();
    a.renderScanline(px, 0, { maRow: 0x3000, ra: 0, hDisplayed: 40, vDisplay: true }, firstByteOnly);
    expect(px[64]).not.toBe(px[0]);       // content, not border, at the window start
    expect(px[63]).toBe(px[0]);
  });
});

describe('Gate Array — overscan renders without clipping the right edge', () => {
  // Border pen (16) defaults to hardware colour 0; content pen 3 is set to
  // colour 10. In mode 1, display byte 0xFF paints every pixel as pen 3.
  const BORDER = CPC_PALETTE[0];
  const CONTENT = CPC_PALETTE[10];

  function renderRow0(hDisplayed: number): Uint32Array {
    const ga = new GateArray();
    ga.write(0x00 | 3);          // FN_PEN, select pen 3
    ga.write(0x40 | 0x0A);       // FN_COLOUR, hardware colour 10
    const px = new Uint32Array(CPC_SCREEN_WIDTH * CPC_SCREEN_HEIGHT);
    ga.renderScanline(px, 0, { maRow: 0x3000, ra: 0, hDisplayed, vDisplay: true }, () => 0xFF);
    return px;
  }

  it('a 48-char display fills the row edge-to-edge (no right-edge clip)', () => {
    const px = renderRow0(48);
    expect(px[0]).toBe(CONTENT);                       // content at the left edge
    expect(px[CPC_SCREEN_WIDTH - 1]).toBe(CONTENT);    // content at the right edge
  });

  it('a standard 40-char display keeps its left/right borders', () => {
    const px = renderRow0(40);
    expect(px[0]).toBe(BORDER);                        // left border intact
    expect(px[CPC_BORDER_LEFT]).toBe(CONTENT);         // content starts at 64
    expect(px[CPC_SCREEN_WIDTH - 1]).toBe(BORDER);     // right border intact
  });
});
