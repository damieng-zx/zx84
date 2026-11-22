/**
 * Acorn System models.
 *
 *  - `acorn-system2`  the disc-less Eurocard system (1980): a 1 MHz 6502 CPU
 *                     card, the 40x25 teletext VDU card, an 8K RAM + 8K ROM
 *                     card with the resident 4K BASIC, and the cassette
 *                     operating system (COS) in a 2K ROM at &F800.
 *  - `acorn-system3`  the same cards with the 8271 floppy controller card
 *                     (200,004) at &0A00 and the 4K disc operating system at
 *                     &F000, which is what makes a System 3 a System 3.
 *  - `acorn-system4`  a System 3 in a double-height frame: two drives and a
 *                     second 8K RAM card at &4000.
 *  - `acorn-system5`  the last of the line: the buffered 2 MHz 6502A CPU card
 *                     with a 6522A in place of the 8154, 32K of dynamic RAM,
 *                     and the 80x25 character VDU card (CRTC at &1840, 2K of
 *                     screen RAM at &1000) instead of the teletext card.
 *
 * The four machines are the same backplane with different cards, so each model
 * carries the *card set* as data: clock, VDU card, keyboard chip, and where the
 * RAM and ROM cards sit. The machine, memory map and renderer read that rather
 * than branching on the model.
 */

export type AcornSystemModel =
  | 'acorn-system2' | 'acorn-system3' | 'acorn-system4' | 'acorn-system5';

export function isAcornSystemModel(model: string): model is AcornSystemModel {
  return model === 'acorn-system2' || model === 'acorn-system3'
    || model === 'acorn-system4' || model === 'acorn-system5';
}

/** A RAM card: its base address and size (the 8K and 32K cards). */
export interface RamCard {
  readonly base: number;
  readonly size: number;
}

export interface AcornSystemModelInfo {
  /** Name shown in the UI. */
  readonly label: string;
  /** System-ROM image on the ROM host: the COS/kernel (2K) or the DOS (4K). */
  readonly romSource: string;
  /** The resident 4K BASIC, or '' when the machine loads BASIC from disc. */
  readonly basicSource: string;
  /** Label for the system-ROM entry in the ROM pane. */
  readonly romLabel: string;

  /** CPU clock: 1 MHz on the 6502 cards, 2 MHz on the 6502A. */
  readonly clockHz: number;
  /** Static RAM on the CPU card, from &0000. */
  readonly mainRamSize: number;
  /** The VDU card fitted. */
  readonly vdu: 'teletext40' | 'mono80';
  /** The keyboard chip on the CPU card. */
  readonly keyboardChip: 'ins8154' | 'm6522';
  /** The 8271 floppy controller card (200,004) is fitted at &0A00. */
  readonly disk: boolean;
  /** RAM cards beyond the CPU card's own RAM. */
  readonly ramCards: readonly RamCard[];
  /** The 8K RAM + 8K ROM card's BASIC PROM at &C000, when fitted. */
  readonly basicFitted: boolean;
}

const MODEL_INFO: Record<AcornSystemModel, AcornSystemModelInfo> = {
  'acorn-system2': {
    label: 'Acorn System 2',
    romSource: 'acorn-system/syscos40.rom',
    basicSource: 'acorn-system/system-basic.rom',
    romLabel: 'COS ROM (Acorn Cassette OS)',
    clockHz: 1_000_000,
    mainRamSize: 0x0400,
    vdu: 'teletext40',
    keyboardChip: 'ins8154',
    disk: false,
    ramCards: [{ base: 0x2000, size: 0x2000 }],
    basicFitted: true,
  },
  'acorn-system3': {
    label: 'Acorn System 3',
    romSource: 'acorn-system/sysdos40.rom',
    basicSource: 'acorn-system/system-basic.rom',
    romLabel: 'DOS ROM (Acorn DOS + kernel)',
    clockHz: 1_000_000,
    mainRamSize: 0x0400,
    vdu: 'teletext40',
    keyboardChip: 'ins8154',
    disk: true,
    ramCards: [{ base: 0x2000, size: 0x2000 }],
    basicFitted: true,
  },
  'acorn-system4': {
    label: 'Acorn System 4',
    romSource: 'acorn-system/sysdos40.rom',
    basicSource: 'acorn-system/system-basic.rom',
    romLabel: 'DOS ROM (Acorn DOS + kernel)',
    clockHz: 1_000_000,
    mainRamSize: 0x0400,
    vdu: 'teletext40',
    keyboardChip: 'ins8154',
    disk: true,
    ramCards: [{ base: 0x2000, size: 0x2000 }, { base: 0x4000, size: 0x2000 }],
    basicFitted: true,
  },
  'acorn-system5': {
    label: 'Acorn System 5',
    romSource: 'acorn-system/sysdos80.rom',
    // The 80-column systems load BASIC from disc into the dynamic RAM.
    basicSource: '',
    romLabel: 'DOS ROM (Acorn DOS + kernel, 80 column)',
    clockHz: 2_000_000,
    mainRamSize: 0x0800,
    vdu: 'mono80',
    keyboardChip: 'm6522',
    disk: true,
    // A fully populated 32K dynamic RAM card (&2000-&9FFF) plus a half
    // populated one (&A000-&DFFF): 48K, which is the space the DOS leaves for
    // programs and where it loads BASIC (PAGE &3000, HIMEM &A000).
    ramCards: [{ base: 0x2000, size: 0x8000 }, { base: 0xA000, size: 0x4000 }],
    basicFitted: false,
  },
};

export function acornSystemModelInfo(model: string): AcornSystemModelInfo {
  return MODEL_INFO[isAcornSystemModel(model) ? model : 'acorn-system2'];
}
