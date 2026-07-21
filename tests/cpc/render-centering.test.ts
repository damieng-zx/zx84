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

  it('unlocked hscroll shifts the centred base left by hscroll pixels', () => {
    const a = new TestAsic();
    a.locked = false;
    a.hscroll = 5;
    expect(a.startX(40)).toBe(64 - 5);   // 59
  });

  it('unlocked extendBorder shifts the centred base right by 16 pixels', () => {
    const a = new TestAsic();
    a.locked = false;
    a.extendBorder = true;
    expect(a.startX(40)).toBe(64 + 16);  // 80
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
