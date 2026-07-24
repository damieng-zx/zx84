import type {
  KeyboardLabDocument,
  KeyboardLabKey,
  KeyboardLabShape,
} from './types.ts';
import type { SceneBox } from '../components/KeyboardScene.tsx';

const SHAPE_CLIPS: Readonly<Record<Exclude<KeyboardLabShape, 'custom'>, string | undefined>> = {
  rectangle: undefined,
  return: 'polygon(0 0, 100% 0, 100% 100%, 18% 100%, 18% 48%, 0 48%)',
  'wedge-up': 'polygon(0 0, 100% 0, 65% 100%, 35% 100%)',
  'wedge-down': 'polygon(35% 0, 65% 0, 100% 100%, 0 100%)',
  'wedge-left': 'polygon(0 0, 100% 35%, 100% 65%, 0 100%)',
  'wedge-right': 'polygon(0 35%, 100% 0, 100% 100%, 0 65%)',
};

export function shapeClip(shape: KeyboardLabShape): string | undefined {
  return shape === 'custom' ? undefined : SHAPE_CLIPS[shape];
}

export function cloneDocument(document: KeyboardLabDocument): KeyboardLabDocument {
  return {
    ...document,
    scene: { ...document.scene },
    reference: document.reference ? { ...document.reference } : undefined,
    keys: document.keys.map((key) => ({
      ...key,
      box: { ...key.box },
      cell: key.cell ? [...key.cell] as const : undefined,
      legends: { ...key.legends },
    })),
  };
}

export function snapValue(value: number, grid: number): number {
  if (!Number.isFinite(value)) return 0;
  if (!Number.isFinite(grid) || grid <= 0) return value;
  return Math.round(value / grid) * grid;
}

export type AlignMode =
  | 'left'
  | 'center'
  | 'right'
  | 'top'
  | 'middle'
  | 'bottom';

export function alignKeys(
  keys: readonly KeyboardLabKey[],
  selectedIds: ReadonlySet<string>,
  mode: AlignMode,
): KeyboardLabKey[] {
  const selected = keys.filter((key) => selectedIds.has(key.id));
  if (selected.length < 2) return [...keys];
  const left = Math.min(...selected.map((key) => key.box.x));
  const right = Math.max(...selected.map((key) => key.box.x + key.box.width));
  const top = Math.min(...selected.map((key) => key.box.y));
  const bottom = Math.max(...selected.map((key) => key.box.y + key.box.height));
  const center = (left + right) / 2;
  const middle = (top + bottom) / 2;

  return keys.map((key) => {
    if (!selectedIds.has(key.id)) return key;
    let x = key.box.x;
    let y = key.box.y;
    if (mode === 'left') x = left;
    if (mode === 'center') x = center - key.box.width / 2;
    if (mode === 'right') x = right - key.box.width;
    if (mode === 'top') y = top;
    if (mode === 'middle') y = middle - key.box.height / 2;
    if (mode === 'bottom') y = bottom - key.box.height;
    return { ...key, box: { ...key.box, x, y } };
  });
}

export function distributeKeys(
  keys: readonly KeyboardLabKey[],
  selectedIds: ReadonlySet<string>,
  axis: 'horizontal' | 'vertical',
): KeyboardLabKey[] {
  const selected = keys
    .filter((key) => selectedIds.has(key.id))
    .sort((a, b) => axis === 'horizontal'
      ? a.box.x - b.box.x
      : a.box.y - b.box.y);
  if (selected.length < 3) return [...keys];

  const first = selected[0];
  const last = selected[selected.length - 1];
  const totalSize = selected.reduce(
    (sum, key) => sum + (axis === 'horizontal' ? key.box.width : key.box.height),
    0,
  );
  const span = axis === 'horizontal'
    ? last.box.x + last.box.width - first.box.x
    : last.box.y + last.box.height - first.box.y;
  const gap = (span - totalSize) / (selected.length - 1);
  const positions = new Map<string, number>();
  let cursor = axis === 'horizontal' ? first.box.x : first.box.y;
  for (const key of selected) {
    positions.set(key.id, cursor);
    cursor += (axis === 'horizontal' ? key.box.width : key.box.height) + gap;
  }

  return keys.map((key) => {
    const position = positions.get(key.id);
    if (position === undefined) return key;
    return {
      ...key,
      box: {
        ...key.box,
        ...(axis === 'horizontal' ? { x: position } : { y: position }),
      },
    };
  });
}

export function keysIntersectingBox(
  keys: readonly KeyboardLabKey[],
  box: SceneBox,
): string[] {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  return keys
    .filter((key) =>
      key.box.x < right
      && key.box.x + key.box.width > box.x
      && key.box.y < bottom
      && key.box.y + key.box.height > box.y)
    .map((key) => key.id);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

const SHAPES: readonly KeyboardLabShape[] = [
  'rectangle',
  'return',
  'wedge-up',
  'wedge-down',
  'wedge-left',
  'wedge-right',
  'custom',
];

export function parseKeyboardLabDocument(value: unknown): KeyboardLabDocument {
  if (!value || typeof value !== 'object') throw new Error('Layout must be an object');
  const source = value as Record<string, unknown>;
  if (!source.scene || typeof source.scene !== 'object') {
    throw new Error('Layout scene is missing');
  }
  const scene = source.scene as Record<string, unknown>;
  if (!Array.isArray(source.keys)) throw new Error('Layout keys must be an array');
  const ids = new Set<string>();
  const keys = source.keys.map((raw, index): KeyboardLabKey => {
    if (!raw || typeof raw !== 'object') throw new Error(`Key ${index} must be an object`);
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id.trim()) {
      throw new Error(`Key ${index} requires an id`);
    }
    if (ids.has(item.id)) throw new Error(`Duplicate key id: ${item.id}`);
    ids.add(item.id);
    if (!item.box || typeof item.box !== 'object') throw new Error(`Key ${item.id} has no box`);
    const box = item.box as Record<string, unknown>;
    const legends = item.legends && typeof item.legends === 'object'
      ? item.legends as Record<string, unknown>
      : {};
    if (legends.main !== undefined && typeof legends.main !== 'string') {
      throw new Error(`Key ${item.id} main legend must be a string`);
    }
    let cell: readonly [number, number] | undefined;
    if (item.cell !== undefined) {
      if (!Array.isArray(item.cell) || item.cell.length !== 2) {
        throw new Error(`Key ${item.id} cell must be [row, bit]`);
      }
      cell = [
        finiteNumber(item.cell[0], `Key ${item.id} row`),
        finiteNumber(item.cell[1], `Key ${item.id} bit`),
      ];
    }
    return {
      id: item.id,
      box: {
        x: finiteNumber(box.x, `Key ${item.id} x`),
        y: finiteNumber(box.y, `Key ${item.id} y`),
        width: finiteNumber(box.width, `Key ${item.id} width`),
        height: finiteNumber(box.height, `Key ${item.id} height`),
      },
      cell,
      legends: {
        main: typeof legends.main === 'string' ? legends.main : '',
        shift: optionalString(legends.shift, `Key ${item.id} shift legend`),
        aux: optionalString(legends.aux, `Key ${item.id} auxiliary legend`),
      },
      tone: optionalString(item.tone, `Key ${item.id} tone`),
      region: optionalString(item.region, `Key ${item.id} region`),
      shape: (() => {
        const shape = optionalString(item.shape, `Key ${item.id} shape`);
        if (shape !== undefined && !SHAPES.includes(shape as KeyboardLabShape)) {
          throw new Error(`Key ${item.id} has an unknown shape`);
        }
        return shape as KeyboardLabShape | undefined;
      })(),
      clipPath: optionalString(item.clipPath, `Key ${item.id} clipPath`),
    };
  });

  let reference: KeyboardLabDocument['reference'];
  if (source.reference !== undefined) {
    if (!source.reference || typeof source.reference !== 'object') {
      throw new Error('Layout reference must be an object');
    }
    const item = source.reference as Record<string, unknown>;
    reference = {
      name: optionalString(item.name, 'Reference name') ?? 'Reference image',
      x: finiteNumber(item.x, 'Reference x'),
      y: finiteNumber(item.y, 'Reference y'),
      width: finiteNumber(item.width, 'Reference width'),
      height: finiteNumber(item.height, 'Reference height'),
      rotation: finiteNumber(item.rotation, 'Reference rotation'),
      opacity: finiteNumber(item.opacity, 'Reference opacity'),
    };
  }

  return {
    version: 1,
    id: typeof source.id === 'string' && source.id.trim() ? source.id : 'imported-layout',
    name: typeof source.name === 'string' && source.name.trim() ? source.name : 'Imported layout',
    theme: optionalString(source.theme, 'Layout theme'),
    scene: {
      width: finiteNumber(scene.width, 'Scene width'),
      height: finiteNumber(scene.height, 'Scene height'),
    },
    reference,
    keys,
  };
}

export function documentAsJson(document: KeyboardLabDocument): string {
  return `${JSON.stringify({
    ...document,
    keys: document.keys.map((key) => ({
      ...key,
      clipPath: key.clipPath ?? (key.shape ? shapeClip(key.shape) : undefined),
    })),
  }, null, 2)}\n`;
}

export function documentAsTypeScript(document: KeyboardLabDocument): string {
  const name = document.id
    .replace(/[^A-Za-z0-9]+(.)/g, (_, character: string) => character.toUpperCase())
    .replace(/^[^A-Za-z_]+/, '') || 'keyboard';
  const rows = document.keys.map((key) => {
    const clipPath = key.clipPath ?? (key.shape ? shapeClip(key.shape) : undefined);
    const fields = [
      `id: ${JSON.stringify(key.id)}`,
      `box: ${JSON.stringify(key.box)}`,
      key.cell ? `cell: ${JSON.stringify(key.cell)} as const` : '',
      `legends: ${JSON.stringify(key.legends)}`,
      key.tone ? `tone: ${JSON.stringify(key.tone)}` : '',
      key.region ? `region: ${JSON.stringify(key.region)}` : '',
      key.shape ? `shape: ${JSON.stringify(key.shape)}` : '',
      clipPath ? `clipPath: ${JSON.stringify(clipPath)}` : '',
    ].filter(Boolean);
    return `  { ${fields.join(', ')} },`;
  });
  return [
    `export const ${name}Scene = ${JSON.stringify(document.scene)} as const;`,
    '',
    `export const ${name}Keys = [`,
    ...rows,
    '] as const;',
    '',
  ].join('\n');
}
