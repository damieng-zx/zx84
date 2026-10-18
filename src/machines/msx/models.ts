/**
 * MSX family model type and classification helpers.
 *
 * The MSX1 is another Z80 + TMS9918A VDP + AY-3-8910 machine (like the
 * Einstein), but with an 8255 PPI for keyboard scan and slot paging, and MSX
 * BASIC in ROM. The Toshiba HX-10 (PAL), Sony HB-55 (Japanese, NTSC) and Sony HB-55P (PAL) ship.
 */

import type { MachineModel } from '@/models.ts';

/** MSX1 models. */
export type MsxModel = 'hx-10' | 'hb-55' | 'hb-55p';

/** Type guard: true for any MSX model. */
export function isMsxModel(m: MachineModel): m is MsxModel {
  return m === 'hx-10' || m === 'hb-55' || m === 'hb-55p';
}
