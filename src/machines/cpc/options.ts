/**
 * CPC Hardware-pane options: which CRTC is fitted, RAM expansion, the DDI-1
 * disk interface on the 464, and the PPI configuration links.
 *
 * Read from the shared settings (see `store/settings.ts`) when the machine is
 * prepared, so changing one rebuilds the machine. The Plus range keeps its
 * ASIC-integrated CRTC and 128K whatever these say; the links apply to every
 * model.
 */

import type { SettingsView } from '@/machines/machine.ts';
import type { CpcModel } from './models.ts';

/** CRTC types offered on the 464/664/6128 (CPCWiki numbering): 0 HD6845S /
 *  UM6845, 1 UM6845R, 2 MC6845, 3 AMS40489 behaviour (the cost-down 6128's
 *  Pre-ASIC, type 4, behaves identically). */
export const CPC_CRTC_TYPES = [0, 1, 2, 3] as const;
export type CpcCrtcChoice = typeof CPC_CRTC_TYPES[number];

/** Dk'tronics-compatible RAM expansion sizes, in KB (0 = none). */
export const CPC_RAM_EXPANSIONS = [0, 256, 512] as const;
export type CpcRamExpansion = typeof CPC_RAM_EXPANSIONS[number];

/**
 * The distributor names selected by links LK1–LK3 and read on PPI Port B bits
 * 1–3 (CPCWiki "8255"). The firmware prints the name in its sign-on banner.
 */
export const CPC_MANUFACTURERS = [
  { id: 'amstrad', label: 'Amstrad', code: 7 },
  { id: 'orion', label: 'Orion', code: 6 },
  { id: 'schneider', label: 'Schneider', code: 5 },
  { id: 'awa', label: 'Awa', code: 4 },
  { id: 'solavox', label: 'Solavox', code: 3 },
  { id: 'saisho', label: 'Saisho', code: 2 },
  { id: 'triumph', label: 'Triumph', code: 1 },
  { id: 'isp', label: 'Isp', code: 0 },
] as const;
export type CpcManufacturer = typeof CPC_MANUFACTURERS[number]['id'];

export interface CpcOptions {
  /** CRTC type on the 464/664/6128 (the Plus is always 3). */
  readonly crtcType: CpcCrtcChoice;
  /** RAM expansion fitted to a 464/664/6128, in KB. */
  readonly ramExpansionKb: CpcRamExpansion;
  /** DDI-1 disk interface (uPD765A + AMSDOS in ROM 7) on a 464. */
  readonly ddi1: boolean;
  /** Distributor code on PPI Port B bits 1–3 (LK1–LK3). */
  readonly manufacturerCode: number;
  /** LK4: true = 50 Hz (Port B bit 4 set), false = 60 Hz. */
  readonly fiftyHz: boolean;
}

export const CPC_DEFAULT_OPTIONS: CpcOptions = {
  crtcType: 0,
  ramExpansionKb: 0,
  ddi1: false,
  manufacturerCode: 7,
  fiftyHz: true,
};

export function parseCpcCrtcType(value: unknown): CpcCrtcChoice {
  const n = Number(value);
  return (CPC_CRTC_TYPES as readonly number[]).includes(n) ? n as CpcCrtcChoice : CPC_DEFAULT_OPTIONS.crtcType;
}

/** '256k' → 256; anything unrecognised (including 'none') → no expansion. */
export function parseCpcRamExpansion(value: unknown): CpcRamExpansion {
  const kb = parseInt(String(value), 10);
  return (CPC_RAM_EXPANSIONS as readonly number[]).includes(kb) ? kb as CpcRamExpansion : 0;
}

export function manufacturerCodeOf(id: unknown): number {
  return CPC_MANUFACTURERS.find(m => m.id === id)?.code ?? CPC_DEFAULT_OPTIONS.manufacturerCode;
}

/** Whether a model can take the DDI-1 (the 464, which has no disk controller). */
export function cpcTakesDdi1(model: CpcModel): boolean {
  return model === 'cpc464';
}

/** Whether a model takes the CRTC choice and a RAM expansion (not the Plus). */
export function cpcTakesClassicOptions(model: CpcModel): boolean {
  return model === 'cpc464' || model === 'cpc664' || model === 'cpc6128';
}

export function readCpcOptions(view: SettingsView): CpcOptions {
  return {
    crtcType: parseCpcCrtcType(view.get('cpc-crtc-type', String(CPC_DEFAULT_OPTIONS.crtcType))),
    ramExpansionKb: parseCpcRamExpansion(view.get('cpc-ram-expansion', 'none')),
    ddi1: view.get('cpc-ddi1', CPC_DEFAULT_OPTIONS.ddi1),
    manufacturerCode: manufacturerCodeOf(view.get('cpc-manufacturer', 'amstrad')),
    fiftyHz: view.get<string>('cpc-refresh', '50') !== '60',
  };
}
