/**
 * zx84's native Acorn Electron snapshot (`.elkstate`): the container is the
 * shared native one (machines/shared/native-state.ts) under the magic
 * 'ZXEL'; the sections are `ElectronMachine.saveState`'s. Not a format other
 * Electron emulators read (ElectrEm's and Elkulator's states carry their own
 * internals, which have no counterpart here).
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';
import { isElectronModel } from '../models.ts';

export const ELECTRON_STATE_SPEC: NativeStateSpec = {
  magic: 'ZXEL',
  version: 1,
  ext: '.elkstate',
  machineName: 'Acorn Electron',
  modelName: (model) => (isElectronModel(model) ? 'Acorn Electron' : null),
  // 32K of RAM, a cartridge, two double-sided ADFS discs and a long CSW tape, generously.
  maxBody: 128 << 20,
};
