/**
 * Screen renderer interface — implemented by WebGLRenderer and CanvasRenderer.
 */

export interface IScreenRenderer {
  canvas: HTMLCanvasElement;
  scale: number;
  updateTexture(pixels: Uint8Array): void;
  resize(width: number, height: number): void;
  /** Display only a sub-rectangle (in source pixels) of the frame buffer,
   *  scaled to fill the canvas — used for CPC border cropping. */
  setViewport(x: number, y: number, w: number, h: number): void;
  setScale(scale: number): void;
  setSmoothing(v: number): void;
  setCurvature(v: number): void;
  setScanlines(v: number): void;
  setMaskType(v: number): void;
  setDotPitch(v: number): void;
  setCurvatureMode(v: number): void;
  setBrightness(v: number): void;
  setContrast(v: number): void;
  setSaturation(v: number): void;
  setGamma(v: number): void;
  setNoise(v: number): void;
  setScalingMode(v: number): void;
  /** Release GPU/context resources owned by this renderer. Optional — the
   *  Canvas2D renderer needs no explicit teardown. Pass `{ loseContext: true }`
   *  only when the canvas itself is being discarded: forcing the context lost
   *  on a canvas that will be re-used (e.g. a model switch) would poison the
   *  very context the next renderer obtains from it. */
  dispose?(options?: { loseContext?: boolean }): void;
}
