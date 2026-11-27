/**
 * zx84's native Acorn Atom snapshot (`.atmstate`): the shared native container
 * (machines/shared/native-state.ts) under the magic 'ZXAT'; the sections are
 * `AtomMachine.saveState`'s.
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';
import { isAtomModel } from '../models.ts';

export const ATOM_STATE_SPEC: NativeStateSpec = {
  magic: 'ZXAT',
  version: 1,
  ext: '.atmstate',
  machineName: 'Acorn Atom',
  modelName: (model) => (isAtomModel(model) ? 'Acorn Atom' : null),
  // 64K address space plus the ROM images, generously.
  maxBody: 64 << 20,
};
