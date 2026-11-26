/**
 * Commodore Plus/4 and Commodore 16 models.
 *
 *  - `plus4`  the Plus/4: a 7501 at 1.77 MHz (PAL), 64K of RAM, the 7360 TED
 *             for video (40x25 text, two bitmaps) and sound (two square voices
 *             and noise), two 6529B PIOs, a 6551A ACIA on the RS-232 port, and
 *             BASIC 3.5 + KERNAL + the "3+1" function ROMs.
 *  - `c16`    the Commodore 16/116: the same board with 16K of RAM, no ACIA and
 *             no user port. Its ROMs come as one 32K pair (KERNAL + BASIC); no
 *             3+1 function ROMs are fitted.
 *
 * The TV standard rides on the locale, as on the C64 and VIC-20: `'us'` is the
 * NTSC machine, every other locale the PAL one.
 */

import type { MachineLocale } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';

export type Plus4Model = 'plus4' | 'c16';

export function isPlus4Model(model: MachineModel | string): model is Plus4Model {
  return model === 'plus4' || model === 'c16';
}

export function isC16Model(model: MachineModel | string): model is 'c16' {
  return model === 'c16';
}

/** The NTSC machine for the `'us'` locale, else PAL. */
export function plus4IsNtsc(locale: MachineLocale | undefined): boolean {
  return locale === 'us';
}

/** RAM fitted, in bytes: 64K on the Plus/4, 16K on the C16. */
export function plus4RamSize(model: Plus4Model): number {
  return model === 'c16' ? 0x4000 : 0x10000;
}

/** The Plus/4 has the 6551A ACIA on its RS-232 port; the C16 has no ACIA. */
export function plus4HasAcia(model: Plus4Model): boolean {
  return model === 'plus4';
}

/** The Plus/4 has a user port (6529B PIO 1); the C16 has the PIO but nothing
 *  brought out to a connector, so it is not fitted. */
export function plus4HasUserPort(model: Plus4Model): boolean {
  return model === 'plus4';
}

/**
 * The ROM images on the ROM host, concatenated in this order. The KERNAL comes
 * first (16K), then BASIC (16K), so the image's layout is the reverse of the
 * chip addresses. The Plus/4 adds the two 16K "3+1" function ROMs after them.
 *
 * The KERNAL revisions: 318004-05 is the PAL Plus/4 and C16, 318005-05 the
 * NTSC one, 318004-01 the V232 prototype's. BASIC 3.5 is 318006-01 in both.
 */
export function plus4RomSources(model: Plus4Model, ntsc: boolean): readonly string[] {
  // One KERNAL revision serves both machines; the C16 has no 3+1 ROMs.
  const roms = [
    ntsc ? 'plus4/kernal-318005-05.rom' : 'plus4/kernal-318004-05.rom',
    'plus4/basic-318006-01.rom',
  ];
  if (model !== 'c16') roms.push('plus4/3plus1-317053-01.rom', 'plus4/3plus1-317054-01.rom');
  return roms;
}

/** The system ROM as the ROM host serves it: KERNAL, BASIC, then the 3+1 ROMs. */
export const PLUS4_KERNAL_SIZE = 0x4000;
export const PLUS4_BASIC_SIZE = 0x4000;
export const PLUS4_FUNC_SIZE = 0x4000;
export const PLUS4_CHARGEN_SIZE = 0x2000;

/** The ROM/Carts pane's sockets, one per chip (the 3+1 ROMs only on the Plus/4). */
export function plus4RomSlotLabels(model: Plus4Model): readonly string[] {
  return model === 'c16'
    ? ['KERNAL', 'BASIC']
    : ['KERNAL', 'BASIC', '3+1 low', '3+1 high'];
}

/** Each chip's own size, in the order of `plus4RomSources`. */
export function plus4RomChipSizes(model: Plus4Model): readonly number[] {
  return model === 'c16'
    ? [PLUS4_KERNAL_SIZE, PLUS4_BASIC_SIZE]
    : [PLUS4_KERNAL_SIZE, PLUS4_BASIC_SIZE, PLUS4_FUNC_SIZE, PLUS4_FUNC_SIZE];
}

/** The whole system image the ROM host serves. */
export function plus4RomSize(model: Plus4Model): number {
  return plus4RomChipSizes(model).reduce((n, s) => n + s, 0);
}

/** Each drive's DOS ROM on the ROM host (shared with every Commodore on the
 *  serial bus). */
export { CBM_DRIVE_ROM_SOURCES as PLUS4_DRIVE_ROM_SOURCES } from '@/machines/shared/cbm/drive/drive-unit.ts';
