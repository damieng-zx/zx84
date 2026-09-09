/**
 * LynxVideo — three one-bit colour planes composited under a 6845.
 *
 * The Lynx has no video chip of its own. A Motorola 6845 sequences the raster
 * and the display circuitry fetches the same address from three separate
 * planes — red, green and blue — one bit per pixel each. The three bits index
 * eight colours, which is the whole palette. A fourth plane, "alt green", can
 * be swapped in for the green one by port 0x80 bit 4, so a program can flip
 * between two greens without moving any data.
 *
 * The 48K/96K and the 128K put their planes in different places and step the
 * address differently — the 128K's rows are twice as far apart, because its
 * video bank is 16K rather than 8K:
 *
 *   48K/96K   mem = ((ma << 2) + (ra << 5)) & 0x1fff
 *   128K      mem = ((ma << 2) + (ra << 6)) & 0x3fff
 *
 * Then one byte per character position, eight pixels to the byte, most
 * significant bit leftmost. Both forms are MAME's.
 */

import type { Crtc6845 } from '@/cores/crtc-6845.ts';
import {
  LYNX_ACTIVE_HEIGHT, LYNX_BORDER_TOP, LYNX_GEOMETRY_128, LYNX_GEOMETRY_48,
  LYNX_PALETTE, type LynxGeometry,
} from './constants.ts';
import type { LynxMemory } from './lynx-memory.ts';

/** Where the planes sit in the flat page array, per board. */
interface PlaneMap {
  readonly red: number;
  readonly blue: number;
  readonly green: number;
  readonly altGreen: number;
  /** Rasters step by this many bytes. */
  readonly rasterShift: number;
  /** The address wraps inside the video bank. */
  readonly mask: number;
}

const PLANES_48: PlaneMap = {
  red: 0x2c000, blue: 0x28000, green: 0x3c000, altGreen: 0x38000,
  rasterShift: 5, mask: 0x1fff,
};

const PLANES_128: PlaneMap = {
  red: 0x20000, blue: 0x24000, green: 0x28000, altGreen: 0x2c000,
  rasterShift: 6, mask: 0x3fff,
};

export class LynxVideo {
  /** The framebuffer's shape, which the 128K's wider display changes. */
  readonly geometry: LynxGeometry;
  /** ABGR framebuffer, border included. */
  readonly pixels: Uint32Array;

  /** Port 0x80 bit 4 — read the alternate green plane instead of the main one. */
  altGreen = false;

  private readonly planes: PlaneMap;
  /** How many displayed rows have been emitted this frame. The 6845 decides
   *  where the active region starts, so the border is whatever is left over
   *  rather than a fixed count of lines. */
  private drawn = 0;

  constructor(
    private readonly memory: LynxMemory,
    private readonly crtc: Crtc6845,
  ) {
    this.planes = memory.is128k ? PLANES_128 : PLANES_48;
    this.geometry = memory.is128k ? LYNX_GEOMETRY_128 : LYNX_GEOMETRY_48;
    this.pixels = new Uint32Array(this.geometry.width * this.geometry.height);
  }

  beginFrame(): void {
    this.drawn = 0;
    // The Lynx has no border colour register: the surround is simply black.
    this.pixels.fill(LYNX_PALETTE[0]);
    this.crtc.beginFrame();
  }

  /**
   * Draw one scanline from the 6845's current position, then advance it.
   * Called once per emulated scanline whether or not it is on screen, so the
   * CRTC's own row/raster counters stay in step with the CPU.
   */
  renderScanline(): void {
    const state = this.crtc.currentLine();

    if (state.vDisplay && this.drawn < LYNX_ACTIVE_HEIGHT) {
      const p = this.planes;
      const mem = ((state.maRow << 2) + (state.ra << p.rasterShift)) & p.mask;
      const green = this.altGreen ? p.altGreen : p.green;
      const ram = this.memory.ram;
      const geo = this.geometry;
      let out = (this.drawn + LYNX_BORDER_TOP) * geo.width + geo.borderLeft;
      const cells = Math.min(state.hDisplayed, geo.activeWidth >> 3);

      for (let cell = 0; cell < cells; cell++) {
        const at = (mem + cell) & p.mask;
        const r = ram[p.red + at];
        const b = ram[p.blue + at];
        const g = ram[green + at];
        for (let bit = 7; bit >= 0; bit--) {
          const m = 1 << bit;
          this.pixels[out++] = LYNX_PALETTE[
            (((b & m) !== 0 ? 1 : 0) << 2)
            | (((g & m) !== 0 ? 1 : 0) << 1)
            | ((r & m) !== 0 ? 1 : 0)
          ];
        }
      }
      this.drawn++;
    }

    this.crtc.advanceLine();
  }

  reset(): void {
    this.altGreen = false;
    this.drawn = 0;
    this.pixels.fill(LYNX_PALETTE[0]);
  }
}
