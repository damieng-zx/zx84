/**
 * zx84's native BBC Micro snapshot (`.bbcstate`): the container is the shared
 * native one (machines/shared/native-state.ts) under the magic 'ZXBB';
 * the sections are `BbcMachine.saveState`'s. Not a format other BBC
 * emulators read: BeebEm's `.uefstate` and b2's saved states carry their own
 * internals, which have no counterpart here.
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';
import { isBbcModel } from '../models.ts';

export const BBC_STATE_SPEC: NativeStateSpec = {
  magic: 'ZXBB',
  version: 1,
  ext: '.bbcstate',
  machineName: 'BBC Micro',
  modelName: (model) => (isBbcModel(model) ? 'BBC Micro Model B' : null),
  // 32K of RAM, two double-sided 80-track discs and a long CSW tape, generously.
  maxBody: 128 << 20,
};
