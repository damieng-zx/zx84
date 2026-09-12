import type { KeyboardLabDocument } from '@/ui/keyboard-lab/types.ts';
import { PCW_SCENE, placePcwKeys } from './scene-geometry.ts';

export function pcwKeyboardLabPresets(): readonly KeyboardLabDocument[] {
  return [{
    version: 1,
    id: 'amstrad-pcw',
    name: 'Amstrad PCW',
    theme: 'pcw',
    scene: PCW_SCENE,
    keys: placePcwKeys().map((item) => ({
      id: item.key.id,
      box: { ...item.box },
      cell: item.key.cell,
      legends: { main: item.key.main, shift: item.key.shift ?? item.key.fn },
      region: item.key.region,
      // RETURN is the only cap that is not a plain rectangle.
      shape: item.hitClip ? ('return' as const) : ('rectangle' as const),
      ...(item.hitClip ? { clipPath: item.hitClip } : {}),
    })),
  }];
}
