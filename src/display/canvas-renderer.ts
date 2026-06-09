/**
 * Canvas 2D display renderer — pixel-perfect nearest-neighbor scaling.
 *
 * Uses an offscreen canvas at emulator resolution, then draws it scaled
 * onto the visible canvas with imageSmoothingEnabled = false.
 */

import type { IScreenRenderer } from '@/display/display.ts';

export class CanvasRenderer implements IScreenRenderer {
  canvas: HTMLCanvasElement;
  scale = 2;

  private width: number;
  private height: number;
  // Displayed sub-rectangle of the source buffer (border crop). Defaults to the
  // whole buffer; the CPC uses it to trim its fixed-size frame buffer.
  private viewX = 0;
  private viewY = 0;
  private viewW: number;
  private viewH: number;
  // Horizontal squeeze applied to CSS width only — see WebGLRenderer.
  private pixelAspectX: number;
  private ctx: CanvasRenderingContext2D;
  private offscreen: HTMLCanvasElement;
  private offCtx: CanvasRenderingContext2D;
  private imageData: ImageData;

  constructor(canvas: HTMLCanvasElement, width: number, height: number, pixelAspectX = 1) {
    this.canvas = canvas;
    this.width = width;
    this.height = height;
    this.viewW = width;
    this.viewH = height;
    this.pixelAspectX = pixelAspectX;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D not supported');
    this.ctx = ctx;

    this.offscreen = document.createElement('canvas');
    this.offscreen.width = width;
    this.offscreen.height = height;
    const offCtx = this.offscreen.getContext('2d', { alpha: false });
    if (!offCtx) throw new Error('Offscreen canvas 2D not supported');
    this.offCtx = offCtx;

    this.imageData = this.offCtx.createImageData(width, height);

    this.applyScale();
  }

  private applyScale(): void {
    const dpr = window.devicePixelRatio || 1;
    // "scale" is an integer device-pixel multiple: each emulator pixel maps to
    // exactly `scale` physical pixels, so the image is always pixel-perfect and
    // the steps are even (1,2,3,4). DPR is used ONLY to size the CSS box so that
    // backing device pixels map 1:1 onto physical pixels. Folding DPR into the
    // multiple (the old `round(scale·dpr)`) broke this — at 125% it made the
    // steps jump 1,3,4,5 and any non-integer result blurred the pixels.
    const w = this.viewW * this.scale;
    const h = this.viewH * this.scale;
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = (w / dpr * this.pixelAspectX) + 'px';
    this.canvas.style.height = (h / dpr) + 'px';
    this.ctx.imageSmoothingEnabled = false;
  }

  updateTexture(pixels: Uint8Array): void {
    const expected = this.width * this.height * 4;
    if (pixels.length !== expected) {
      throw new Error(`CanvasRenderer.updateTexture: expected ${expected} bytes (${this.width}×${this.height} RGBA), got ${pixels.length}`);
    }
    this.imageData.data.set(pixels);
    this.offCtx.putImageData(this.imageData, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
    this.ctx.drawImage(
      this.offscreen,
      this.viewX, this.viewY, this.viewW, this.viewH,
      0, 0, this.canvas.width, this.canvas.height,
    );
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    // A buffer-size change resets the viewport to the whole buffer; callers that
    // want a crop re-apply it via setViewport afterwards.
    this.viewX = 0;
    this.viewY = 0;
    this.viewW = width;
    this.viewH = height;
    this.offscreen.width = width;
    this.offscreen.height = height;
    this.imageData = this.offCtx.createImageData(width, height);
    this.applyScale();
  }

  setViewport(x: number, y: number, w: number, h: number): void {
    this.viewX = x;
    this.viewY = y;
    this.viewW = w;
    this.viewH = h;
    this.applyScale();
  }

  setScale(scale: number): void {
    this.scale = Math.max(1, Math.round(scale));
    this.applyScale();
  }

  // CRT-specific setters — no-ops for canvas renderer
  setSmoothing(_v: number): void {}
  setCurvature(_v: number): void {}
  setScanlines(_v: number): void {}
  setMaskType(_v: number): void {}
  setDotPitch(_v: number): void {}
  setCurvatureMode(_v: number): void {}
  setBrightness(_v: number): void {}
  setContrast(_v: number): void {}
  setNoise(_v: number): void {}
  setScalingMode(_v: number): void {}
}
