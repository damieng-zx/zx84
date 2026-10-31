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
    for (const v of [s.scale(), s.brightness(), s.contrast(), s.saturation(), s.gamma(), s.smoothing(),
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
    expect(s.uspeechEnabled()).toBe(false);
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

describe('settings — stored on/off and text values', () => {
  it("reads a stored 'on' as true for a flag that defaults to off", async () => {
    storage.store.set('zx84-multiface', 'on');
    const s = await load();
    expect(s.multifaceEnabled()).toBe(true);
  });

  it("reads a stored 'off' as false for a flag that defaults to on", async () => {
    storage.store.set('zx84-tape-sound', 'off');
    const s = await load();
    expect(s.tapeSoundEnabled()).toBe(false);
  });

  it('reads a stored string setting verbatim', async () => {
    storage.store.set('zx84-monitor', 'green');
    const s = await load();
    expect(s.monitor()).toBe('green');
  });

  it('keeps a setter bound to its own signal', async () => {
    const s = await load();
    s.setScale(5);
    expect(s.scale()).toBe(5);
    expect(s.brightness()).toBe(0);
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
      saturation: s.saturation(), gamma: s.gamma(),
      smoothing: s.smoothing(), curvature: s.curvature(), scanlines: s.scanlines(),
      maskType: s.maskType(), dotPitch: s.dotPitch(), curvatureMode: s.curvatureMode(),
      noise: s.noise(), monitor: s.monitor(),
    };
    // Dirty a few so reset has something to do.
    s.setBrightness(25); s.setContrast(90); s.setMonitor('greenscreen');
    s.setSaturation(80); s.setGamma(-20);
    s.setMaskType(3); s.setCurvatureMode(1);
    s.resetSettingsGroup('monitor');
    const after = {
      brightness: s.brightness(), contrast: s.contrast(),
      saturation: s.saturation(), gamma: s.gamma(),
      smoothing: s.smoothing(), curvature: s.curvature(), scanlines: s.scanlines(),
      maskType: s.maskType(), dotPitch: s.dotPitch(), curvatureMode: s.curvatureMode(),
      noise: s.noise(), monitor: s.monitor(),
    };
    expect(after).toEqual(before);
  });

  it('sound pane: reset gives the same values as fresh boot', async () => {
    const s = await load();
    const before = {
      volume: s.volume(), beeper: s.beeperVolume(), psg: s.psgVolume(),
      specdrum: s.specdrumVolume(), uspeech: s.uspeechVolume(), ayStereo: s.ayStereo(),
    };
    s.setVolume(13); s.setAyStereo('XYZ');
    s.setBeeperVolume(5); s.setPsgVolume(6); s.setSpecdrumVolume(7); s.setUspeechVolume(8);
    s.resetSettingsGroup('sound');
    expect({
      volume: s.volume(), beeper: s.beeperVolume(), psg: s.psgVolume(),
      specdrum: s.specdrumVolume(), uspeech: s.uspeechVolume(), ayStereo: s.ayStereo(),
    }).toEqual(before);
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
      vtx5000Enabled: s.vtx5000Enabled(),
      mtxCpm: s.mtxCpm(),
      mtx80Column: s.mtx80Column(),
      mtx512kRam: s.mtx512kRam(),
    };
    s.setMultifaceEnabled(true); s.setVtx5000Enabled(true);
    s.setMtxCpm(true); s.setMtx80Column(true); s.setMtx512kRam(true);
    s.resetSettingsGroup('hardware');
    expect({
      multifaceEnabled: s.multifaceEnabled(),
      vtx5000Enabled: s.vtx5000Enabled(),
      mtxCpm: s.mtxCpm(),
      mtx80Column: s.mtx80Column(),
      mtx512kRam: s.mtx512kRam(),
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

// ─────────────────────────────────────────────────────────────────────────
// Built-in drive count
// ─────────────────────────────────────────────────────────────────────────

describe('settings — built-in drive count', () => {
  it('fits every drive until a count is chosen', async () => {
    const s = await load();
    expect(s.driveCountFor('lynx', 4)).toBe(4);
    expect(s.driveCountFor('cpc', 2)).toBe(2);
  });

  it('keeps a count per machine kind and persists it', async () => {
    const s = await load();
    s.setDriveCountFor('apple2', 1);
    expect(s.driveCountFor('apple2', 2)).toBe(1);
    expect(s.driveCountFor('bbc', 2)).toBe(2);
    expect(JSON.parse(storage.store.get('zx84-drive-counts')!)).toEqual({ apple2: 1 });
  });

  it('restores a saved count after a reload', async () => {
    storage.store.set('zx84-drive-counts', JSON.stringify({ lynx: 3 }));
    const s = await load();
    expect(s.driveCountFor('lynx', 4)).toBe(3);
  });

  it('holds a saved count to what the current model can take', async () => {
    storage.store.set('zx84-drive-counts', JSON.stringify({ lynx: 4 }));
    const s = await load();
    expect(s.driveCountFor('lynx', 2)).toBe(2);       // a two-drive Lynx
    expect(s.driveCountFor('lynx', 4)).toBe(4);       // the choice survives for a four-drive one
  });

  it('ignores a corrupted entry', async () => {
    storage.store.set('zx84-drive-counts', '{not json');
    const s = await load();
    expect(s.driveCountFor('lynx', 4)).toBe(4);
    storage.store.set('zx84-drive-counts', JSON.stringify({ lynx: 0, cpc: 'two', bbc: -1 }));
    expect((await load()).driveCountFor('cpc', 2)).toBe(2);
  });

  it('carries over the Apple II count from its old Hardware-pane option', async () => {
    storage.store.set('zx84-apple2-drives', '1');
    const s = await load();
    expect(s.driveCountFor('apple2', 2)).toBe(1);
  });

  it('resets to every drive with the Drives pane', async () => {
    const s = await load();
    s.setDriveCountFor('bbc', 1);
    s.resetSettingsGroup('drive');
    expect(s.driveCountFor('bbc', 2)).toBe(2);
    expect(storage.store.get('zx84-drive-counts')).toBe('{}');
  });
});

describe('settings — SpecDrum', () => {
  it('defaults to not fitted, volume 100', async () => {
    const s = await load();
    expect(s.specdrumEnabled()).toBe(false);
    expect(s.specdrumVolume()).toBe(100);
  });

  it('reads saved values', async () => {
    storage.store.set('zx84-specdrum', 'on');
    storage.store.set('zx84-specdrum-volume', '35');
    const s = await load();
    expect(s.specdrumEnabled()).toBe(true);
    expect(s.specdrumVolume()).toBe(35);
  });

  it('the Sound-pane reset restores the volume, the Hardware reset removes the board', async () => {
    const s = await load();
    s.setSpecdrumVolume(10);
    s.persistSetting('specdrum-volume', 10);
    s.resetSettingsGroup('sound');
    expect(s.specdrumVolume()).toBe(100);
    s.setSpecdrumEnabled(true);
    s.resetSettingsGroup('hardware');
    expect(s.specdrumEnabled()).toBe(false);
  });

  it('exposes the volume signal under the key a descriptor names', async () => {
    const s = await load();
    const [get, set] = s.DEVICE_VOLUMES['specdrum-volume']!;
    set(64);
    expect(get()).toBe(64);
    expect(s.specdrumVolume()).toBe(64);
  });
});

describe('settings — per-device sound volumes', () => {
  it('default to unity (100) for every device', async () => {
    const s = await load();
    expect([s.beeperVolume(), s.psgVolume(), s.specdrumVolume(), s.uspeechVolume()]).toEqual([100, 100, 100, 100]);
  });

  it('read saved values and ignore a corrupted one', async () => {
    storage.store.set('zx84-beeper-volume', '25');
    storage.store.set('zx84-psg-volume', 'loud');
    storage.store.set('zx84-uspeech-volume', '150');
    const s = await load();
    expect(s.beeperVolume()).toBe(25);
    expect(s.psgVolume()).toBe(100);       // NaN falls back to the default
    expect(s.uspeechVolume()).toBe(150);
  });

  it('every volume key a descriptor can name has a signal to drive its slider', async () => {
    const s = await load();
    expect(Object.keys(s.DEVICE_VOLUMES).sort()).toEqual(['beeper-volume', 'psg-volume', 'specdrum-volume', 'uspeech-volume']);
    const [get, set] = s.DEVICE_VOLUMES['psg-volume']!;
    set(42);
    expect(get()).toBe(42);
    expect(s.psgVolume()).toBe(42);
  });

  it('persistSetting stores them under the plain key, where the next boot reads them', async () => {
    const s = await load();
    s.persistSetting('beeper-volume', 33);
    expect(storage.store.get('zx84-beeper-volume')).toBe('33');
    vi.resetModules();
    expect((await load()).beeperVolume()).toBe(33);
  });

  it('the Sound-pane reset puts them back to 100 and rewrites the saved values', async () => {
    const s = await load();
    s.setBeeperVolume(10); s.persistSetting('beeper-volume', 10);
    s.setPsgVolume(20); s.setUspeechVolume(30);
    s.resetSettingsGroup('sound');
    expect([s.beeperVolume(), s.psgVolume(), s.uspeechVolume()]).toEqual([100, 100, 100]);
    expect(storage.store.get('zx84-beeper-volume')).toBe('100');
  });

  // The old single Beep↔PSG balance ('ay-mix') is gone; a balance the user had
  // set is carried into the per-device sliders: the centre keeps both at unity
  // and each end fades the other source out.
  describe('migration from the old balance slider', () => {
    it.each([
      ['50', 100, 100],   // centre: both at unity
      ['0', 100, 0],      // all beeper: PSG silent
      ['100', 0, 100],    // all PSG: beeper silent
      ['25', 100, 50],    // a quarter towards the beeper: PSG at half
      ['75', 50, 100],
    ])('ay-mix %s → beeper %i, PSG %i', async (mix, beeper, psg) => {
      storage.store.set('zx84-ay-mix', mix);
      const s = await load();
      expect([s.beeperVolume(), s.psgVolume()]).toEqual([beeper, psg]);
    });

    it('a per-device volume saved by this build wins over the old balance', async () => {
      storage.store.set('zx84-ay-mix', '100');
      storage.store.set('zx84-beeper-volume', '80');
      const s = await load();
      expect(s.beeperVolume()).toBe(80);
      expect(s.psgVolume()).toBe(100);   // not saved: derived from ay-mix 100
    });

    it('a garbage old balance is ignored', async () => {
      storage.store.set('zx84-ay-mix', 'x');
      const s = await load();
      expect([s.beeperVolume(), s.psgVolume()]).toEqual([100, 100]);
    });
  });
});

