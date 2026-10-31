/**
 * zx84's native Apple I snapshot (`.a1state`): the container is the shared
 * native one (machines/shared/native-state.ts) under the magic 'ZXA1'; the
 * sections are `Apple1Machine.saveState`'s.
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';
import { isApple1Model } from '../models.ts';

export const APPLE1_STATE_SPEC: NativeStateSpec = {
  magic: 'ZXA1',
  version: 1,
  ext: '.a1state',
  machineName: 'Apple I',
  modelName: (model) => (isApple1Model(model) ? 'Apple I' : null),
  // 64K of address space and a long cassette, as comparator runs, generously.
  maxBody: 64 << 20,
};
