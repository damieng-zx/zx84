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
 *
 * The System 4 is a System 3 in a taller frame with more slots, and the System 5
 * is a different CPU card, so both are further members of this family rather
 * than new folders.
 */

export type AcornSystemModel = 'acorn-system2' | 'acorn-system3';

export function isAcornSystemModel(model: string): model is AcornSystemModel {
  return model === 'acorn-system2' || model === 'acorn-system3';
}

export interface AcornSystemModelInfo {
  /** Name shown in the UI. */
  readonly label: string;
  /** System-ROM image on the ROM host: the COS/kernel (2K) or the DOS (4K). */
  readonly romSource: string;
  /** The 4K integer BASIC from the 8K RAM + 8K ROM card (loaded at &C000). */
  readonly basicSource: string;
  /** Label for the system-ROM entry in the ROM pane. */
  readonly romLabel: string;
  /** Columns and rows the VDU card displays. */
  readonly columns: number;
  readonly rows: number;
  /** The 8271 floppy controller card (200,004) is fitted at &0A00. */
  readonly disk: boolean;
}

const MODEL_INFO: Record<AcornSystemModel, AcornSystemModelInfo> = {
  'acorn-system2': {
    label: 'Acorn System 2',
    romSource: 'acorn-system/syscos40.rom',
    basicSource: 'acorn-system/system-basic.rom',
    romLabel: 'COS ROM (Acorn Cassette OS)',
    columns: 40,
    rows: 25,
    disk: false,
  },
  'acorn-system3': {
    label: 'Acorn System 3',
    romSource: 'acorn-system/sysdos40.rom',
    basicSource: 'acorn-system/system-basic.rom',
    romLabel: 'DOS ROM (Acorn DOS + kernel)',
    columns: 40,
    rows: 25,
    disk: true,
  },
};

export function acornSystemModelInfo(model: string): AcornSystemModelInfo {
  return MODEL_INFO[isAcornSystemModel(model) ? model : 'acorn-system2'];
}
