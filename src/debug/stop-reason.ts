/**
 * Why a run stopped. A stop is the frame loop returning early; `kind` says
 * which debugger feature asked for it. This module imports nothing.
 */

export type StopKind = 'breakpoint' | 'trap' | 'watch' | 'port' | 'beam' | 'step' | 'reset';

export interface StopReason {
  kind: StopKind;
  /** The pc the CPU was at when the run stopped. */
  pc: number;
  /** Free-form extra text (for a beam stop, the position reached). */
  detail: string;
}
