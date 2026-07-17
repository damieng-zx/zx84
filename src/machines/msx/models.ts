/**
 * MSX family model type and classification helpers.
 *
 * The MSX1 is another Z80 + TMS9918A VDP + AY-3-8910 machine (like the
 * Einstein), but with an 8255 PPI for keyboard scan and slot paging, and MSX
 * BASIC in ROM. Only the Toshiba HX-10 ships today.
 */

import type { MachineModel } from '@/models.ts';

/** MSX1 models. Only the Toshiba HX-10 ships today. */
export type MsxModel = 'hx-10';

/** Type guard: true for any MSX model. */
export function isMsxModel(m: MachineModel): m is MsxModel {
  return m === 'hx-10';
}
