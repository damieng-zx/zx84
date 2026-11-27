import type { MachineModel } from '@/models.ts';

/**
 * Sinclair's pre-Spectrum computers and their US licensee's rebadges: the
 * Timex Sinclair 1000 is a ZX81 with 2K of RAM and an NTSC picture, the 1500
 * the same with 16K soldered in.
 */
export type Zx8xModel = 'zx80' | 'zx81' | 'ts1000' | 'ts1500';

export function isZx8xModel(model: MachineModel): model is Zx8xModel {
  return model === 'zx80' || model === 'zx81' || model === 'ts1000' || model === 'ts1500';
}

/** The ZX80, whose ROM, keyboard and tape format differ from every other model
 *  here (which all run the ZX81 ROM). */
export function isZx80(model: MachineModel): boolean { return model === 'zx80'; }

/** True for the ZX81 and its Timex Sinclair rebadges: the 8K ROM, the NMI-driven
 *  display, and the expansion hardware (printer, Chroma, hi-res boards) that
 *  only ever worked with them. */
export function isZx81Class(model: MachineModel): boolean {
  return model === 'zx81' || model === 'ts1000' || model === 'ts1500';
}

/** True for the US-market models: a 60 Hz, 262-line picture instead of the
 *  British 50 Hz, 312 lines. */
export function isZx8xNtsc(model: MachineModel): boolean { return model === 'ts1000' || model === 'ts1500'; }

/** Kilobytes of RAM the board carries before any RAM pack: 1K on the ZX80 and
 *  ZX81, 2K on the TS1000, 16K on the TS1500. */
export function zx8xBuiltinRamKb(model: MachineModel): 1 | 2 | 16 {
  return model === 'ts1500' ? 16 : model === 'ts1000' ? 2 : 1;
}

/** Whether the 16K RAM pack can be fitted: not on the TS1500, which already
 *  has the RAM, nor on a model with nothing to plug it into. */
export function zx8xTakesRamPack(model: MachineModel): boolean {
  return isZx8xModel(model) && model !== 'ts1500';
}

/** Which of the two software libraries a model draws on: the ZX80's own, or the
 *  ZX81's (which every Timex Sinclair model runs). */
export function zx8xLibraryModel(model: Zx8xModel): 'zx80' | 'zx81' {
  return model === 'zx80' ? 'zx80' : 'zx81';
}

/** Display names, for snapshots and the model menu's neighbours. */
export const ZX8X_MODEL_NAMES: Readonly<Record<Zx8xModel, string>> = {
  zx80: 'ZX80',
  zx81: 'ZX81',
  ts1000: 'Timex Sinclair 1000',
  ts1500: 'Timex Sinclair 1500',
};
