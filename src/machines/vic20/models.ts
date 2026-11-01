/**
 * Commodore VIC-20 models.
 *
 *  - `vic20`  the VIC-20: a 6502, 5K of RAM, the 6560 (NTSC) or 6561 (PAL)
 *             VIC for video and sound, two 6522 VIAs, and BASIC V2 and the
 *             KERNAL in ROM. The TV standard is the locale, as on the C64:
 *             `'us'` is the NTSC machine, every other locale the PAL one.
 */

import type { MachineLocale } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';

export type Vic20Model = 'vic20';

export function isVic20Model(model: MachineModel | string): model is Vic20Model {
  return model === 'vic20';
}

/** The NTSC machine (6560, 60 Hz) for the `'us'` locale, else PAL (6561, 50 Hz). */
export function vic20IsNtsc(locale: MachineLocale | undefined): boolean {
  return locale === 'us';
}

/**
 * The ROM images on the ROM host, concatenated in this order: BASIC
 * (901486-01, the same chip in both), the KERNAL (901486-06 NTSC, 901486-07
 * PAL) and the character ROM (901460-03).
 */
export function vic20RomSources(ntsc: boolean): readonly string[] {
  return [
    'vic20/basic-901486-01.rom',
    ntsc ? 'vic20/kernal-901486-06.rom' : 'vic20/kernal-901486-07.rom',
    'vic20/characters-901460-03.rom',
  ];
}

/**
 * The ROM/Carts pane's sockets, one per chip, in the order of
 * `vic20RomSources`. They sit at an 8K stride in the concatenated image, so
 * the character ROM (4K) is the last 4K of a 20K whole, as on the C64.
 */
export const VIC20_ROM_SLOT_SIZE = 0x2000;
export const VIC20_ROM_SLOT_LABELS = ['BASIC', 'KERNAL', 'Character ROM'] as const;
/** Each chip's own size: what an override in its socket is cut to. */
export const VIC20_ROM_CHIP_SIZES = [0x2000, 0x2000, 0x1000] as const;
