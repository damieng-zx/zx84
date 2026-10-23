/**
 * Atari 8-bit model classification: the 400/800 and the XL line.
 *
 * The models are the machines; the TV standard is a separate axis. Every
 * model was sold in NTSC and PAL form with identical logic but a different
 * crystal, scanline count and GTIA (whose PAL pin tells the OS which standard
 * it is running on), so the region is carried by the machine locale rather
 * than doubling the model list: `'us'` builds the NTSC machine and every
 * other locale the PAL one. Each model's OS ROM image serves both regions.
 *
 * The XL machines differ from the 400/800 in memory, not in the custom chips:
 * a 16K OS ROM (with a self-test block), PIA port B repurposed as a memory
 * control register, BASIC built into the 600XL and 800XL, and 64K of RAM that
 * can be uncovered from beneath the ROMs. The XE line (65XE, 800XE, 130XE) is
 * the 800XL's architecture in a cheaper case; the 130XE adds 64K of banked
 * extended RAM that PORTB window-maps over $4000-$7FFF for the CPU, ANTIC or
 * both.
 *
 *   model    RAM   OS image                  BASIC
 *   400      16K   10K OS rev B              cartridge
 *   800      48K   10K OS rev B              cartridge
 *   600XL    16K   16K XL OS rev 1 (3/1983)  built in
 *   800XL    64K   16K XL OS rev 2 (5/1983)  built in
 *   1200XL   64K   16K 1200XL OS rev 10      cartridge (none built in)
 *   65XE     64K   16K XL/XE OS              built in
 *   800XE    64K   16K XL/XE OS              built in
 *   130XE    128K  16K XL/XE OS              built in
 *
 * The emulator ships none of Atari's firmware. It runs the open-source
 * AltirraOS instead (the 10K 400/800 build or the 16K XL/XE build) with
 * Altirra BASIC in place of Atari BASIC; Atari's own images still work when
 * the user drops them on the ROM pane or cartridge slot.
 */

import type { MachineLocale } from '@/machines/machine.ts';
import type { MachineModel } from '@/models.ts';
import { atariTiming, type AtariTiming } from './constants.ts';

export type AtariModel =
  | 'atari400' | 'atari800'
  | 'atari600xl' | 'atari800xl' | 'atari1200xl'
  | 'atari65xe' | 'atari800xe' | 'atari130xe';

export type AtariRegion = 'ntsc' | 'pal';

export interface AtariModelInfo {
  /** Name as printed on the case ("800", "800XL"). */
  readonly name: string;
  /** Fitted RAM in KiB. */
  readonly ramKb: 16 | 48 | 64;
  /** Banked extended RAM beyond the 64K address space, in 16K banks (130XE). */
  readonly extBanks: 0 | 4;
  /** XL memory architecture: 16K OS, PORTB memory control, RAM under ROM. */
  readonly xl: boolean;
  /** BASIC is in ROM inside the machine rather than on a cartridge. */
  readonly builtinBasic: boolean;
  /** ROM-host source of the default OS image (AltirraOS). */
  readonly osSource: string;
  /** The 400's membrane keyboard has no full-travel keys. */
  readonly membrane: boolean;
}

/**
 * The default firmware, all open source: AltirraOS, Avery Lee's clean-room
 * OS (the 10K 400/800 build and the 16K XL/XE build, laid out like the Atari
 * images they replace), and Altirra BASIC, an 8K drop-in for Atari BASIC that
 * is a cartridge on the 400/800/1200XL and the internal ROM of the
 * 600XL/800XL. Both are freely redistributable: every source file carries the
 * FSF all-permissive notice ("Copying and distribution of this file, with or
 * without modification, are permitted in any medium without royalty provided
 * the copyright notice and this notice are preserved").
 */
export const ALTIRRA_OS_SOURCE = 'atari/altirraos-800.rom';
export const ALTIRRA_XL_OS_SOURCE = 'atari/altirraos-xl.rom';
export const ALTIRRA_BASIC_SOURCE = 'atari/altirra-basic.rom';

/** Names the ROM pane shows for the default firmware. */
export const ALTIRRA_OS_800_LABEL = 'AltirraOS 3.44 (400/800)';
export const ALTIRRA_OS_XL_LABEL = 'AltirraOS 3.44 (XL/XE)';
export const ALTIRRA_BASIC_LABEL = 'Altirra BASIC 1.59';

export const ATARI_MODEL_INFO: Readonly<Record<AtariModel, AtariModelInfo>> = {
  atari400: { name: '400', ramKb: 16, extBanks: 0, xl: false, builtinBasic: false, osSource: ALTIRRA_OS_SOURCE, membrane: true },
  atari800: { name: '800', ramKb: 48, extBanks: 0, xl: false, builtinBasic: false, osSource: ALTIRRA_OS_SOURCE, membrane: false },
  atari600xl: { name: '600XL', ramKb: 16, extBanks: 0, xl: true, builtinBasic: true, osSource: ALTIRRA_XL_OS_SOURCE, membrane: false },
  atari800xl: { name: '800XL', ramKb: 64, extBanks: 0, xl: true, builtinBasic: true, osSource: ALTIRRA_XL_OS_SOURCE, membrane: false },
  atari1200xl: { name: '1200XL', ramKb: 64, extBanks: 0, xl: true, builtinBasic: false, osSource: ALTIRRA_XL_OS_SOURCE, membrane: false },
  atari65xe: { name: '65XE', ramKb: 64, extBanks: 0, xl: true, builtinBasic: true, osSource: ALTIRRA_XL_OS_SOURCE, membrane: false },
  atari800xe: { name: '800XE', ramKb: 64, extBanks: 0, xl: true, builtinBasic: true, osSource: ALTIRRA_XL_OS_SOURCE, membrane: false },
  atari130xe: { name: '130XE', ramKb: 64, extBanks: 4, xl: true, builtinBasic: true, osSource: ALTIRRA_XL_OS_SOURCE, membrane: false },
};

export const ATARI_MODELS: readonly AtariModel[] = [
  'atari400', 'atari800', 'atari600xl', 'atari800xl', 'atari1200xl',
  'atari65xe', 'atari800xe', 'atari130xe',
];

export function isAtariModel(model: MachineModel): model is AtariModel {
  return (ATARI_MODELS as readonly string[]).includes(model);
}

export function atariInfo(model: AtariModel): AtariModelInfo {
  return ATARI_MODEL_INFO[model];
}

/** TV standard for a machine locale: NTSC for the US, PAL otherwise. */
export function atariRegionForLocale(locale: MachineLocale | undefined): AtariRegion {
  return locale === 'us' ? 'ntsc' : 'pal';
}

export function atariTimingFor(region: AtariRegion): AtariTiming {
  return atariTiming(region === 'pal');
}

/** Fitted RAM in KiB, banked extended RAM included. */
export function atariRamKb(model: AtariModel): 16 | 48 | 64 | 128 {
  const info = ATARI_MODEL_INFO[model];
  return (info.ramKb + info.extBanks * 16) as 16 | 48 | 64 | 128;
}

/** Name as printed on the case ("400", "800XL"). */
export function atariModelName(model: AtariModel): string {
  return ATARI_MODEL_INFO[model].name;
}

/** Only the 400 has a membrane keyboard. */
export function atariIs400(model: AtariModel): boolean {
  return ATARI_MODEL_INFO[model].membrane;
}

/**
 * Size classification for a raw OS image.
 *
 * The 400/800 OS is 10K: a 2K floating-point package at $D800-$DFFF followed
 * by the 8K operating system at $E000-$FFFF; Atari's OS rev B and the AltirraOS
 * 400/800 build are both exactly that concatenation.
 *
 * The XL OS is 16K, laid out as the address space it covers from $C000: 4K at
 * $C000-$CFFF, then the 2K self-test block (which the hardware shows at
 * $5000-$57FF, since $D000-$D7FF is I/O), then the 10K from $D800.
 */
export const ATARI_OS_SIZE = 0x2800;
export const ATARI_XL_OS_SIZE = 0x4000;
export const ATARI_FP_ROM_SIZE = 0x800;
export const ATARI_BASIC_ROM_SIZE = 0x2000;
