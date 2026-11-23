/**
 * zx84's native Oric snapshot (`.oricstate`): the shared native container
 * (machines/shared/native-state.ts) under the magic 'ZXOR'; the sections are
 * `OricMachine.saveState`'s.
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';
import { isOricModel, oricModelInfo } from '../models.ts';

export const ORIC_STATE_SPEC: NativeStateSpec = {
  magic: 'ZXOR',
  version: 1,
  ext: '.oricstate',
  machineName: 'Oric',
  modelName: (model) => (isOricModel(model) ? oricModelInfo(model).label : null),
  // 64K address space plus both ROM chips, generously.
  maxBody: 64 << 20,
};
