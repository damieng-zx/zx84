import type { KeyboardLabDocument } from '@/ui/keyboard-lab/types.ts';
import type { AtariKeyDef } from './layout.ts';
import { ATARI400_SCENE, placeAtari400Keys } from './scene-geometry.ts';
import { ATARI_XL_FACES, type AtariXlVariant } from './xl-geometry.ts';
import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';

function labKeys(placed: readonly { key: AtariKeyDef; box: SceneBox }[]): KeyboardLabDocument['keys'] {
  return placed.map((item) => ({
    id: item.key.id,
    box: { ...item.box },
    legends: {
      main: item.key.main,
      shift: item.key.shift,
      aux: item.key.aux,
    },
    tone: item.key.tone,
    shape: 'rectangle',
  }));
}

function xlPreset(variant: AtariXlVariant, id: string, name: string): KeyboardLabDocument {
  const face = ATARI_XL_FACES[variant];
  return {
    version: 1,
    id,
    name,
    theme: 'atarixl',
    scene: face.scene,
    keys: labKeys(face.keys),
  };
}

export function atariKeyboardLabPresets(): readonly KeyboardLabDocument[] {
  return [
    {
      version: 1,
      id: 'atari-400',
      name: 'Atari 400',
      theme: 'atari400',
      scene: ATARI400_SCENE,
      keys: labKeys(placeAtari400Keys()),
    },
    xlPreset('xl', 'atari-800xl', 'Atari 600XL / 800XL / XE'),
    xlPreset('1200xl', 'atari-1200xl', 'Atari 1200XL'),
  ];
}
