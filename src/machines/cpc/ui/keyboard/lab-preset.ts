import type {
  KeyboardLabDocument,
  KeyboardLabShape,
} from '@/ui/keyboard-lab/types.ts';
import {
  CPC464_SCENE,
  CPC6128_SCENE,
  CPC664_SCENE,
  placeCpc464Keys,
  placeCpc6128Keys,
  placeCpc664Keys,
  type PlacedCpcKey,
} from './scene-geometry.ts';
import {
  cpcKeyMain,
  isCpc664BlueKey,
  type CpcKeyboardVariant,
} from './variants.ts';

function keyShape(placed: PlacedCpcKey): KeyboardLabShape {
  if (placed.key.id === 'return' && placed.hitClip) return 'return';
  if (!placed.hitClip) return 'rectangle';
  if (placed.key.id === 'cursor-up') return 'wedge-up';
  if (placed.key.id === 'cursor-down') return 'wedge-down';
  if (placed.key.id === 'cursor-left') return 'wedge-left';
  if (placed.key.id === 'cursor-right') return 'wedge-right';
  return 'custom';
}

function preset(
  variant: CpcKeyboardVariant,
  name: string,
  scene: { readonly width: number; readonly height: number },
  placed: readonly PlacedCpcKey[],
): KeyboardLabDocument {
  return {
    version: 1,
    id: variant,
    name,
    theme: variant,
    scene,
    keys: placed.map((item) => ({
      id: item.key.id,
      box: { ...item.box },
      cell: item.key.cell,
      legends: {
        main: cpcKeyMain(item.key, variant),
        shift: item.key.shift,
        aux: item.key.fn,
      },
      tone: variant === 'cpc6128'
        ? 'cream'
        : variant === 'cpc664' && isCpc664BlueKey(item.key)
          ? 'blue'
          : item.key.tone,
      region: item.region,
      shape: keyShape(item),
      clipPath: item.hitClip,
    })),
  };
}

export function cpcKeyboardLabPresets(): readonly KeyboardLabDocument[] {
  return [
    preset('cpc464', 'Amstrad CPC 464', CPC464_SCENE, placeCpc464Keys()),
    preset('cpc664', 'Amstrad CPC 664', CPC664_SCENE, placeCpc664Keys()),
    preset('cpc6128', 'Amstrad CPC 6128', CPC6128_SCENE, placeCpc6128Keys()),
  ];
}
