/**
 * Apple II family models.
 *
 *  - `apple2`       the original Apple ][ (1977): Integer BASIC in ROM, the
 *                   original Monitor with no Autostart, so a disk is booted by
 *                   hand (`PR#6`, or `C600G` from the Monitor).
 *  - `apple2-plus`  the Apple ][+ (1979): Applesoft in ROM and the Autostart
 *                   Monitor, which scans the slots and boots a disk on reset.
 *  - `apple2e`      the unenhanced Apple //e (1983): 64K with an MMU, a full ASCII
 *                   keyboard, lowercase, built-in 80-column firmware and (with the
 *                   extended 80-column card) 64K of auxiliary RAM.
 *  - `apple2e-enhanced`  the Enhanced //e (1985): the same machine with a 65C02,
 *                   updated ROMs and MouseText in the alternate character set.
 *  - `apple2c`      the Apple //c (1984): a //e in a case, with a 65C02, 128K, 80-column
 *                   firmware, a built-in disk drive and no expansion slots.
 *
 * The ][ and ][+ are 48K machines with an upper-case-only keyboard and character
 * set; a language card adds the other 16K.
 */

export type Apple2Model = 'apple2' | 'apple2-plus' | 'apple2e' | 'apple2e-enhanced' | 'apple2c';

export function isApple2Model(model: string): model is Apple2Model {
  return Object.prototype.hasOwnProperty.call(MODEL_INFO, model);
}

export interface Apple2ModelInfo {
  /** Name shown in the UI. */
  readonly label: string;
  /** System-ROM image on the ROM host: 12K for $D000-$FFFF, or on the IIe the
   *  16K for $C000-$FFFF. */
  readonly romSource: string;
  /** Video character-generator ROM on the ROM host. */
  readonly charsetSource: string;
  /** An Apple //e: MMU, auxiliary memory, full keyboard. */
  readonly iie: boolean;
  /** The CPU is a CMOS 65C02 rather than an NMOS 6502. */
  readonly cmos: boolean;
  /** An Apple //c: no slots (the ROM at $C100-$CFFF is always the internal one),
   *  128K and the disk controller built in. */
  readonly iic: boolean;
  /** The Monitor ROM scans the slots and boots a disk on reset (Autostart). */
  readonly autostart: boolean;
  /** Label for the system-ROM entry in the ROM pane. */
  readonly romLabel: string;
}

const MODEL_INFO: Record<Apple2Model, Apple2ModelInfo> = {
  apple2: {
    label: 'Apple ][',
    romSource: 'apple2/apple2.rom',
    charsetSource: 'apple2/chargen.rom',
    iie: false,
    cmos: false,
    iic: false,
    autostart: false,
    romLabel: 'System ROM (Integer BASIC + Monitor)',
  },
  'apple2-plus': {
    label: 'Apple ][+',
    romSource: 'apple2/apple2plus.rom',
    charsetSource: 'apple2/chargen.rom',
    iie: false,
    cmos: false,
    iic: false,
    autostart: true,
    romLabel: 'System ROM (Applesoft + Autostart Monitor)',
  },
  apple2e: {
    label: 'Apple //e',
    romSource: 'apple2/apple2e.rom',
    charsetSource: 'apple2/apple2e-video.rom',
    iie: true,
    cmos: false,
    iic: false,
    autostart: true,
    romLabel: 'System ROM (//e Monitor + Applesoft + 80-column firmware)',
  },
  'apple2e-enhanced': {
    label: 'Apple //e Enhanced',
    romSource: 'apple2/apple2e-enhanced.rom',
    charsetSource: 'apple2/apple2e-enhanced-video.rom',
    iie: true,
    cmos: true,
    iic: false,
    autostart: true,
    romLabel: 'System ROM (Enhanced //e Monitor + Applesoft + 80-column firmware)',
  },
  apple2c: {
    label: 'Apple //c',
    romSource: 'apple2/apple2c.rom',
    charsetSource: 'apple2/apple2e-enhanced-video.rom',
    iie: true,
    cmos: true,
    iic: true,
    autostart: true,
    romLabel: 'System ROM (//c Monitor + Applesoft + 80-column and port firmware)',
  },
};

export function apple2ModelInfo(model: string): Apple2ModelInfo {
  return MODEL_INFO[isApple2Model(model) ? model : 'apple2-plus'];
}

/** Size of the system ROM image mapped at $D000-$FFFF (Applesoft + Monitor). */
export const APPLE2_ROM_SIZE = 0x3000;
/** Size of the Disk II controller card ROM in slot 6 ($C600-$C6FF). */
export const DISK2_ROM_SIZE = 0x0100;
/** Size of the video character-generator ROM (256 glyphs × 8 rows). */
export const APPLE2_CHARGEN_SIZE = 0x0800;
