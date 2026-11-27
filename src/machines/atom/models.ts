/**
 * Acorn Atom models.
 *
 * The Atom shipped in one system board; the meaningful differences are the
 * fitted RAM chips (2 KB standard, 12 KB fully expanded) and the optional
 * utility/DOS ROMs, which are hardware options rather than models. One model
 * therefore covers the standard machine, with the RAM size chosen in the
 * Hardware pane.
 */

export type AtomModel = 'atom';

export function isAtomModel(model: string): model is AtomModel {
  return model === 'atom';
}

export interface AtomModelInfo {
  /** Name shown in the UI. */
  readonly label: string;
  /** The system-ROM images, concatenated in this order: BASIC, floating point,
   *  kernel (the standard 12 KB set). */
  readonly romSources: readonly string[];
  readonly romLabel: string;
}

const ATOM_INFO: AtomModelInfo = {
  label: 'Acorn Atom',
  // The three standard Acorn system ROMs, hosted on the zx84 ROM CDN. A user
  // image can replace the combined 12 KB set from the ROM pane. Keep the
  // basenames stable for the on-disk/MCP cache.
  romSources: [
    'acorn/atom-basic.rom',
    'acorn/atom-float.rom',
    'acorn/atom-kernel.rom',
  ],
  romLabel: 'System ROM (BASIC + floating point + kernel)',
};

export function atomModelInfo(_model: string): AtomModelInfo {
  return ATOM_INFO;
}
