/**
 * Acorn System models.
 *
 *  - `acorn-system2`  the disc-less Eurocard system (1980): a 1 MHz 6502 CPU
 *                     card, the 40x25 teletext VDU card, an 8K RAM + 8K ROM
 *                     card with the resident 4K BASIC, and the cassette
 *                     operating system (COS) in a 2K ROM at &F800. Software
 *                     arrives from cassette or the keyboard.
 *
 * The System 3/4 add the 8271 floppy controller and its 4K DOS at &F000; the
 * System 5 is a different CPU card entirely. Both are planned as further
 * members of this family, which is why the model info carries the ROM layout
 * rather than assuming one image shape.
 */

export type AcornSystemModel = 'acorn-system2';

export function isAcornSystemModel(model: string): model is AcornSystemModel {
  return model === 'acorn-system2';
}

export interface AcornSystemModelInfo {
  /** Name shown in the UI. */
  readonly label: string;
  /** System-ROM image on the ROM host: the 2K COS/kernel (loaded at &F800). */
  readonly romSource: string;
  /** The 4K integer BASIC from the 8K RAM + 8K ROM card (loaded at &C000). */
  readonly basicSource: string;
  /** Label for the system-ROM entry in the ROM pane. */
  readonly romLabel: string;
  /** Columns and rows the VDU card displays. */
  readonly columns: number;
  readonly rows: number;
}

const MODEL_INFO: Record<AcornSystemModel, AcornSystemModelInfo> = {
  'acorn-system2': {
    label: 'Acorn System 2',
    romSource: 'acorn-system/syscos40.rom',
    basicSource: 'acorn-system/system-basic.rom',
    romLabel: 'COS ROM (Acorn Cassette OS)',
    columns: 40,
    rows: 25,
  },
};

export function acornSystemModelInfo(model: string): AcornSystemModelInfo {
  return MODEL_INFO[isAcornSystemModel(model) ? model : 'acorn-system2'];
}
