import type { Zx8xModel } from './models.ts';
import { isZx8xNtsc } from './models.ts';

export const ZX8X_CPU_CLOCK = 3_250_000;
/** British models: 312 lines at 207T = 64,584T, 50.3 Hz. */
export const ZX8X_LINES_PER_FRAME_PAL = 312;
/** US models: 262 lines at 207T = 54,234T, 59.9 Hz. */
export const ZX8X_LINES_PER_FRAME_NTSC = 262;
export const ZX8X_T_PER_LINE = 207;

export function zx8xLinesPerFrame(model: Zx8xModel): number {
  return isZx8xNtsc(model) ? ZX8X_LINES_PER_FRAME_NTSC : ZX8X_LINES_PER_FRAME_PAL;
}

export function zx8xTStatesPerFrame(model: Zx8xModel): number {
  return ZX8X_T_PER_LINE * zx8xLinesPerFrame(model);
}

export const ZX8X_ACTIVE_WIDTH = 256;
export const ZX8X_ACTIVE_HEIGHT = 192;
export const ZX8X_BORDER_LEFT = 32;
export const ZX8X_BORDER_TOP = 24;
export const ZX8X_SCREEN_WIDTH = ZX8X_ACTIVE_WIDTH + ZX8X_BORDER_LEFT * 2;
export const ZX8X_SCREEN_HEIGHT = ZX8X_ACTIVE_HEIGHT + ZX8X_BORDER_TOP * 2;
