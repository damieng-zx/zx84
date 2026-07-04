/**
 * Decision logic for auto-pausing emulation when the tab/window loses focus.
 *
 * Kept as a pure reducer (no DOM, no signals) so the branching is unit-testable
 * in isolation. `emulator.ts` samples the live focus/pause state, calls this to
 * decide, then performs the machine.start()/stop() side effects.
 */

export type FocusPauseState = {
  /** Tab is visible AND the window has focus. */
  active: boolean;
  /** "Pause when focus lost" setting is enabled. */
  settingOn: boolean;
  /** Emulation is currently paused (manually, by the debugger, or by us). */
  paused: boolean;
  /** The most recent pause was caused by this focus-loss logic. */
  autoPaused: boolean;
};

export type FocusPauseAction = 'pause' | 'resume' | 'none';

export function decideFocusPause(s: FocusPauseState): FocusPauseAction {
  if (!s.active) {
    // Lost focus: pause a running machine, but only if the feature is on and
    // the machine isn't already paused by the user or the debugger.
    return s.settingOn && !s.paused ? 'pause' : 'none';
  }
  // Regained focus: resume only a machine *we* auto-paused, so a manual or
  // debugger pause is never clobbered on return.
  return s.autoPaused ? 'resume' : 'none';
}
