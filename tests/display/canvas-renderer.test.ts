/**
 * canvas-renderer.ts — 2D nearest-neighbor renderer.
 *
 * Node doesn't have <canvas>, so we install a minimal stub. The renderer
 * exercised here is small; tests focus on:
 *   - constructor wires offscreen + main contexts and seeds ImageData
 *   - applyScale() honours both `scale` and `devicePixelRatio`, and
 *     keeps `imageSmoothingEnabled = false` so nearest-neighbor sticks
 *   - updateTexture() blits via the offscreen + scaled drawImage
 *   - resize() reallocates imageData (otherwise old pixel buffer leaks
 *     into a smaller window or overflows a larger one)
 *   - the CRT-style setters really are no-ops (they exist only to satisfy
 *     IScreenRenderer for the canvas backend)
 *   - constructor throws when 2D context is unavailable
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Stubs ────────────────────────────────────────────────────────────────

interface DrawCall {
  src: any;
  sx: number; sy: number; sw: number; sh: number;
  dx: number; dy: number; dw: number; dh: number;
}

class StubImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
    this.data = new Uint8ClampedArray(w * h * 4);
  }
}

class StubCtx2D {
  imageSmoothingEnabled = true;
  draws: DrawCall[] = [];
  puts: { data: StubImageData; x: number; y: number }[] = [];
  createImageData(w: number, h: number): StubImageData { return new StubImageData(w, h); }
  putImageData(data: StubImageData, x: number, y: number): void {
    this.puts.push({ data, x, y });
  }
  drawImage(src: any, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void {
    this.draws.push({ src, sx, sy, sw, sh, dx, dy, dw, dh });
  }
}

class StubCanvas {
  width = 300;
  height = 150;
  style: Record<string, string> = {};
  contextReturn: StubCtx2D | null;
  lastContextOptions: any = null;
  constructor(contextReturn: StubCtx2D | null = new StubCtx2D()) {
    this.contextReturn = contextReturn;
  }
  getContext(_kind: string, opts?: any): StubCtx2D | null {
    this.lastContextOptions = opts;
    return this.contextReturn;
  }
}

function installDom(dpr: number, makeOffscreen: () => StubCanvas = () => new StubCanvas()): { restore: () => void } {
  const prevDoc = (globalThis as any).document;
  const prevWin = (globalThis as any).window;
  (globalThis as any).document = {
    createElement(tag: string) {
      if (tag === 'canvas') return makeOffscreen();
      throw new Error(`unexpected createElement ${tag}`);
    },
  };
  (globalThis as any).window = { devicePixelRatio: dpr };
  return {
    restore() {
      (globalThis as any).document = prevDoc;
      (globalThis as any).window = prevWin;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

import { CanvasRenderer } from '@/display/canvas-renderer.ts';

let dom: { restore: () => void };
beforeEach(() => { dom = installDom(1); });
afterEach(() => { dom.restore(); });

describe('CanvasRenderer constructor', () => {
  it('sizes the canvas to scale × devicePixelRatio × emulator dimensions', () => {
    dom.restore(); dom = installDom(1);
    const canvas = new StubCanvas() as unknown as HTMLCanvasElement;
    const r = new CanvasRenderer(canvas, 352, 288);
    // Default scale is 2, dpr is 1 → deviceScale = 2
    expect(canvas.width).toBe(704);
    expect(canvas.height).toBe(576);
    // CSS size = device pixels / dpr
    expect(canvas.style.width).toBe('704px');
    expect(canvas.style.height).toBe('576px');
    expect(r.scale).toBe(2);
  });

  it('multiplies by devicePixelRatio and emits matching CSS pixels', () => {
    dom.restore(); dom = installDom(2);
    const canvas = new StubCanvas() as unknown as HTMLCanvasElement;
    new CanvasRenderer(canvas, 100, 50);
    // deviceScale = round(2 * 2) = 4 → backing 400×200, CSS 200×100
    expect(canvas.width).toBe(400);
    expect(canvas.height).toBe(200);
    expect(canvas.style.width).toBe('200px');
    expect(canvas.style.height).toBe('100px');
  });

  it('rounds fractional dpr-scale combinations (challenges sub-pixel scale)', () => {
    // dpr=1.5, scale=2 → 3.0 exact, no rounding
    dom.restore(); dom = installDom(1.5);
    const canvas = new StubCanvas() as unknown as HTMLCanvasElement;
    new CanvasRenderer(canvas, 10, 10);
    expect(canvas.width).toBe(30);
    expect(canvas.style.width).toBe('20px');
  });

  it('disables image smoothing so nearest-neighbor scaling is preserved', () => {
    const main = new StubCtx2D();
    const off = new StubCtx2D();
    const offscreen = new StubCanvas(off);
    dom.restore();
    dom = installDom(1, () => offscreen);
    const canvas = new StubCanvas(main) as unknown as HTMLCanvasElement;
    new CanvasRenderer(canvas, 16, 16);
    expect(main.imageSmoothingEnabled).toBe(false);
  });

  it('requests an opaque 2D context (alpha:false avoids accidental compositing)', () => {
    const offscreen = new StubCanvas();
    dom.restore();
    dom = installDom(1, () => offscreen);
    const canvas = new StubCanvas();
    new CanvasRenderer(canvas as unknown as HTMLCanvasElement, 16, 16);
    expect(canvas.lastContextOptions).toEqual({ alpha: false });
    expect(offscreen.lastContextOptions).toEqual({ alpha: false });
  });

  it('throws when the main 2D context is unavailable', () => {
    const canvas = new StubCanvas(null);
    expect(() => new CanvasRenderer(canvas as unknown as HTMLCanvasElement, 16, 16))
      .toThrow(/Canvas 2D not supported/);
  });

  it('throws when the offscreen context is unavailable', () => {
    dom.restore();
    dom = installDom(1, () => new StubCanvas(null));
    const canvas = new StubCanvas();
    expect(() => new CanvasRenderer(canvas as unknown as HTMLCanvasElement, 16, 16))
      .toThrow(/Offscreen canvas 2D not supported/);
  });
});

describe('CanvasRenderer updateTexture', () => {
  it('writes the pixel buffer to offscreen ImageData then blits scaled', () => {
    const main = new StubCtx2D();
    const off = new StubCtx2D();
    const offscreen = new StubCanvas(off);
    dom.restore();
    dom = installDom(1, () => offscreen);
    const canvas = new StubCanvas(main);
    const r = new CanvasRenderer(canvas as unknown as HTMLCanvasElement, 4, 2);
    // 4×2 RGBA = 32 bytes
    const buf = new Uint8Array(32);
    for (let i = 0; i < 32; i++) buf[i] = i;
    r.updateTexture(buf);
    expect(off.puts).toHaveLength(1);
    expect(Array.from(off.puts[0].data.data.slice(0, 8)))
      .toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(main.draws).toHaveLength(1);
    expect(main.draws[0]).toMatchObject({ sx: 0, sy: 0, sw: 4, sh: 2, dx: 0, dy: 0, dw: 8, dh: 4 });
    // Re-asserts smoothing every frame in case caller toggled it
    expect(main.imageSmoothingEnabled).toBe(false);
  });
});

describe('CanvasRenderer updateTexture validation', () => {
  it('throws with a clear message when pixel buffer length mismatches', () => {
    const canvas = new StubCanvas() as unknown as HTMLCanvasElement;
    const r = new CanvasRenderer(canvas, 4, 2);
    // 4×2 RGBA = 32 bytes; supply 31 (short) and 33 (long)
    expect(() => r.updateTexture(new Uint8Array(31)))
      .toThrow(/expected 32 bytes \(4×2 RGBA\), got 31/);
    expect(() => r.updateTexture(new Uint8Array(33)))
      .toThrow(/expected 32 bytes \(4×2 RGBA\), got 33/);
  });

  it('re-validates against new dimensions after resize', () => {
    const canvas = new StubCanvas() as unknown as HTMLCanvasElement;
    const r = new CanvasRenderer(canvas, 4, 2);
    r.updateTexture(new Uint8Array(32)); // OK for 4×2
    r.resize(8, 4);
    // 32 bytes is now wrong (need 128)
    expect(() => r.updateTexture(new Uint8Array(32)))
      .toThrow(/expected 128 bytes/);
    r.updateTexture(new Uint8Array(128)); // OK for 8×4
  });
});

describe('CanvasRenderer resize / setScale', () => {
  it('resize() reallocates ImageData (preventing stale buffer reuse)', () => {
    const main = new StubCtx2D();
    const off = new StubCtx2D();
    const offscreen = new StubCanvas(off);
    dom.restore();
    dom = installDom(1, () => offscreen);
    const canvas = new StubCanvas(main);
    const r = new CanvasRenderer(canvas as unknown as HTMLCanvasElement, 4, 4);
    // First updateTexture writes 4×4 = 64 bytes
    r.updateTexture(new Uint8Array(64));
    const firstImageData = off.puts[0].data;
    expect(firstImageData.width).toBe(4);

    r.resize(8, 4);
    expect(offscreen.width).toBe(8);
    expect(offscreen.height).toBe(4);
    // Now expects 8×4 = 128 bytes
    r.updateTexture(new Uint8Array(128));
    const secondImageData = off.puts[1].data;
    expect(secondImageData).not.toBe(firstImageData);
    expect(secondImageData.width).toBe(8);
    expect(secondImageData.height).toBe(4);
    // Main canvas resized via applyScale (scale=2)
    expect(canvas.width).toBe(16);
    expect(canvas.height).toBe(8);
  });

  it('setScale enforces integer ≥ 1 (rounds and clamps)', () => {
    const canvas = new StubCanvas() as unknown as HTMLCanvasElement;
    const r = new CanvasRenderer(canvas, 10, 10);
    r.setScale(0.4);
    expect(r.scale).toBe(1);
    r.setScale(-5);
    expect(r.scale).toBe(1);
    r.setScale(3.7);
    expect(r.scale).toBe(4);
  });

  it('setScale() updates only the visible canvas, not the offscreen', () => {
    const offscreen = new StubCanvas();
    dom.restore();
    dom = installDom(1, () => offscreen);
    const canvas = new StubCanvas() as unknown as HTMLCanvasElement;
    const r = new CanvasRenderer(canvas, 10, 10);
    expect(canvas.width).toBe(20);
    r.setScale(4);
    expect(canvas.width).toBe(40);
    expect(canvas.height).toBe(40);
    // Offscreen stays at emulator resolution
    expect(offscreen.width).toBe(10);
    expect(offscreen.height).toBe(10);
    expect(r.scale).toBe(4);
  });
});

describe('CanvasRenderer pixelAspectX (horizontal squeeze)', () => {
  it('halves only the CSS width while keeping the backing store at full resolution', () => {
    // CPC case: 768×272 buffer, displayed at half width to undo the 2×
    // horizontal oversampling. dpr=1, default scale=2 → deviceScale=2.
    const canvas = new StubCanvas() as unknown as HTMLCanvasElement;
    new CanvasRenderer(canvas, 768, 272, 0.5);
    // Backing store is unchanged (full crispness): 768·2 × 272·2.
    expect(canvas.width).toBe(1536);
    expect(canvas.height).toBe(544);
    // CSS width is halved (1536 / dpr × 0.5); CSS height untouched.
    expect(canvas.style.width).toBe('768px');
    expect(canvas.style.height).toBe('544px');
  });

  it('defaults to 1 (no squeeze) when omitted', () => {
    const canvas = new StubCanvas() as unknown as HTMLCanvasElement;
    new CanvasRenderer(canvas, 100, 50);
    // deviceScale=2 → backing 200×100, CSS 200×100 (square mapping).
    expect(canvas.style.width).toBe('200px');
    expect(canvas.style.height).toBe('100px');
  });
});

describe('CanvasRenderer setViewport (border crop)', () => {
  it('sizes the canvas to the viewport, not the full buffer', () => {
    const canvas = new StubCanvas() as unknown as HTMLCanvasElement;
    const r = new CanvasRenderer(canvas, 768, 272);
    // None-border crop: just the 640×200 active area at offset (64,36).
    r.setViewport(64, 36, 640, 200);
    // deviceScale=2 → backing 640·2 × 200·2.
    expect(canvas.width).toBe(1280);
    expect(canvas.height).toBe(400);
    expect(canvas.style.width).toBe('1280px');
  });

  it('blits only the viewport sub-rect of the source buffer', () => {
    const main = new StubCtx2D();
    const off = new StubCtx2D();
    const offscreen = new StubCanvas(off);
    dom.restore();
    dom = installDom(1, () => offscreen);
    const canvas = new StubCanvas(main);
    const r = new CanvasRenderer(canvas as unknown as HTMLCanvasElement, 768, 272);
    r.setViewport(64, 36, 640, 200);
    // Full buffer is always uploaded (768×272×4 bytes)…
    r.updateTexture(new Uint8Array(768 * 272 * 4));
    // …but drawn from the cropped source rect into the (cropped) canvas.
    expect(main.draws[0]).toMatchObject({
      sx: 64, sy: 36, sw: 640, sh: 200,
      dx: 0, dy: 0, dw: 1280, dh: 400,
    });
  });

  it('composes the horizontal squeeze with the crop', () => {
    const canvas = new StubCanvas() as unknown as HTMLCanvasElement;
    const r = new CanvasRenderer(canvas, 768, 272, 0.5);
    r.setViewport(64, 36, 640, 200);
    // backing 1280 wide; CSS = 1280 / dpr × 0.5 = 640.
    expect(canvas.width).toBe(1280);
    expect(canvas.style.width).toBe('640px');
  });
});

describe('CanvasRenderer CRT setters', () => {
  it('are all no-ops (canvas backend has no CRT pipeline)', () => {
    const canvas = new StubCanvas() as unknown as HTMLCanvasElement;
    const r = new CanvasRenderer(canvas, 8, 8);
    // None of these should throw or mutate observable state
    const before = { width: canvas.width, height: canvas.height, scale: r.scale };
    r.setSmoothing(0.5);
    r.setCurvature(0.1);
    r.setScanlines(1);
    r.setMaskType(2);
    r.setDotPitch(3);
    r.setCurvatureMode(1);
    r.setBrightness(0.5);
    r.setContrast(1.5);
    r.setNoise(0.2);
    r.setScalingMode(3);
    expect({ width: canvas.width, height: canvas.height, scale: r.scale }).toEqual(before);
  });
});
