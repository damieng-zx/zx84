/**
 * The Lynx's video: three one-bit planes composited under a 6845, in two
 * different shapes. The 48K runs 32 columns of eight pixels for a 256-wide
 * screen; the 128K runs 64, is 512 wide, and keeps its planes elsewhere with
 * its rows twice as far apart.
 */

import { describe, it, expect } from 'vitest';
import { Crtc6845 } from '@/cores/crtc-6845.ts';
import { LynxMemory } from '@/machines/lynx/lynx-memory.ts';
import { LynxVideo } from '@/machines/lynx/lynx-video.ts';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';
import { LYNX_PALETTE } from '@/machines/lynx/constants.ts';
import type { LynxModel } from '@/machines/lynx/models.ts';

/** Bytes between successive rasters of a plane, per board. */
const STRIDE = { lynx48: 32, lynx128: 64 } as const;

/** A 6845 programmed the way each Lynx ROM programs it. */
function crtcFor(model: LynxModel): Crtc6845 {
  const crtc = new Crtc6845(0);
  const set = (reg: number, val: number) => { crtc.selectRegister(reg); crtc.writeRegister(val); };
  const wide = model === 'lynx128';
  set(0, wide ? 95 : 47);      // horizontal total
  set(1, wide ? 64 : 32);      // characters displayed
  set(4, wide ? 70 : 77);      // vertical total
  set(5, wide ? 28 : 2);       // vertical adjust
  set(6, 63);                  // rows displayed
  set(7, 68);                  // VSYNC position
  set(9, 3);                   // rasters per row
  return crtc;
}

function build(model: LynxModel) {
  const memory = new LynxMemory(model);
  const crtc = crtcFor(model);
  return { memory, crtc, video: new LynxVideo(memory, crtc) };
}

/** The colour at (x, y) of the active area. */
function pixel(video: LynxVideo, x: number, y: number): number {
  const g = video.geometry;
  return video.pixels[(y + 24) * g.width + g.borderLeft + x];
}

/** Draw one whole frame's worth of scanlines. */
function frame(video: LynxVideo, crtc: Crtc6845): void {
  video.beginFrame();
  const lines = crtc.linesPerFrame();
  for (let i = 0; i < lines; i++) video.renderScanline();
}

describe('Lynx video', () => {
  it('gives the 48K a 256-wide screen and the 128K a 512-wide one', () => {
    expect(build('lynx48').video.geometry).toMatchObject({
      activeWidth: 256, width: 320, pixelAspectX: 1,
    });
    expect(build('lynx96').video.geometry.activeWidth).toBe(256);
    expect(build('lynx128').video.geometry).toMatchObject({
      activeWidth: 512, width: 640, pixelAspectX: 0.5,
    });
  });

  it('reports its own shape through the descriptor and the machine', () => {
    for (const model of ['lynx48', 'lynx96', 'lynx128'] as const) {
      const m = new LynxMachine(model, null);
      expect(m.frameWidth).toBe(m.descriptor.screen.width);
      expect(m.frameHeight).toBe(m.descriptor.screen.height);
      expect(m.pixels.length).toBe(m.frameWidth * m.frameHeight * 4);
    }
  });

  it.each(['lynx48', 'lynx128'] as const)(
    'composites %s red, green and blue into one of eight colours',
    model => {
      const { memory, crtc, video } = build(model);
      const { planes } = memory;
      // Top-left byte of each plane: red only, then green only, then all three.
      planes.red[0] = 0b10000000;
      planes.green[0] = 0b01000000;
      planes.blue[0] = 0b00100000;
      planes.red[1] = planes.green[1] = planes.blue[1] = 0xff;

      frame(video, crtc);

      expect(pixel(video, 0, 0)).toBe(LYNX_PALETTE[1]);   // red
      expect(pixel(video, 1, 0)).toBe(LYNX_PALETTE[2]);   // green
      expect(pixel(video, 2, 0)).toBe(LYNX_PALETTE[4]);   // blue
      expect(pixel(video, 3, 0)).toBe(LYNX_PALETTE[0]);   // nothing set
      expect(pixel(video, 8, 0)).toBe(LYNX_PALETTE[7]);   // white
    },
  );

  it.each(['lynx48', 'lynx128'] as const)('steps %s rows by its own stride', model => {
    const { memory, crtc, video } = build(model);
    memory.planes.green[STRIDE[model]] = 0xff;   // the second row of the green plane
    frame(video, crtc);
    expect(pixel(video, 0, 0)).toBe(LYNX_PALETTE[0]);
    expect(pixel(video, 0, 1)).toBe(LYNX_PALETTE[2]);
  });

  it('swaps in the alternate green plane on port 0x80 bit 4', () => {
    const { memory, crtc, video } = build('lynx48');
    memory.planes.green[0] = 0xff;
    memory.planes.altGreen[0] = 0x00;

    frame(video, crtc);
    expect(pixel(video, 0, 0)).toBe(LYNX_PALETTE[2]);

    video.altGreen = true;
    frame(video, crtc);
    expect(pixel(video, 0, 0)).toBe(LYNX_PALETTE[0]);
  });

  it('leaves the border black — the Lynx has no border colour to set', () => {
    const { memory, crtc, video } = build('lynx48');
    memory.planes.green.fill(0xff);
    frame(video, crtc);
    expect(video.pixels[0]).toBe(LYNX_PALETTE[0]);
    expect(pixel(video, -1, 0)).toBe(LYNX_PALETTE[0]);
    expect(pixel(video, 0, 0)).toBe(LYNX_PALETTE[2]);
  });
});
