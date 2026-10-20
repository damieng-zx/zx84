/**
 * Apple I models.
 *
 *  - `apple1`  the Apple-1 (1976): a 6502, the Woz Monitor in a 256-byte PROM, a
 *              PIA joining an ASCII keyboard to a 40×24 video terminal, and 4K or 8K
 *              of RAM on the board. Software arrives by typing it in at the Monitor
 *              or from the optional Apple Cassette Interface.
 */

export type Apple1Model = 'apple1';

export function isApple1Model(model: string): model is Apple1Model {
  return model === 'apple1';
}

export interface Apple1ModelInfo {
  /** Name shown in the UI. */
  readonly label: string;
  /** System-ROM image on the ROM host: the 256-byte Woz Monitor. */
  readonly romSource: string;
  /** Video character-generator ROM on the ROM host: the 2513, shared with the Apple ][. */
  readonly charsetSource: string;
  /** Label for the system-ROM entry in the ROM pane. */
  readonly romLabel: string;
}

const MODEL_INFO: Record<Apple1Model, Apple1ModelInfo> = {
  apple1: {
    label: 'Apple I',
    romSource: 'apple1/apple1.rom',
    charsetSource: 'apple2/chargen.rom',
    romLabel: 'System ROM (Woz Monitor)',
  },
};

export function apple1ModelInfo(model: string): Apple1ModelInfo {
  return MODEL_INFO[isApple1Model(model) ? model : 'apple1'];
}
