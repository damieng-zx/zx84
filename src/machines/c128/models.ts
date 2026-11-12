/**
 * Commodore 128 models.
 *
 *  - `c128`  the Commodore 128: an 8502 (and a Z80 for the boot) at 1 MHz, 128K
 *            of RAM, the VIC-IIe and the 8563 VDC, the 6581 SID and two 6526
 *            CIAs, with BASIC 7.0, the screen editor and the KERNAL in ROM and
 *            the 64's own BASIC and KERNAL for C64 mode.
 */

import type { MachineModel } from '@/models.ts';

export type C128Model = 'c128';

export function isC128Model(model: MachineModel | string): model is C128Model {
  return model === 'c128';
}

/**
 * The ROM images on the ROM host, concatenated in this order: BASIC 7.0 low
 * and high (16K each), the system ROM (16K: the screen editor, the Z80 BIOS
 * and the KERNAL), the character ROM (8K), and C64 mode's BASIC and KERNAL
 * (8K each; the same images the C64 uses).
 */
export const C128_ROM_SOURCES = [
  'c128/basiclo-318018-04.rom', 'c128/basichi-318019-04.rom', 'c128/kernal-318020-05.rom',
  'c128/chargen-325078-03.rom',
  'c64/basic-901226-01.rom', 'c64/kernal-901227-03.rom',
] as const;

/**
 * The ROM/Carts pane's sockets, one per chip, in the order of `C128_ROM_SOURCES`.
 * The chips are of two sizes, so a socket's place in the concatenated image is
 * its chip sizes added up (`C128_ROM_SLOT_OFFSETS`), not a multiple of one stride.
 */
export const C128_ROM_SLOT_LABELS = [
  'BASIC low', 'BASIC high', 'System ROM', 'Character ROM', '64 BASIC', '64 KERNAL',
] as const;
export const C128_ROM_CHIP_SIZES = [0x4000, 0x4000, 0x4000, 0x2000, 0x2000, 0x2000] as const;
export const C128_ROM_SLOT_OFFSETS: readonly number[] = C128_ROM_CHIP_SIZES.map(
  (_, i) => C128_ROM_CHIP_SIZES.slice(0, i).reduce((a, b) => a + b, 0),
);
/** The six images end to end. */
export const C128_ROM_TOTAL = C128_ROM_CHIP_SIZES.reduce((a, b) => a + b, 0);

/** Each drive's DOS ROM on the ROM host (shared with every Commodore on the
 *  serial bus). */
export { CBM_DRIVE_ROM_SOURCES as C128_DRIVE_ROM_SOURCES } from '@/machines/shared/cbm/drive/drive-unit.ts';
