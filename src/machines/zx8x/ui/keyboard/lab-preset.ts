import type {
  KeyboardLabDocument,
  KeyboardLabKey,
} from '@/ui/keyboard-lab/types.ts';
import type { Zx8xModel } from '@/machines/zx8x/models.ts';
import { rowsForModel } from './legends.ts';
import { placeZx8xRows, zx8xScene } from './scene-geometry.ts';

function documentFor(model: Zx8xModel): KeyboardLabDocument {
  const rows = rowsForModel(model);
  const placed = placeZx8xRows(rows, model);
  return {
    version: 1,
    id: model,
    name: model === 'zx80' ? 'Sinclair ZX80' : 'Sinclair ZX81',
    theme: model,
    scene: zx8xScene(model),
    keys: placed.map(({ key, cap }, index): KeyboardLabKey => ({
      id: `${key.main.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'key'}-${index + 1}`,
      box: { ...cap },
      cell: key.pos,
      legends: {
        main: key.main,
        shift: [key.capFn, key.shift].filter(Boolean).join(' · ') || undefined,
        aux: [key.keyword, key.func].filter(Boolean).join(' · ') || undefined,
      },
      tone: model === 'zx80' ? 'blue' : 'cream',
      region: 'main',
      shape: 'rectangle',
    })),
  };
}

export function zx8xKeyboardLabPresets(): readonly KeyboardLabDocument[] {
  return [documentFor('zx80'), documentFor('zx81')];
}
