import type { KeyboardLabDocument } from '@/ui/keyboard-lab/types.ts';
import { MTX_SCENE, placeMtxKeys } from './scene-geometry.ts';

export function mtxKeyboardLabPresets(): readonly KeyboardLabDocument[] {
  return [{
    version: 1,
    id: 'memotech-mtx',
    name: 'Memotech MTX',
    theme: 'mtx',
    scene: MTX_SCENE,
    keys: placeMtxKeys().map((item) => ({
      id: item.key.id,
      box: { ...item.box },
      cell: item.key.cell,
      legends: { main: item.key.main, shift: item.key.shift },
      region: item.key.region,
      shape: 'rectangle' as const,
    })),
  }];
}
