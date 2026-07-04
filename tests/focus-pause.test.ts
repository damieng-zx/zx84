/**
 * focus-pause — pure decision reducer for auto-pausing on lost focus.
 *
 * The reducer is the single source of truth for "should losing/regaining focus
 * change the run state?". These tests pin the four behaviours that matter:
 *
 *   - Losing focus pauses a running machine (the headline feature).
 *   - The setting being off makes losing focus a no-op.
 *   - Regaining focus resumes ONLY what the focus logic itself paused.
 *   - A manually/debugger-paused machine is never auto-resumed.
 */

import { describe, it, expect } from 'vitest';
import { decideFocusPause } from '@/focus-pause.ts';

describe('decideFocusPause', () => {
  it('pauses a running machine when focus is lost and the setting is on', () => {
    expect(decideFocusPause({
      active: false, settingOn: true, paused: false, autoPaused: false,
    })).toBe('pause');
  });

  it('does nothing on focus loss when the setting is off', () => {
    expect(decideFocusPause({
      active: false, settingOn: false, paused: false, autoPaused: false,
    })).toBe('none');
  });

  it('does not re-pause a machine that is already paused', () => {
    expect(decideFocusPause({
      active: false, settingOn: true, paused: true, autoPaused: false,
    })).toBe('none');
  });

  it('resumes when focus returns to a machine it auto-paused', () => {
    expect(decideFocusPause({
      active: true, settingOn: true, paused: true, autoPaused: true,
    })).toBe('resume');
  });

  it('never auto-resumes a machine the user/debugger paused', () => {
    // Regained focus, machine is paused, but we did NOT pause it → leave it.
    expect(decideFocusPause({
      active: true, settingOn: true, paused: true, autoPaused: false,
    })).toBe('none');
  });

  it('does nothing on focus return when nothing was auto-paused', () => {
    expect(decideFocusPause({
      active: true, settingOn: true, paused: false, autoPaused: false,
    })).toBe('none');
  });

  it('still resumes an auto-paused machine even if the setting was turned off while away', () => {
    // Toggling the feature off mid-pause must not strand the machine paused.
    expect(decideFocusPause({
      active: true, settingOn: false, paused: true, autoPaused: true,
    })).toBe('resume');
  });
});
