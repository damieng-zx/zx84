/**
 * Tatung Einstein TC-01 hardware constants.
 *
 * The Einstein is driven by a Z80A at 4 MHz. Video comes from a TMS9918A/9929A
 * VDP (its geometry lives in `cores/tms9918a.ts`); this file adds the border
 * padding that frames the 256×192 active area, plus the machine clocks.
 */

import { VDP_WIDTH, VDP_HEIGHT } from '@/cores/tms9918a.ts';

/** Z80 clock (Hz). */
export const EINSTEIN_CPU_CLOCK = 4_000_000;

/**
 * AY-3-8910 clock on the Einstein (Hz). The PSG is fed a 2 MHz clock derived
 * from the system clock. (Confirmed against the TC-01 service manual.)
 */
export const EINSTEIN_AY_CLOCK = 2_000_000;

/** PAL field rate — the TC-01 uses the TMS9929A (50 Hz). */
export const EINSTEIN_FRAME_HZ = 50;

/** Nominal T-states per frame (4 MHz / 50 Hz). Used for the headless tick
 *  budget and the debugger register readout, mirroring the CPC. */
export const EINSTEIN_T_PER_FRAME = Math.round(EINSTEIN_CPU_CLOCK / EINSTEIN_FRAME_HZ);

/** Border padding around the 256×192 active display, in output pixels. Chosen
 *  to give a clean 320×240 (4:3) window with a modest border. */
export const EINSTEIN_BORDER_LEFT = (320 - VDP_WIDTH) >> 1;  // 32
export const EINSTEIN_BORDER_TOP = (240 - VDP_HEIGHT) >> 1;  // 24

/** Output RGBA buffer geometry (active area + border). */
export const EINSTEIN_SCREEN_WIDTH = VDP_WIDTH + EINSTEIN_BORDER_LEFT * 2;   // 320
export const EINSTEIN_SCREEN_HEIGHT = VDP_HEIGHT + EINSTEIN_BORDER_TOP * 2;  // 240
