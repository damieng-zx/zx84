import type { MachineModel } from '@/models.ts';

/** Sinclair's pre-Spectrum computers. */
export type Zx8xModel = 'zx80' | 'zx81';

export function isZx8xModel(model: MachineModel): model is Zx8xModel {
  return model === 'zx80' || model === 'zx81';
}
