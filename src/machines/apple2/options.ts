/**
 * Apple II hardware options: the expansions that are fitted or not.
 *
 * These are read from the shared settings (see `store/settings.ts`) when the
 * machine is prepared, so changing one rebuilds the machine — an expansion card
 * is not something you hot-plug into a running Apple II.
 */

import type { SettingsView } from '@/machines/machine.ts';
import { apple2ModelInfo, type Apple2Model } from './models.ts';

export interface Apple2Options {
  /** The Disk II controller card in slot 6, with its drives. */
  readonly disk2: boolean;
  /** Drives attached to the Disk II controller (1 or 2). */
  readonly drives: 1 | 2;
  /** The 16K language card in slot 0 (RAM that replaces the ROM at $D000-$FFFF).
   *  The //e has the equivalent built in, so this is always true there. */
  readonly languageCard: boolean;
  /** 80-column hardware: a Videx Videoterm card (slot 3) on the ][ and ][+, or the
   *  extended 80-column card (with 64K of auxiliary RAM) on the //e. */
  readonly eightyColumn: boolean;
  /** Paddles or a joystick plugged into the game port. */
  readonly joystick: boolean;
  /** A Mockingboard sound card in slot 4. */
  readonly mockingboard: boolean;
}

export const APPLE2_DEFAULT_OPTIONS: Apple2Options = {
  disk2: true,
  drives: 2,
  languageCard: true,
  eightyColumn: false,
  joystick: true,
  mockingboard: false,
};

export function readApple2Options(view: SettingsView, model: Apple2Model): Apple2Options {
  const { iie, iic } = apple2ModelInfo(model);
  return {
    // The //c's drive controller and 80-column hardware are part of the machine.
    disk2: iic || view.get('apple2-disk2', APPLE2_DEFAULT_OPTIONS.disk2),
    drives: view.get<string>('apple2-drives', '2') === '1' ? 1 : 2,
    languageCard: iie || view.get('apple2-langcard', APPLE2_DEFAULT_OPTIONS.languageCard),
    // The //e is normally fitted with the extended card; the ][ family has to be
    // given a Videx card.
    eightyColumn: iic || (iie ? view.get('apple2e-80col', true) : view.get('apple2-80col', false)),
    joystick: view.get('apple2-joystick', APPLE2_DEFAULT_OPTIONS.joystick),
    mockingboard: !iic && view.get('apple2-mockingboard', APPLE2_DEFAULT_OPTIONS.mockingboard),
  };
}
