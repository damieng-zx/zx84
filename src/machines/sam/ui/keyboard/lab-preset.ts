/**
 * The SAM face as a Keyboard Lab document, so its geometry can be nudged
 * visually and exported back into `scene-geometry.ts`.
 *
 * Derived from the live placement rather than duplicated, so the lab always
 * opens on exactly what the emulator draws.
 */

import type { KeyboardLabDocument, KeyboardLabShape } from '@/ui/keyboard-lab/types.ts';
import { placeSamKeys, SAM_SCENE, type PlacedSamKey } from './scene-geometry.ts';

function shapeOf(placed: PlacedSamKey): KeyboardLabShape {
  // RETURN is the only non-rectangular cap: an inverted L cut by a clip path.
  return placed.key.id === 'return' && placed.hitClip ? 'return' : 'rectangle';
}

export function samKeyboardLabPresets(): readonly KeyboardLabDocument[] {
  return [{
    version: 1,
    id: 'sam',
    name: 'MGT SAM Coupé',
    theme: 'sam',
    scene: { width: SAM_SCENE.width, height: SAM_SCENE.height },
    keys: placeSamKeys().map(placed => ({
      id: placed.key.id,
      box: { ...placed.box },
      cell: placed.key.cell,
      legends: {
        main: placed.key.main,
        // The SAM prints its secondary symbol ABOVE the main legend rather
        // than beside it; the lab's "shift" slot is the nearest thing it has.
        shift: placed.key.top,
      },
      tone: placed.key.dark ? 'dark' : 'cream',
      shape: shapeOf(placed),
      clipPath: placed.hitClip,
    })),
  }];
}
