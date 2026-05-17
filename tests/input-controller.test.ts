/**
 * input-controller — keyboard + gamepad routing for joystick emulation.
 *
 * The InputController is heavily coupled to the emulator singleton, the
 * settings signals, the joystick pane UI signals, and `navigator.getGamepads`.
 * Mocking surface is wide on purpose: every dependency is replaced with a
 * recordable stub so the tests assert routing decisions, not the behaviour
 * of downstream modules.
 *
 * The "regressions" block at the bottom covers three bugs found and fixed
 * in the same pass:
 *
 *   (A) onBlur used to zero gamepadPrevState without issuing release events;
 *       held gamepad buttons at blur time became stuck Spectrum presses.
 *   (B) Cancelling configuration left configPending populated, so the next
 *       session's isBindingAlreadyUsed rejected previously-bound buttons.
 *   (C) Configuring player 2 silently fell back to gamepad slot 0 when the
 *       second pad was absent, re-binding the wrong device.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { GamepadConfig } from '@/store/settings.ts';

// ─────────────────────────────────────────────────────────────────────────
// Shared mock state — must be hoisted so vi.mock factories can reference it.
// ─────────────────────────────────────────────────────────────────────────

const mockState = vi.hoisted(() => {
  return {
    joyP1Type: 'kempston' as string,
    joyP2Type: 'sinclair2' as string,
    joyMapP1Mode: 'keys' as string,
    joyMapP2Mode: 'none' as string,
    gamepadCfgP1: null as GamepadConfig | null,
    gamepadCfgP2: null as GamepadConfig | null,
    configuringPlayerValue: -1 as number,
    configuringStepValue: '' as string,

    joyPressCalls: [] as Array<{ dir: string; pressed: boolean; type: string }>,
    handleKeyEventCalls: [] as Array<{ code: string; pressed: boolean; key: string | undefined }>,
    handleKeyEventReturn: true,
    keyboardResetCount: 0,
    joystickResetCount: 0,
    saveGamepadConfigCalls: [] as Array<{ player: 1 | 2; config: GamepadConfig }>,
    persistSettingCalls: [] as Array<{ key: string; value: string | number }>,
    setConfigProgressCalls: [] as number[],
    setConfigStepCalls: [] as string[],
    setConfigPlayerCalls: [] as number[],
    setJoyMapP1Calls: [] as string[],
    setJoyMapP2Calls: [] as string[],

    spectrumPresent: true,
  };
});

// ─────────────────────────────────────────────────────────────────────────
// Module mocks
// ─────────────────────────────────────────────────────────────────────────

vi.mock('@/store/settings.ts', () => ({
  joyP1: () => mockState.joyP1Type,
  joyP2: () => mockState.joyP2Type,
  joyMapP1: () => mockState.joyMapP1Mode,
  joyMapP2: () => mockState.joyMapP2Mode,
  setJoyMapP1: (v: string) => { mockState.joyMapP1Mode = v; mockState.setJoyMapP1Calls.push(v); },
  setJoyMapP2: (v: string) => { mockState.joyMapP2Mode = v; mockState.setJoyMapP2Calls.push(v); },
  gamepadConfigP1: () => mockState.gamepadCfgP1,
  gamepadConfigP2: () => mockState.gamepadCfgP2,
  saveGamepadConfig: (player: 1 | 2, config: GamepadConfig) =>
    mockState.saveGamepadConfigCalls.push({ player, config }),
  persistSetting: (key: string, value: string | number) =>
    mockState.persistSettingCalls.push({ key, value }),
}));

vi.mock('@/emulator.ts', () => ({
  get spectrum() {
    return mockState.spectrumPresent ? {
      keyboard: {
        handleKeyEvent: (code: string, pressed: boolean, key?: string) => {
          mockState.handleKeyEventCalls.push({ code, pressed, key });
          return mockState.handleKeyEventReturn;
        },
        reset: () => { mockState.keyboardResetCount++; },
      },
    } : null;
  },
  joyPressForType: (dir: string, pressed: boolean, type: string) => {
    mockState.joyPressCalls.push({ dir, pressed, type });
  },
  resetJoystickKeyState: () => { mockState.joystickResetCount++; },
}));

vi.mock('@/components/panes/JoystickPane.tsx', () => ({
  configuringPlayer: () => mockState.configuringPlayerValue,
  setConfiguringPlayer: (v: number) => {
    mockState.configuringPlayerValue = v;
    mockState.setConfigPlayerCalls.push(v);
  },
  configuringStep: () => mockState.configuringStepValue,
  setConfiguringStep: (v: string) => {
    mockState.configuringStepValue = v;
    mockState.setConfigStepCalls.push(v);
  },
  setConfiguringProgress: (v: number) => { mockState.setConfigProgressCalls.push(v); },
}));

// ─────────────────────────────────────────────────────────────────────────
// Test helpers
// ─────────────────────────────────────────────────────────────────────────

function makeKey(code: string, opts: { repeat?: boolean; key?: string } = {}): KeyboardEvent {
  // Minimal KeyboardEvent stand-in — we only read code/key/repeat and call preventDefault.
  let prevented = false;
  return {
    code,
    key: opts.key ?? code,
    repeat: opts.repeat ?? false,
    preventDefault: () => { prevented = true; },
    get defaultPrevented() { return prevented; },
  } as unknown as KeyboardEvent;
}

function makeGamepad(spec: {
  buttons?: boolean[];
  axes?: number[];
} = {}): Gamepad {
  const buttons = (spec.buttons ?? []).map(p => ({ pressed: p, touched: p, value: p ? 1 : 0 }));
  const axes = spec.axes ?? [];
  return {
    id: 'mock',
    index: 0,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    buttons,
    axes,
    vibrationActuator: null,
  } as unknown as Gamepad;
}

function setGamepads(...pads: (Gamepad | null)[]): void {
  // globalThis.navigator is non-writable in node — override the property
  // descriptor instead of reassigning the whole object.
  Object.defineProperty(globalThis, 'navigator', {
    value: { getGamepads: () => pads },
    configurable: true,
    writable: true,
  });
}

function makeConfig(overrides: Partial<GamepadConfig> = {}): GamepadConfig {
  return {
    deadzone: [0, 0, 0, 0],
    up:    { type: 'button', index: 12 },
    down:  { type: 'button', index: 13 },
    left:  { type: 'button', index: 14 },
    right: { type: 'button', index: 15 },
    fire:  { type: 'button', index: 0 },
    ...overrides,
  };
}

function resetMockState(): void {
  mockState.joyP1Type = 'kempston';
  mockState.joyP2Type = 'sinclair2';
  mockState.joyMapP1Mode = 'keys';
  mockState.joyMapP2Mode = 'none';
  mockState.gamepadCfgP1 = null;
  mockState.gamepadCfgP2 = null;
  mockState.configuringPlayerValue = -1;
  mockState.configuringStepValue = '';
  mockState.joyPressCalls.length = 0;
  mockState.handleKeyEventCalls.length = 0;
  mockState.handleKeyEventReturn = true;
  mockState.keyboardResetCount = 0;
  mockState.joystickResetCount = 0;
  mockState.saveGamepadConfigCalls.length = 0;
  mockState.persistSettingCalls.length = 0;
  mockState.setConfigProgressCalls.length = 0;
  mockState.setConfigStepCalls.length = 0;
  mockState.setConfigPlayerCalls.length = 0;
  mockState.setJoyMapP1Calls.length = 0;
  mockState.setJoyMapP2Calls.length = 0;
  mockState.spectrumPresent = true;

  // Minimal document for the DOM-touching setDpadHighlight helper.
  (globalThis as any).document = {
    querySelector: () => null,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────

let InputController: typeof import('@/input-controller.ts').InputController;

beforeEach(async () => {
  resetMockState();
  setGamepads(null, null);
  ({ InputController } = await import('@/input-controller.ts'));
});

afterEach(() => {
  vi.useRealTimers();
  // navigator has a configurable descriptor now — safe to remove.
  try { delete (globalThis as any).navigator; } catch { /* */ }
  delete (globalThis as any).document;
});

// ─────────────────────────────────────────────────────────────────────────
// Keyboard routing
// ─────────────────────────────────────────────────────────────────────────

describe('keyboard — onKeyDown', () => {
  it('drops OS-generated auto-repeat events without forwarding anywhere', () => {
    const ic = new InputController();
    ic.onKeyDown(makeKey('KeyA', { repeat: true }));
    expect(mockState.handleKeyEventCalls).toHaveLength(0);
    expect(mockState.joyPressCalls).toHaveLength(0);
  });

  it('no-op when spectrum is not yet ready', () => {
    mockState.spectrumPresent = false;
    const ic = new InputController();
    ic.onKeyDown(makeKey('KeyA'));
    expect(mockState.handleKeyEventCalls).toHaveLength(0);
  });

  it('cursor map: ArrowUp → joystick up press for player 1', () => {
    mockState.joyMapP1Mode = 'keys';
    mockState.joyP1Type = 'kempston';
    const ic = new InputController();
    ic.onKeyDown(makeKey('ArrowUp'));
    expect(mockState.joyPressCalls).toEqual([{ dir: 'up', pressed: true, type: 'kempston' }]);
    // When the joy handler claims the event, the Spectrum keyboard must NOT
    // also see the keydown.
    expect(mockState.handleKeyEventCalls).toHaveLength(0);
  });

  it('wasd map: KeyW → joystick up press', () => {
    mockState.joyMapP1Mode = 'wasd';
    mockState.joyP1Type = 'sinclair1';
    const ic = new InputController();
    ic.onKeyDown(makeKey('KeyW'));
    expect(mockState.joyPressCalls).toEqual([{ dir: 'up', pressed: true, type: 'sinclair1' }]);
  });

  it('skipped when joystick type is "none", even if map is set', () => {
    mockState.joyP1Type = 'none';
    mockState.joyMapP1Mode = 'keys';
    const ic = new InputController();
    ic.onKeyDown(makeKey('ArrowUp'));
    expect(mockState.joyPressCalls).toHaveLength(0);
    // Falls through to the Spectrum keyboard handler instead.
    expect(mockState.handleKeyEventCalls).toHaveLength(1);
  });

  it('skipped when map is unmapped (any value not in KEY_MAP_FOR_MODE)', () => {
    mockState.joyMapP1Mode = 'none';
    const ic = new InputController();
    ic.onKeyDown(makeKey('ArrowUp'));
    expect(mockState.joyPressCalls).toHaveLength(0);
  });

  it('forwards unmapped keys to the Spectrum keyboard with code+pressed+key', () => {
    mockState.joyMapP1Mode = 'none';
    const ic = new InputController();
    ic.onKeyDown(makeKey('KeyQ', { key: 'q' }));
    expect(mockState.handleKeyEventCalls).toEqual([
      { code: 'KeyQ', pressed: true, key: 'q' },
    ]);
  });

  it('a single key wired to BOTH players activates both joysticks', () => {
    // This is current behaviour — Space is in both CURSOR and WASD maps.
    // If both players use cursor mode, ArrowUp fires for both. Pinning to
    // document the design choice; if it should ever be exclusive, this is
    // the test that needs to change.
    mockState.joyP1Type = 'kempston'; mockState.joyMapP1Mode = 'keys';
    mockState.joyP2Type = 'sinclair2'; mockState.joyMapP2Mode = 'keys';
    const ic = new InputController();
    ic.onKeyDown(makeKey('ArrowUp'));
    expect(mockState.joyPressCalls).toEqual([
      { dir: 'up', pressed: true, type: 'kempston' },
      { dir: 'up', pressed: true, type: 'sinclair2' },
    ]);
  });
});

describe('keyboard — onKeyUp', () => {
  it('mirrors onKeyDown but with pressed=false', () => {
    mockState.joyMapP1Mode = 'keys';
    const ic = new InputController();
    ic.onKeyUp(makeKey('ArrowDown'));
    expect(mockState.joyPressCalls).toEqual([{ dir: 'down', pressed: false, type: 'kempston' }]);
  });

  it('does NOT drop repeats (only keydown does)', () => {
    // Repeat is a keydown-only concept; onKeyUp should not check the flag.
    mockState.joyMapP1Mode = 'keys';
    const ic = new InputController();
    ic.onKeyUp(makeKey('ArrowUp', { repeat: true }));
    expect(mockState.joyPressCalls).toHaveLength(1);
  });
});

describe('keyboard — onBlur', () => {
  it('resets Spectrum keyboard and joystick key-state counter', () => {
    const ic = new InputController();
    ic.onBlur();
    expect(mockState.keyboardResetCount).toBe(1);
    expect(mockState.joystickResetCount).toBe(1);
  });

  it('no-op when spectrum is not yet ready', () => {
    mockState.spectrumPresent = false;
    const ic = new InputController();
    ic.onBlur();
    expect(mockState.keyboardResetCount).toBe(0);
  });

  it('fires no joystick releases when nothing was held', () => {
    const ic = new InputController();
    ic.onBlur();
    expect(mockState.joyPressCalls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Additional keyboard coverage
// ─────────────────────────────────────────────────────────────────────────

describe('keyboard — map coverage', () => {
  it('cursor map: ArrowDown/Left/Right/Space/AltRight all map to joy directions', () => {
    mockState.joyMapP1Mode = 'keys';
    const ic = new InputController();
    for (const [code, dir] of [
      ['ArrowDown', 'down'], ['ArrowLeft', 'left'], ['ArrowRight', 'right'],
      ['Space', 'fire'], ['AltRight', 'fire'],
    ] as const) {
      mockState.joyPressCalls.length = 0;
      ic.onKeyDown(makeKey(code));
      expect(mockState.joyPressCalls[0]).toEqual({ dir, pressed: true, type: 'kempston' });
    }
  });

  it('wasd map: A/S/D map to left/down/right, Space maps to fire', () => {
    mockState.joyMapP1Mode = 'wasd';
    const ic = new InputController();
    for (const [code, dir] of [
      ['KeyA', 'left'], ['KeyS', 'down'], ['KeyD', 'right'], ['Space', 'fire'],
    ] as const) {
      mockState.joyPressCalls.length = 0;
      ic.onKeyDown(makeKey(code));
      expect(mockState.joyPressCalls[0]).toEqual({ dir, pressed: true, type: 'kempston' });
    }
  });

  it('cursor and wasd are independent — KeyW does not trigger when map is "keys"', () => {
    mockState.joyMapP1Mode = 'keys';
    const ic = new InputController();
    ic.onKeyDown(makeKey('KeyW'));
    expect(mockState.joyPressCalls).toHaveLength(0);
    // KeyW falls through to the Spectrum keyboard.
    expect(mockState.handleKeyEventCalls).toHaveLength(1);
  });

  it('joy-handled key marks the event handled (signalled to caller via preventDefault)', () => {
    mockState.joyMapP1Mode = 'keys';
    const e = makeKey('ArrowUp');
    new InputController().onKeyDown(e);
    expect(e.defaultPrevented).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Gamepad polling — normal mode
// ─────────────────────────────────────────────────────────────────────────

describe('gamepad polling — normal mode', () => {
  it('no gamepad attached → no calls', () => {
    setGamepads(null, null);
    const ic = new InputController();
    ic.pollGamepads();
    expect(mockState.joyPressCalls).toHaveLength(0);
  });

  it('gamepad present but joyMap is not "gamepad" → no calls', () => {
    mockState.joyMapP1Mode = 'keys';
    mockState.gamepadCfgP1 = makeConfig();
    setGamepads(makeGamepad({ buttons: [true] }), null);
    const ic = new InputController();
    ic.pollGamepads();
    expect(mockState.joyPressCalls).toHaveLength(0);
  });

  it('joyMap=gamepad but no config → no calls', () => {
    mockState.joyMapP1Mode = 'gamepad';
    mockState.gamepadCfgP1 = null;
    setGamepads(makeGamepad({ buttons: [true] }), null);
    const ic = new InputController();
    ic.pollGamepads();
    expect(mockState.joyPressCalls).toHaveLength(0);
  });

  it('button press fires joyPressForType exactly once (edge-triggered)', () => {
    mockState.joyMapP1Mode = 'gamepad';
    mockState.gamepadCfgP1 = makeConfig();
    setGamepads(makeGamepad({ buttons: [true /* fire */] }), null);
    const ic = new InputController();
    ic.pollGamepads();
    ic.pollGamepads();
    ic.pollGamepads();
    const firePresses = mockState.joyPressCalls.filter(c => c.dir === 'fire' && c.pressed);
    expect(firePresses).toHaveLength(1);
  });

  it('button release fires once on the falling edge', () => {
    mockState.joyMapP1Mode = 'gamepad';
    mockState.gamepadCfgP1 = makeConfig();
    const pad = makeGamepad({ buttons: [true] });
    setGamepads(pad, null);
    const ic = new InputController();
    ic.pollGamepads();
    // Release.
    setGamepads(makeGamepad({ buttons: [false] }), null);
    ic.pollGamepads();
    const fireReleases = mockState.joyPressCalls.filter(c => c.dir === 'fire' && !c.pressed);
    expect(fireReleases).toHaveLength(1);
  });

  it('axis past the deadzone triggers the bound direction', () => {
    mockState.joyMapP1Mode = 'gamepad';
    mockState.gamepadCfgP1 = makeConfig({
      up: { type: 'axis', index: 1, direction: 'negative' },
    });
    setGamepads(makeGamepad({ axes: [0, -0.5, 0, 0] }), null);
    const ic = new InputController();
    ic.pollGamepads();
    expect(mockState.joyPressCalls.find(c => c.dir === 'up' && c.pressed)).toBeDefined();
  });

  it('axis exactly at the deadzone threshold is treated as neutral', () => {
    // GAMEPAD_DEADZONE = 0.4, comparison is strict (>) so 0.4 exact is OFF.
    mockState.joyMapP1Mode = 'gamepad';
    mockState.gamepadCfgP1 = makeConfig({
      up: { type: 'axis', index: 1, direction: 'negative' },
    });
    setGamepads(makeGamepad({ axes: [0, -0.4, 0, 0] }), null);
    const ic = new InputController();
    ic.pollGamepads();
    expect(mockState.joyPressCalls.find(c => c.dir === 'up' && c.pressed)).toBeUndefined();
  });

  it('axis deadzone honours the calibrated neutral offset', () => {
    mockState.joyMapP1Mode = 'gamepad';
    mockState.gamepadCfgP1 = makeConfig({
      deadzone: [0, 0.3, 0, 0], // axis 1 idles at +0.3
      up: { type: 'axis', index: 1, direction: 'negative' },
    });
    // Raw -0.2 minus neutral 0.3 = -0.5 deviation → past the -0.4 threshold.
    setGamepads(makeGamepad({ axes: [0, -0.2, 0, 0] }), null);
    const ic = new InputController();
    ic.pollGamepads();
    expect(mockState.joyPressCalls.find(c => c.dir === 'up' && c.pressed)).toBeDefined();
  });

  it('multiple direction changes in one poll fire one event each', () => {
    mockState.joyMapP1Mode = 'gamepad';
    mockState.gamepadCfgP1 = makeConfig();
    // Press fire + up (buttons 0 and 12) at once.
    setGamepads(makeGamepad({
      buttons: Array(16).fill(false).map((_, i) => i === 0 || i === 12),
    }), null);
    const ic = new InputController();
    ic.pollGamepads();
    expect(mockState.joyPressCalls.filter(c => c.pressed)).toHaveLength(2);
    const dirs = mockState.joyPressCalls.filter(c => c.pressed).map(c => c.dir).sort();
    expect(dirs).toEqual(['fire', 'up']);
  });

  it('player 2 with gamepad in slot 1 and joyMap=gamepad polls correctly', () => {
    mockState.joyMapP2Mode = 'gamepad';
    mockState.gamepadCfgP2 = makeConfig();
    setGamepads(null, makeGamepad({ buttons: [true] }));
    const ic = new InputController();
    ic.pollGamepads();
    expect(mockState.joyPressCalls).toEqual([
      { dir: 'fire', pressed: true, type: 'sinclair2' },
    ]);
  });

  it('joystick type "none" with joyMap=gamepad releases all held directions', () => {
    // First, build up some held state.
    mockState.joyMapP1Mode = 'gamepad';
    mockState.gamepadCfgP1 = makeConfig();
    setGamepads(makeGamepad({ buttons: [true] }), null); // fire held
    const ic = new InputController();
    ic.pollGamepads();
    mockState.joyPressCalls.length = 0;

    // Now switch joystick type to none.
    mockState.joyP1Type = 'none';
    ic.pollGamepads();
    const fireRelease = mockState.joyPressCalls.find(c => c.dir === 'fire' && !c.pressed);
    expect(fireRelease).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Gamepad polling — configuration mode
// ─────────────────────────────────────────────────────────────────────────

describe('gamepad polling — configuration mode', () => {
  it('deadzone step captures axes after DEADZONE_DURATION (2s)', () => {
    vi.useFakeTimers();
    mockState.configuringPlayerValue = 0;
    mockState.configuringStepValue = 'deadzone';
    setGamepads(makeGamepad({ axes: [0.1, -0.05, 0, 0] }), null);
    const ic = new InputController();

    ic.pollGamepads();
    expect(mockState.setConfigStepCalls).toHaveLength(0); // not yet advanced

    vi.advanceTimersByTime(2100);
    ic.pollGamepads();
    // advanceConfig clears the current step then sets next after 250ms.
    expect(mockState.setConfigStepCalls).toContain('');
    vi.advanceTimersByTime(300);
    expect(mockState.setConfigStepCalls).toContain('up');
  });

  it('binding step holds the same input for BIND_HOLD_DURATION (500ms) before committing', () => {
    vi.useFakeTimers();
    mockState.configuringPlayerValue = 0;
    mockState.configuringStepValue = 'up';
    const pad = makeGamepad({ buttons: [false, false, false, false, false, false,
                                         false, false, false, false, false, false,
                                         true /* button 12 */] });
    setGamepads(pad, null);
    const ic = new InputController();

    ic.pollGamepads();           // start hold
    vi.advanceTimersByTime(200); // still holding
    ic.pollGamepads();
    expect(mockState.setConfigStepCalls).not.toContain(''); // not advanced yet

    vi.advanceTimersByTime(400);
    ic.pollGamepads();
    expect(mockState.setConfigStepCalls).toContain(''); // step advance triggered
  });

  it('releasing the input mid-hold resets progress and discards the candidate', () => {
    vi.useFakeTimers();
    mockState.configuringPlayerValue = 0;
    mockState.configuringStepValue = 'up';
    const padHeld = makeGamepad({ buttons: Array(13).fill(false).map((_, i) => i === 12) });
    setGamepads(padHeld, null);
    const ic = new InputController();
    ic.pollGamepads();
    vi.advanceTimersByTime(200);

    // Release.
    setGamepads(makeGamepad({ buttons: Array(13).fill(false) }), null);
    ic.pollGamepads();

    // Re-press — must restart the hold timer from 0, not commit immediately.
    setGamepads(padHeld, null);
    ic.pollGamepads();
    vi.advanceTimersByTime(400);
    ic.pollGamepads();
    // Not committed because total continuous hold < 500ms.
    expect(mockState.setConfigStepCalls).not.toContain('');
  });

  it('completing all 6 steps saves the config, sets joyMap=gamepad, and persists', () => {
    vi.useFakeTimers();
    mockState.configuringPlayerValue = 0;
    mockState.configuringStepValue = 'deadzone';
    setGamepads(makeGamepad({ axes: [0, 0, 0, 0], buttons: [] }), null);
    const ic = new InputController();

    // Step 1: deadzone (2s sample).
    ic.pollGamepads();
    vi.advanceTimersByTime(2100);
    ic.pollGamepads();

    // Subsequent steps: bind buttons 12,13,14,15,0 to up/down/left/right/fire.
    const stepButtonIdx = [12, 13, 14, 15, 0];
    for (const idx of stepButtonIdx) {
      vi.advanceTimersByTime(300); // let advanceConfig set the next step
      const buttons = Array(16).fill(false).map((_, i) => i === idx);
      setGamepads(makeGamepad({ buttons }), null);
      ic.pollGamepads();
      vi.advanceTimersByTime(600);
      ic.pollGamepads();
    }

    expect(mockState.saveGamepadConfigCalls).toHaveLength(1);
    expect(mockState.saveGamepadConfigCalls[0].player).toBe(1);
    expect(mockState.setJoyMapP1Calls).toContain('gamepad');
    expect(mockState.persistSettingCalls.find(c => c.key === 'joy-map-p1' && c.value === 'gamepad'))
      .toBeDefined();
  });

  it('binding already used at the current attempt is rejected (no progress)', () => {
    vi.useFakeTimers();
    mockState.configuringPlayerValue = 0;
    mockState.configuringStepValue = 'deadzone';
    setGamepads(makeGamepad({ axes: [0, 0, 0, 0] }), null);
    const ic = new InputController();
    ic.pollGamepads();
    vi.advanceTimersByTime(2100);
    ic.pollGamepads();
    vi.advanceTimersByTime(300); // step becomes 'up'

    // Commit up to button 12.
    setGamepads(makeGamepad({ buttons: Array(16).fill(false).map((_, i) => i === 12) }), null);
    ic.pollGamepads();
    vi.advanceTimersByTime(600);
    ic.pollGamepads();
    vi.advanceTimersByTime(300); // step becomes 'down'

    // Try to bind button 12 again — must be rejected. We can detect this
    // because no advance to '' happens for the 'down' commit.
    mockState.setConfigStepCalls.length = 0;
    ic.pollGamepads();
    vi.advanceTimersByTime(600);
    ic.pollGamepads();
    expect(mockState.setConfigStepCalls.filter(s => s === '')).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Surfaced bugs
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// reset()
// ─────────────────────────────────────────────────────────────────────────

describe('InputController.reset()', () => {
  it('clears pending configuration progress', () => {
    vi.useFakeTimers();
    mockState.configuringPlayerValue = 0;
    mockState.configuringStepValue = 'deadzone';
    setGamepads(makeGamepad({ axes: [0, 0, 0, 0] }), null);
    const ic = new InputController();
    ic.pollGamepads();
    vi.advanceTimersByTime(1000); // partway through deadzone calibration
    mockState.setConfigProgressCalls.length = 0;

    ic.reset();
    // The progress signal was reset to 0 as part of configReset.
    expect(mockState.setConfigProgressCalls).toContain(0);
  });
});

describe('input-controller — regressions', () => {
  // Regression for bug A: onBlur now issues an explicit release for every
  // direction tracked in gamepadPrevState, so a held gamepad button at blur
  // time doesn't become a stuck Spectrum press. resetJoystickKeyState on
  // its own only clears the cursor-shift counter — not the joystick bits.
  it('onBlur releases gamepad-driven joystick directions that were held', () => {
    mockState.joyMapP1Mode = 'gamepad';
    mockState.gamepadCfgP1 = makeConfig();
    setGamepads(makeGamepad({ buttons: [true /* fire */] }), null);
    const ic = new InputController();
    ic.pollGamepads(); // fires press for fire
    expect(mockState.joyPressCalls.find(c => c.dir === 'fire' && c.pressed)).toBeDefined();
    mockState.joyPressCalls.length = 0;

    ic.onBlur();

    // A correct implementation must release every direction the gamepad
    // had asserted. Today it only zeros prev state.
    expect(mockState.joyPressCalls.find(c => c.dir === 'fire' && !c.pressed)).toBeDefined();
  });

  // Regression for bug B: pollGamepads tracks the previous configuringPlayer
  // and clears configPending on the ≥0 → <0 transition, so a cancelled
  // session's partial bindings can't leak into the next attempt.
  it('cancelled configuration does not leak bindings into the next session', () => {
    vi.useFakeTimers();
    // First session: bind 'up' to button 12, then cancel before completing.
    mockState.configuringPlayerValue = 0;
    mockState.configuringStepValue = 'deadzone';
    setGamepads(makeGamepad({ axes: [0, 0, 0, 0] }), null);
    const ic = new InputController();
    ic.pollGamepads();
    vi.advanceTimersByTime(2100);
    ic.pollGamepads();
    vi.advanceTimersByTime(300);

    setGamepads(makeGamepad({ buttons: Array(16).fill(false).map((_, i) => i === 12) }), null);
    ic.pollGamepads();
    vi.advanceTimersByTime(600);
    ic.pollGamepads();
    vi.advanceTimersByTime(300);

    // User cancels.
    mockState.configuringPlayerValue = -1;
    mockState.configuringStepValue = '';
    ic.pollGamepads(); // exits config branch — nothing clears configPending

    // Second session: restart. Try to bind 'up' to button 12 again.
    mockState.configuringPlayerValue = 0;
    mockState.configuringStepValue = 'deadzone';
    ic.pollGamepads();
    vi.advanceTimersByTime(2100);
    ic.pollGamepads();
    vi.advanceTimersByTime(300);

    mockState.setConfigStepCalls.length = 0;
    setGamepads(makeGamepad({ buttons: Array(16).fill(false).map((_, i) => i === 12) }), null);
    ic.pollGamepads();
    vi.advanceTimersByTime(600);
    ic.pollGamepads();

    // A correct implementation accepts the re-binding (step advances to '').
    // Today the stale 'up: button 12' in configPending makes isBindingAlreadyUsed
    // reject it and no advance occurs.
    expect(mockState.setConfigStepCalls).toContain('');
  });

  // Regression for bug C: the gamepads[0] fallback has been removed.
  // Configuring P2 with no P2 gamepad is a no-op until the user plugs one
  // in, rather than silently rebinding P1's device.
  it('configuring player 2 with no second gamepad must not silently use gamepad 0', () => {
    vi.useFakeTimers();
    mockState.configuringPlayerValue = 1;
    mockState.configuringStepValue = 'deadzone';
    // Only player-1 gamepad present.
    setGamepads(makeGamepad({ axes: [0, 0, 0, 0] }), null);
    const ic = new InputController();
    ic.pollGamepads();
    vi.advanceTimersByTime(2100);
    ic.pollGamepads();

    // A correct implementation would not have made any progress because P2
    // has no gamepad. Today the deadzone gets captured from P1's gamepad.
    expect(mockState.setConfigStepCalls).not.toContain('');
  });
});
