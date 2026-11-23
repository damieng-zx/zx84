/**
 * Oric family models.
 *
 * The Oric-1 and the Atmos are the same motherboard with two differences: the
 * system ROM in the socket (BASIC 1.0 against BASIC 1.1b) and the keyboard,
 * which gained a Funct key. Everything else — the ULA, the VIA, the PSG, the
 * cassette interface — is identical. Both model ids exist so the ROM pane's
 * socket can be pinned to the right firmware, and so a dropped 16 KB image can
 * be classified by its contents.
 */

export type OricModel = 'atmos' | 'oric1';

export function isOricModel(model: string): model is OricModel {
  return model === 'atmos' || model === 'oric1';
}

export interface OricModelInfo {
  /** Full name, as the model box shows it. */
  readonly label: string;
  /** Year of release. */
  readonly released: number;
  /** The system ROM the socket is expected to hold. */
  readonly romLabel: string;
  /** The keyboard has the Atmos's Funct key (row 5, column 4). */
  readonly functKey: boolean;
  /** Default system-ROM sources, in the order `romSources` concatenates them. */
  readonly romSources: readonly string[];
}

const ATMOS_INFO: OricModelInfo = {
  label: 'Oric Atmos',
  released: 1984,
  romLabel: 'BASIC 1.1b (Atmos)',
  functKey: true,
  romSources: ['oric/basic11b.rom'],
};

const ORIC1_INFO: OricModelInfo = {
  label: 'Oric-1',
  released: 1983,
  romLabel: 'BASIC 1.0 (Oric-1)',
  functKey: false,
  romSources: ['oric/basic10.rom'],
};

const ORIC_INFO: Record<OricModel, OricModelInfo> = {
  atmos: ATMOS_INFO,
  oric1: ORIC1_INFO,
};

export function oricModelInfo(model: OricModel): OricModelInfo {
  return ORIC_INFO[model] ?? ATMOS_INFO;
}

/** The ROM pane's label for this model's system socket. */
export function oricRomLabel(model: OricModel): string {
  return oricModelInfo(model).romLabel;
}
