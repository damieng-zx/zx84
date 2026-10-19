/**
 * Monochrome-monitor phosphors. A tube with a single phosphor shows only the
 * luminance of the picture, tinted to the colour that phosphor glows, so the
 * monitor option reduces any machine's output to that. `color` is a normal
 * colour monitor and leaves the picture alone.
 */

export type Phosphor = 'color' | 'white' | 'green' | 'amber' | 'cyan';

export const PHOSPHORS: readonly { id: Phosphor; label: string }[] = [
  { id: 'color', label: 'Color' },
  { id: 'white', label: 'White' },
  { id: 'green', label: 'Green' },
  { id: 'amber', label: 'Amber' },
  { id: 'cyan', label: 'Cyan' },
];

/** The RGB (0-1) a full-brightness pixel shows; null leaves the picture in colour. */
export type PhosphorTint = readonly [number, number, number] | null;

const TINTS: Record<Phosphor, PhosphorTint> = {
  color: null,
  // P4, the TV-grade white: faintly blue next to a neutral white.
  white: [0.93, 0.97, 1.0],
  // P1, the classic green screen.
  green: [0.2, 1.0, 0.2],
  // P3, the amber/orange screen.
  amber: [1.0, 0.69, 0.0],
  // The rarer ice-blue / cyan-white tubes.
  cyan: [0.4, 0.85, 1.0],
};

/** Coerce a saved value (a stale or hand-edited key included) to a phosphor. */
export function parsePhosphor(v: string): Phosphor {
  return Object.prototype.hasOwnProperty.call(TINTS, v) ? v as Phosphor : 'color';
}

export function phosphorTint(p: Phosphor): PhosphorTint {
  return TINTS[p];
}
