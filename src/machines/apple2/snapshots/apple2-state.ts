/**
 * zx84's native Apple II snapshot (`.a2state`), for every model (][, ][+,
 * //e, //e Enhanced, //c): the container is the shared native one (see
 * machines/shared/native-state.ts) under the magic 'ZXA2'; the sections are
 * `Apple2Machine.saveState`'s. A state names its model, and loading one on
 * another model switches to it first. Not a format other Apple II emulators
 * read (AppleWin's `.aws.yaml` carries its own internals).
 */

import type { NativeStateSpec } from '@/machines/shared/native-state.ts';
import { apple2ModelInfo, isApple2Model } from '../models.ts';

export const APPLE2_STATE_SPEC: NativeStateSpec = {
  magic: 'ZXA2',
  version: 1,
  ext: '.a2state',
  machineName: 'Apple II',
  modelName: (model) => (isApple2Model(model) ? apple2ModelInfo(model).label : null),
  // 128K of RAM, two 140K disks with their nibble tracks and a long
  // cassette as comparator runs, generously.
  maxBody: 64 << 20,
};
