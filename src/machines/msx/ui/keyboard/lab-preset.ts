import type { KeyboardLabDocument } from '@/ui/keyboard-lab/types.ts';
import { HX10_SCENE, placeHx10Keys } from './scene-geometry.ts';

export function hx10KeyboardLabPresets(): readonly KeyboardLabDocument[] {
  return [{
    version: 1,
    id: 'toshiba-hx10',
    name: 'Toshiba HX-10',
    theme: 'hx10',
    scene: HX10_SCENE,
    keys: placeHx10Keys().map((item) => ({
      id: item.key.id,
      box: { ...item.box },
      cell: item.key.cell,
      legends: {
        main: item.key.main,
        shift: item.key.shift,
        aux: item.key.aux,
      },
      tone: item.key.tone,
      region: item.key.region,
      shape: item.key.id === 'return' ? 'return' : 'rectangle',
      clipPath: item.hitClip,
    })),
  }];
}
