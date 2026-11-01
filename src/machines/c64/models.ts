/**
 * Commodore 64 models.
 *
 *  - `c64`  the Commodore 64 (PAL): a 6510 at 0.985 MHz, 64K of RAM, the 6569
 *           VIC-II, the 6581 SID and two 6526 CIAs, with BASIC V2 and the
 *           KERNAL in ROM. Software arrives on cassette through the Datasette.
 */

import type { MachineModel } from '@/models.ts';

export type C64Model = 'c64';

export function isC64Model(model: MachineModel | string): model is C64Model {
  return model === 'c64';
}

/** The ROM images on the ROM host, concatenated in this order. */
export const C64_ROM_SOURCES = [
  'c64/basic-901226-01.rom', 'c64/kernal-901227-03.rom', 'c64/chargen-901225-01.rom',
] as const;

/**
 * The ROM/Carts pane's sockets, one per chip, in the order of
 * `C64_ROM_SOURCES`. They sit at an 8K stride in the concatenated image, so
 * the character ROM (4K) is the last 4K of a 20K whole.
 */
export const C64_ROM_SLOT_SIZE = 0x2000;
export const C64_ROM_SLOT_LABELS = ['BASIC', 'KERNAL', 'Character ROM'] as const;
/** Each chip's own size: what an override in its socket is cut to. */
export const C64_ROM_CHIP_SIZES = [0x2000, 0x2000, 0x1000] as const;

/** Each drive's DOS ROM on the ROM host (shared with every Commodore on the
 *  serial bus). */
export { CBM_DRIVE_ROM_SOURCES as C64_DRIVE_ROM_SOURCES } from '@/machines/shared/cbm/drive/drive-unit.ts';
