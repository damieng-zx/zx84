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
  setNoise(v: number): void;
  setScalingMode(v: number): void;
}
