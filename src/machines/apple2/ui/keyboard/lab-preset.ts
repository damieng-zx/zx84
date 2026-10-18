import type { KeyboardLabDocument } from '@/ui/keyboard-lab/types.ts';
import type { Apple2KeyboardVariant } from './layout.ts';
import { apple2Scene, placeApple2Keys } from './scene-geometry.ts';

const PRESETS: readonly { variant: Apple2KeyboardVariant; id: string; name: string }[] = [
  { variant: 'apple2', id: 'apple2', name: 'Apple ][ / ][+' },
  { variant: 'apple2e', id: 'apple2e', name: 'Apple //e' },
  { variant: 'apple2c', id: 'apple2c', name: 'Apple //c' },
];

export function apple2KeyboardLabPresets(): readonly KeyboardLabDocument[] {
  return PRESETS.map(({ variant, id, name }) => {
    const scene = apple2Scene(variant);
    return {
      version: 1,
      id,
      name,
      theme: 'neutral',
      scene: { width: scene.width, height: scene.height },
      keys: placeApple2Keys(variant).map((item) => ({
        id: item.key.id,
        box: { ...item.box },
        legends: {
          main: item.key.main.replace('\n', ' '),
          shift: item.key.shift,
          aux: item.key.aux,
        },
        region: item.key.region,
        shape: 'rectangle',
      })),
    };
  });
}
