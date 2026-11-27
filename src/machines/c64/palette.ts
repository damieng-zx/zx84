/**
 * The VIC-II's sixteen colours, as the Commodore 64 uses them: the set shared
 * with the Commodore 128 (see `shared/cbm/vic-ii-board.ts`).
 */

import { VIC_COLOUR_NAMES, VIC_PALETTE } from '@/machines/shared/cbm/vic-ii-board.ts';

/** The palette as 32-bit pixels for a little-endian RGBA frame buffer. */
export const C64_PALETTE: Uint32Array = VIC_PALETTE;

/** Colour names, for the debugger. */
export const C64_COLOUR_NAMES: readonly string[] = VIC_COLOUR_NAMES;
