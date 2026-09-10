import type { KeyboardLabDocument } from '@/ui/keyboard-lab/types.ts';
import { LYNX_SCENE, placeLynxKeys } from './scene-geometry.ts';

export function lynxKeyboardLabPresets(): readonly KeyboardLabDocument[] {
  return [{
    version: 1,
    id: 'camputers-lynx',
    name: 'Camputers Lynx',
    theme: 'lynx',
    scene: LYNX_SCENE,
    keys: placeLynxKeys().map((item) => ({
      id: item.key.id,
      box: { ...item.box },
      // BREAK is not a matrix key, so it goes to the editor without a cell.
      ...(item.key.cell ? { cell: item.key.cell } : {}),
      legends: { main: item.key.main, shift: item.key.shift },
      region: item.key.region,
      shape: 'rectangle' as const,
    })),
  }];
}
