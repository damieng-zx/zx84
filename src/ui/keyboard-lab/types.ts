import type { SceneBox } from '@/ui/components/KeyboardScene.tsx';

export type KeyboardLabShape =
  | 'rectangle'
  | 'return'
  | 'wedge-up'
  | 'wedge-down'
  | 'wedge-left'
  | 'wedge-right'
  | 'custom';

export interface KeyboardLabLegends {
  readonly main: string;
  readonly shift?: string;
  readonly aux?: string;
}

export interface KeyboardLabKey {
  readonly id: string;
  readonly box: SceneBox;
  readonly cell?: readonly [row: number, bit: number];
  readonly legends: KeyboardLabLegends;
  readonly tone?: string;
  readonly region?: string;
  readonly shape?: KeyboardLabShape;
  readonly clipPath?: string;
}

export interface KeyboardLabReference {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotation: number;
  readonly opacity: number;
}

export interface KeyboardLabDocument {
  readonly version: 1;
  readonly id: string;
  readonly name: string;
  readonly theme?: string;
  readonly scene: {
    readonly width: number;
    readonly height: number;
  };
  readonly reference?: KeyboardLabReference;
  readonly keys: readonly KeyboardLabKey[];
}

export interface KeyboardLabPresetLoader {
  readonly group: string;
  load(): Promise<readonly KeyboardLabDocument[]>;
}
