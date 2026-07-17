/**
 * Toshiba HX-10 (MSX1) hardware constants.
 *
 * The HX-10 is a European MSX1: a Z80A at 3.579545 MHz driving a TMS9929A VDP
 * (its 256×192 geometry lives in `cores/tms9918a.ts`) at PAL 50 Hz, with an
 * AY-3-8910-compatible PSG clocked at half the CPU rate. This file adds the
 * machine clocks and the border padding that frames the active area, mirroring
 * `einstein/constants.ts` so both TMS9918A machines share the same 320×240 window.
 */

import { VDP_WIDTH, VDP_HEIGHT } from '@/cores/tms9918a.ts';

/** Z80 clock (Hz). The MSX standard master clock is 21.477270 MHz / 6. */
export const MSX_CPU_CLOCK = 3_579_545;

/** PSG clock (Hz) — half the CPU clock on the MSX. */
export const MSX_PSG_CLOCK = 1_789_772;

/** PAL field rate — the HX-10 uses the TMS9929A (50 Hz). */
export const MSX_FRAME_HZ = 50;

/** Nominal T-states per frame (3.579545 MHz / 50 Hz). Used for the headless
 *  tick budget and the debugger register readout, mirroring the Einstein/CPC. */
export const MSX_T_PER_FRAME = Math.round(MSX_CPU_CLOCK / MSX_FRAME_HZ);

/** Border padding around the 256×192 active display, in output pixels. Chosen
 *  to give a clean 320×240 (4:3) window with a modest border. */
export const MSX_BORDER_LEFT = (320 - VDP_WIDTH) >> 1;  // 32
export const MSX_BORDER_TOP = (240 - VDP_HEIGHT) >> 1;  // 24

/** Output RGBA buffer geometry (active area + border). */
export const MSX_SCREEN_WIDTH = VDP_WIDTH + MSX_BORDER_LEFT * 2;   // 320
export const MSX_SCREEN_HEIGHT = VDP_HEIGHT + MSX_BORDER_TOP * 2;  // 240
