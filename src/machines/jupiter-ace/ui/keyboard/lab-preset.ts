import type {
  KeyboardLabDocument,
  KeyboardLabKey,
} from '@/ui/keyboard-lab/types.ts';
import { ACE_ROWS } from './legends.ts';
import { ACE_SCENE, placeAceRows } from './scene-geometry.ts';

const slug = (value: string) =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'key';

export function aceKeyboardLabPresets(): readonly KeyboardLabDocument[] {
  return [{
    version: 1,
    id: 'jupiter-ace',
    name: 'Jupiter Ace',
    theme: 'jupiter-ace',
    scene: ACE_SCENE,
    keys: placeAceRows(ACE_ROWS).map(({ key, cap }): KeyboardLabKey => ({
      id: slug(key.main),
      box: { ...cap },
      cell: key.pos,
      legends: { main: key.main, shift: key.symbol, aux: key.shiftFn },
      tone: 'dark',
      region: key.kind,
      shape: 'rectangle',
    })),
  }];
}
