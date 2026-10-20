/**
 * Apple I hardware options: the memory that is fitted.
 *
 * These are read from the shared settings (see `store/settings.ts`) when the
 * machine is prepared, so changing one rebuilds the machine — RAM is not
 * something you add to a running Apple I.
 */

import type { SettingsView } from '@/machines/machine.ts';

/** RAM fitted contiguously from $0000: the board's 4K or 8K, or expansion cards. */
export const APPLE1_RAM_SIZES = [4, 8, 16, 32, 48] as const;
export type Apple1RamKb = typeof APPLE1_RAM_SIZES[number];

export interface Apple1Options {
  /** Kilobytes of RAM from $0000. */
  readonly ramKb: Apple1RamKb;
  /** The 4K RAM card at $E000-$EFFF that Apple BASIC loads into. */
  readonly basicRam: boolean;
}

export const APPLE1_DEFAULT_OPTIONS: Apple1Options = {
  ramKb: 8,
  basicRam: true,
};

/** The setting's value ('8k'), as a fitted size; anything unrecognised is the default. */
export function parseApple1Ram(value: unknown): Apple1RamKb {
  const kb = parseInt(String(value), 10);
  return (APPLE1_RAM_SIZES as readonly number[]).includes(kb) ? kb as Apple1RamKb : APPLE1_DEFAULT_OPTIONS.ramKb;
}

export function readApple1Options(view: SettingsView): Apple1Options {
  return {
    ramKb: parseApple1Ram(view.get('apple1-ram', `${APPLE1_DEFAULT_OPTIONS.ramKb}k`)),
    basicRam: view.get('apple1-basic-ram', APPLE1_DEFAULT_OPTIONS.basicRam),
  };
}
