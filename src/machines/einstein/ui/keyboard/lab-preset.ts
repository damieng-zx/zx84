import type { KeyboardLabDocument, KeyboardLabKey } from '@/ui/keyboard-lab/types.ts';
import {
  E256_SCENE,
  TC01_SCENE,
  placeE256Keys,
  placeTc01Keys,
  type PlacedEinsteinKey,
} from './scene-geometry.ts';

/** The lab records one cell per key, so a chord contributes its own switch —
 *  the last entry, since any modifier is pressed alongside it. */
function labKey(item: PlacedEinsteinKey): KeyboardLabKey {
  return {
    id: item.key.id,
    box: { ...item.box },
    cell: item.key.chord[item.key.chord.length - 1],
    legends: { main: item.key.main, shift: item.key.shift },
    tone: item.key.tone,
    region: item.key.region,
    shape: item.hitClip ? 'custom' : 'rectangle',
    clipPath: item.hitClip,
  };
}

export function einsteinKeyboardLabPresets(): readonly KeyboardLabDocument[] {
  return [
    {
      version: 1,
      id: 'einstein-tc01',
      name: 'Tatung Einstein TC-01',
      theme: 'tc01',
      scene: TC01_SCENE,
      keys: placeTc01Keys().map(labKey),
    },
    {
      version: 1,
      id: 'einstein-256',
      name: 'Tatung Einstein 256',
      theme: 'e256',
      scene: E256_SCENE,
      keys: placeE256Keys().map(labKey),
    },
  ];
}
