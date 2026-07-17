/**
 * store/settings — persisted display/sound/joystick signals.
 *
 * Most of this file is straight createSignal wrappers around getSaved — not
 * worth pinning the implementation. These tests focus on the parts where
 * real logic lives: numeric parsing, gamepad JSON, and (most importantly)
 * the consistency between initial signal defaults and resetSettingsGroup
 * defaults, since those are two declarations of the same fact.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class MemStorage {
  store = new Map<string, string>();
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string): void { this.store.set(k, String(v)); }
  removeItem(k: string): void { this.store.delete(k); }
}

let storage: MemStorage;

beforeEach(() => {
  storage = new MemStorage();
  (globalThis as any).localStorage = storage;
  vi.resetModules();
});

afterEach(() => {
  delete (globalThis as any).localStorage;
});

async function load() {
  return await import('@/store/settings.ts');
}

// ─────────────────────────────────────────────────────────────────────────
// Initial defaults sanity
// ─────────────────────────────────────────────────────────────────────────

describe('settings — initial defaults from getSaved fallbacks', () => {
  it('numeric display settings default to sensible non-NaN numbers', async () => {
    const s = await load();
    // Pick a representative sample — the worry is that getSavedNumber would
    // ever return NaN. Asserting Number.isFinite catches accidental NaN
    // contamination across all numeric paths.
    for (const v of [s.scale(), s.brightness(), s.contrast(), s.smoothing(),
                     s.curvature(), s.scanlines(), s.maskType(), s.dotPitch(),
                     s.curvatureMode(), s.noise(), s.scalingMode(), s.borderSize()]) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('boolean drive/tape settings default to expected on/off values', async () => {
    const s = await load();
    expect(s.diskSoundA()).toBe(true);    // 'on' default
    expect(s.writeProtectA()).toBe(false); // 'off' default
    expect(s.tapeAutoRewind()).toBe(true);
    expect(s.multifaceEnabled()).toBe(false);
  });

  it('string settings default to their documented values', async () => {
    const s = await load();
    expect(s.joyP1()).toBe('kempston');
    expect(s.joyP2()).toBe('sinclair2');
    expect(s.monitor()).toBe('raw');
    expect(s.renderer()).toBe('webgl');
    expect(s.colorMap()).toBe('measured');
    expect(s.cpcColorMap()).toBe('gate-array');
    expect(s.msxColorMap()).toBe('pal');
    expect(s.einsteinColorMap()).toBe('accurate');
    expect(s.scanlineAccuracy()).toBe('high');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Numeric parsing — NaN handling
// ─────────────────────────────────────────────────────────────────────────

describe('settings — numeric parsing', () => {
  it('parses a valid stored number', async () => {
    storage.store.set('zx84-scale', '4');
    const s = await load();
    expect(s.scale()).toBe(4);
  });

  it('falls back to the default when the stored value is non-numeric', async () => {
    storage.store.set('zx84-scale', 'banana');
    const s = await load();
    expect(s.scale()).toBe(2); // documented default
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Gamepad JSON
// ─────────────────────────────────────────────────────────────────────────

describe('settings — gamepad config', () => {
  it('loads to null when nothing is stored', async () => {
    const s = await load();
    expect(s.gamepadConfigP1()).toBeNull();
    expect(s.gamepadConfigP2()).toBeNull();
  });

  it('loads to null on malformed JSON without crashing', async () => {
    storage.store.set('zx84-gamepad-config-p1', '{not json');
    const s = await load();
    expect(s.gamepadConfigP1()).toBeNull();
  });

  it('saveGamepadConfig round-trips through JSON', async () => {
    const s = await load();
    const cfg: import('@/store/settings.ts').GamepadConfig = {
      deadzone: [0.1, 0.1, 0.1, 0.1],
      up:    { type: 'axis',   index: 1, direction: 'negative' },
      down:  { type: 'axis',   index: 1, direction: 'positive' },
      left:  { type: 'axis',   index: 0, direction: 'negative' },
      right: { type: 'axis',   index: 0, direction: 'positive' },
      fire:  { type: 'button', index: 0 },
    };
    s.saveGamepadConfig(1, cfg);
    expect(s.gamepadConfigP1()).toEqual(cfg);
    // And it must have hit localStorage so a reload would pick it up.
    expect(storage.store.get('zx84-gamepad-config-p1')).toBe(JSON.stringify(cfg));
  });

  it('saveGamepadConfig writes to the requested player slot only', async () => {
    const s = await load();
    const cfg: import('@/store/settings.ts').GamepadConfig = {
      deadzone: [0, 0, 0, 0],
      up: { type: 'button', index: 1 }, down: { type: 'button', index: 2 },
      left: { type: 'button', index: 3 }, right: { type: 'button', index: 4 },
      fire: { type: 'button', index: 5 },
    };
    s.saveGamepadConfig(2, cfg);
    expect(s.gamepadConfigP2()).toEqual(cfg);
    expect(s.gamepadConfigP1()).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// resetSettingsGroup — the dual-source-of-truth audit
// ─────────────────────────────────────────────────────────────────────────

/**
 * Each setting's default exists in TWO places:
 *   1. The fallback string in the createSignal at module init.
 *   2. The `default` field in PANE_SETTINGS used by resetSettingsGroup.
 *
 * These must agree — pressing "Reset" should give the same value the user
 * would see on a fresh install. If they disagree, that is a bug per
 * CLAUDE.md ("two places computing the same thing with different values
 * = bug factory"). The tests below probe every pane.
 */

describe('settings — reset defaults vs initial defaults consistency', () => {
  it('display pane: reset gives the same values as fresh boot', async () => {
    const s = await load();
    const before = {
      scale: s.scale(), scalingMode: s.scalingMode(),
      borderSize: s.borderSize(), colorMap: s.colorMap(),
      cpcColorMap: s.cpcColorMap(), msxColorMap: s.msxColorMap(),
      einsteinColorMap: s.einsteinColorMap(),
      scanlineAccuracy: s.scanlineAccuracy(),
    };
    // Dirty a few so reset has something to do.
    s.setScale(7); s.setBorderSize(99);
    s.setCpcColorMap('asic'); s.setMsxColorMap('ntsc'); s.setEinsteinColorMap('naive');
    s.resetSettingsGroup('display');
    const after = {
      scale: s.scale(), scalingMode: s.scalingMode(),
      borderSize: s.borderSize(), colorMap: s.colorMap(),
      cpcColorMap: s.cpcColorMap(), msxColorMap: s.msxColorMap(),
      einsteinColorMap: s.einsteinColorMap(),
      scanlineAccuracy: s.scanlineAccuracy(),
    };
    expect(after).toEqual(before);
  });

  it('monitor pane: reset gives the same values as fresh boot', async () => {
    const s = await load();
    const before = {
      brightness: s.brightness(), contrast: s.contrast(),
      smoothing: s.smoothing(), curvature: s.curvature(), scanlines: s.scanlines(),
      maskType: s.maskType(), dotPitch: s.dotPitch(), curvatureMode: s.curvatureMode(),
      noise: s.noise(), monitor: s.monitor(),
    };
    // Dirty a few so reset has something to do.
    s.setBrightness(25); s.setContrast(90); s.setMonitor('greenscreen');
    s.setMaskType(3); s.setCurvatureMode(1);
    s.resetSettingsGroup('monitor');
    const after = {
      brightness: s.brightness(), contrast: s.contrast(),
      smoothing: s.smoothing(), curvature: s.curvature(), scanlines: s.scanlines(),
      maskType: s.maskType(), dotPitch: s.dotPitch(), curvatureMode: s.curvatureMode(),
      noise: s.noise(), monitor: s.monitor(),
    };
    expect(after).toEqual(before);
  });

  it('sound pane: reset gives the same values as fresh boot', async () => {
    const s = await load();
    const before = { volume: s.volume(), ayMix: s.ayMix(), ayStereo: s.ayStereo() };
    s.setVolume(13); s.setAyStereo('XYZ');
    s.resetSettingsGroup('sound');
    expect({ volume: s.volume(), ayMix: s.ayMix(), ayStereo: s.ayStereo() }).toEqual(before);
  });

  it('joystick pane: reset gives the same values as fresh boot', async () => {
    const s = await load();
    const before = { joyP1: s.joyP1(), joyP2: s.joyP2(), joyMapP1: s.joyMapP1(), joyMapP2: s.joyMapP2() };
    s.setJoyP1('cursor'); s.setJoyMapP2('keyboard');
    s.resetSettingsGroup('joystick');
    expect({ joyP1: s.joyP1(), joyP2: s.joyP2(), joyMapP1: s.joyMapP1(), joyMapP2: s.joyMapP2() }).toEqual(before);
  });

  it('drive pane: reset gives the same values as fresh boot', async () => {
    const s = await load();
    const before = {
      diskSoundA: s.diskSoundA(), diskSoundB: s.diskSoundB(),
      writeProtectA: s.writeProtectA(), writeProtectB: s.writeProtectB(),
      driveBForceReady: s.driveBForceReady(),
    };
    s.setDiskSoundA(false); s.setWriteProtectB(true);
    s.resetSettingsGroup('drive');
    expect({
      diskSoundA: s.diskSoundA(), diskSoundB: s.diskSoundB(),
      writeProtectA: s.writeProtectA(), writeProtectB: s.writeProtectB(),
      driveBForceReady: s.driveBForceReady(),
    }).toEqual(before);
  });

  it('tape pane: reset gives the same values as fresh boot', async () => {
    const s = await load();
    const before = {
      tapeAutoRewind: s.tapeAutoRewind(), tapeCollapseBlocks: s.tapeCollapseBlocks(),
      tapeFastRom: s.tapeFastRom(), tapeTurbo: s.tapeTurbo(),
      tapeSoundEnabled: s.tapeSoundEnabled(),
    };
    s.setTapeAutoRewind(false);
    s.resetSettingsGroup('tape');
    expect({
      tapeAutoRewind: s.tapeAutoRewind(), tapeCollapseBlocks: s.tapeCollapseBlocks(),
      tapeFastRom: s.tapeFastRom(), tapeTurbo: s.tapeTurbo(),
      tapeSoundEnabled: s.tapeSoundEnabled(),
    }).toEqual(before);
  });

  it('hardware pane: reset gives the same values as fresh boot', async () => {
    const s = await load();
    const before = {
      multifaceEnabled: s.multifaceEnabled(),
      plus3V41Roms: s.plus3V41Roms(),
      vtx5000Enabled: s.vtx5000Enabled(),
    };
    s.setMultifaceEnabled(true); s.setVtx5000Enabled(true);
    s.resetSettingsGroup('hardware');
    expect({
      multifaceEnabled: s.multifaceEnabled(),
      plus3V41Roms: s.plus3V41Roms(),
      vtx5000Enabled: s.vtx5000Enabled(),
    }).toEqual(before);
  });

  it('font pane: reset gives the same value as fresh boot', async () => {
    const s = await load();
    const before = s.fontName();
    s.setFontName('Comic Sans');
    s.resetSettingsGroup('font');
    expect(s.fontName()).toBe(before);
  });

  it('text pane: reset gives the same values as fresh boot', async () => {
    const s = await load();
    const before = {
      ocrFont: s.ocrFont(), ocrLineHeight: s.ocrLineHeight(),
      ocrTracking: s.ocrTracking(), ocrOffsetX: s.ocrOffsetX(), ocrOffsetY: s.ocrOffsetY(),
      ocrScaleX: s.ocrScaleX(), ocrScaleY: s.ocrScaleY(),
    };
    s.setOcrTracking(99);
    s.resetSettingsGroup('text');
    expect({
      ocrFont: s.ocrFont(), ocrLineHeight: s.ocrLineHeight(),
      ocrTracking: s.ocrTracking(), ocrOffsetX: s.ocrOffsetX(), ocrOffsetY: s.ocrOffsetY(),
      ocrScaleX: s.ocrScaleX(), ocrScaleY: s.ocrScaleY(),
    }).toEqual(before);
  });

  it('resetSettingsGroup is a no-op for an unknown group', async () => {
    const s = await load();
    const scaleBefore = s.scale();
    s.setScale(5);
    s.resetSettingsGroup('not-a-real-group');
    expect(s.scale()).toBe(5);
    expect(scaleBefore).not.toBe(5); // sanity: we actually changed it
  });
});

// ─────────────────────────────────────────────────────────────────────────
// persistSetting
// ─────────────────────────────────────────────────────────────────────────

describe('persistSetting', () => {
  it('writes the value to localStorage under the namespaced key', async () => {
    const s = await load();
    s.persistSetting('foo', 42);
    expect(storage.store.get('zx84-foo')).toBe('42');
  });

  it('coerces non-string values via String()', async () => {
    const s = await load();
    s.persistSetting('flag', true as unknown as string);
    expect(storage.store.get('zx84-flag')).toBe('true');
  });
});
