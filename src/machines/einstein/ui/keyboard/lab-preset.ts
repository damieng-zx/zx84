import type { KeyboardLabDocument } from '@/ui/keyboard-lab/types.ts';
import { TC01_SCENE, placeTc01Keys } from './scene-geometry.ts';

export function tc01KeyboardLabPresets(): readonly KeyboardLabDocument[] {
  return [{
    version: 1,
    id: 'einstein-tc01',
    name: 'Tatung Einstein TC-01',
    theme: 'tc01',
    scene: TC01_SCENE,
    keys: placeTc01Keys().map((item) => ({
      id: item.key.id,
      box: { ...item.box },
      cell: item.key.cell,
      legends: {
        main: item.key.main,
        shift: item.key.shift,
      },
      tone: item.key.tone,
      region: item.key.region,
      shape: 'rectangle',
    })),
  }];
}
