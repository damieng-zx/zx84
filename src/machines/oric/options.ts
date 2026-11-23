/**
 * Oric Hardware-pane options.
 *
 * Both machines are the same board, so the only things to choose are the system
 * ROM's model (picked in the model menu) and whether a Microdisc is fitted.
 * The overlay RAM is part of every Oric already — the question is only whether
 * a card can switch it in — so it is not an option, it is the memory map.
 */

import type { SettingsView } from '@/machines/machine.ts';

export interface OricOptions {
  /** A Microdisc (WD1793 + 8K boot EPROM) is fitted. */
  readonly microdisc: boolean;
}

export const ORIC_DEFAULT_OPTIONS: OricOptions = { microdisc: false };

export function readOricOptions(view: SettingsView): OricOptions {
  return { microdisc: view.get('oric-microdisc', false) };
}
