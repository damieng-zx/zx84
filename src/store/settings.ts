/**
 * Persisted display/sound/joystick settings as signals.
 *
 * Every persisted setting is declared once, in the `SETTINGS` catalogue below:
 * its default, the reset group (pane) whose Reset button clears it, and how a
 * stored string is coerced. The signal itself is declared further down and
 * registers under its catalogue key as it is created, so the reset path and the
 * shell's `SettingsView` both reach a value through that one key.
 *
 * Three hand-kept tables used to describe the same keys — the defaults, the
 * pane→key groups for Reset, and the shell's getter map — and drifted apart. A
 * setting is one catalogue entry now, and `settings.test.ts` proves the
 * catalogue, the signals and their defaults agree.
 */

import { createSignal, createMemo, createRoot, type Signal } from 'solid-js';
import { getSaved, setSaved } from '@/store/persistence.ts';
import { parsePhosphor } from '@/display/phosphor.ts';

/**
 * One persisted setting:
 *
 * - `def`  — the string a fresh install boots with (and what Reset writes back).
 * - `pane` — the reset group its pane selects.
 * - `kind` — how a stored string becomes the value: `number`, `bool` ('on'/'off')
 *             or `string` (verbatim).
 */
export interface SettingDef {
  readonly def: string;
  readonly pane: string;
  readonly kind: 'number' | 'bool' | 'string';
}

/** The one catalogue. Adding a setting is an entry here plus its signal below. */
export const SETTINGS = {
  // ── display
  'scale': { def: '2', pane: 'display', kind: 'number' },
  'scaling-mode': { def: '0', pane: 'display', kind: 'number' },
  'border-size': { def: '1', pane: 'display', kind: 'number' },
  'color-map': { def: 'measured', pane: 'display', kind: 'string' },
  'cpc-color-map': { def: 'gate-array', pane: 'display', kind: 'string' },
  'msx-color-map': { def: 'pal', pane: 'display', kind: 'string' },
  'einstein-color-map': { def: 'accurate', pane: 'display', kind: 'string' },
  'bbc-color-map': { def: 'pal', pane: 'display', kind: 'string' },
  'apple2-video': { def: 'ntsc', pane: 'display', kind: 'string' },
  'atari-color-map': { def: 'tv', pane: 'display', kind: 'string' },
  'scanline-accuracy': { def: 'high', pane: 'display', kind: 'string' },

  // ── monitor
  'brightness': { def: '0', pane: 'monitor', kind: 'number' },
  'contrast': { def: '50', pane: 'monitor', kind: 'number' },
  'saturation': { def: '50', pane: 'monitor', kind: 'number' },
  'gamma': { def: '0', pane: 'monitor', kind: 'number' },
  'smoothing': { def: '0', pane: 'monitor', kind: 'number' },
  'curvature': { def: '0', pane: 'monitor', kind: 'number' },
  'scanlines': { def: '0', pane: 'monitor', kind: 'number' },
  'mask-type': { def: '0', pane: 'monitor', kind: 'number' },
  'dot-pitch': { def: '10', pane: 'monitor', kind: 'number' },
  'curvature-mode': { def: '0', pane: 'monitor', kind: 'number' },
  'noise': { def: '0', pane: 'monitor', kind: 'number' },
  'monitor': { def: 'raw', pane: 'monitor', kind: 'string' },
  'phosphor': { def: 'color', pane: 'monitor', kind: 'string' },

  // ── sound
  'volume': { def: '70', pane: 'sound', kind: 'number' },
  'beeper-volume': { def: '100', pane: 'sound', kind: 'number' },
  'psg-volume': { def: '100', pane: 'sound', kind: 'number' },
  'ay-stereo': { def: 'ABC', pane: 'sound', kind: 'string' },
  'sn-stereo': { def: 'MONO', pane: 'sound', kind: 'string' },
  'ay-antialias': { def: 'mute', pane: 'sound', kind: 'string' },
  'specdrum-volume': { def: '100', pane: 'sound', kind: 'number' },
  'uspeech-volume': { def: '100', pane: 'sound', kind: 'number' },
  'scc-volume': { def: '100', pane: 'sound', kind: 'number' },
  'c64-sid': { def: '6581', pane: 'sound', kind: 'string' },

  // ── joystick
  'joy-p1': { def: 'kempston', pane: 'joystick', kind: 'string' },
  'joy-p2': { def: 'sinclair2', pane: 'joystick', kind: 'string' },
  'joy-map-p1': { def: 'none', pane: 'joystick', kind: 'string' },
  'joy-map-p2': { def: 'none', pane: 'joystick', kind: 'string' },

  // ── font
  'font': { def: '', pane: 'font', kind: 'string' },

  // ── text
  'ocr-font': { def: 'JetBrains Mono', pane: 'text', kind: 'string' },
  'ocr-line-height': { def: '100', pane: 'text', kind: 'number' },
  'ocr-tracking': { def: '0', pane: 'text', kind: 'number' },
  'ocr-offset-x': { def: '3', pane: 'text', kind: 'number' },
  'ocr-offset-y': { def: '3', pane: 'text', kind: 'number' },
  'ocr-scale-x': { def: '100', pane: 'text', kind: 'number' },
  'ocr-scale-y': { def: '100', pane: 'text', kind: 'number' },

  // ── drive
  'disk-sound-a': { def: 'on', pane: 'drive', kind: 'bool' },
  'disk-sound-b': { def: 'on', pane: 'drive', kind: 'bool' },
  'write-protect-a': { def: 'off', pane: 'drive', kind: 'bool' },
  'write-protect-b': { def: 'off', pane: 'drive', kind: 'bool' },
  'drive-b-force-ready': { def: 'off', pane: 'drive', kind: 'bool' },
  'disk-sound-c': { def: 'on', pane: 'drive', kind: 'bool' },
  'disk-sound-d': { def: 'on', pane: 'drive', kind: 'bool' },
  'write-protect-c': { def: 'off', pane: 'drive', kind: 'bool' },
  'write-protect-d': { def: 'off', pane: 'drive', kind: 'bool' },
  'drive-counts': { def: '{}', pane: 'drive', kind: 'string' },
  'drive-models': { def: '{}', pane: 'drive', kind: 'string' },

  // ── tape
  'tape-auto-rewind': { def: 'on', pane: 'tape', kind: 'bool' },
  'tape-collapse-blocks': { def: 'on', pane: 'tape', kind: 'bool' },
  'tape-instant-rom': { def: 'on', pane: 'tape', kind: 'bool' },
  'tape-turbo-load': { def: 'on', pane: 'tape', kind: 'bool' },
  'tape-sound': { def: 'on', pane: 'tape', kind: 'bool' },

  // ── hardware
  'multiface': { def: 'off', pane: 'hardware', kind: 'bool' },
  'vtx5000': { def: 'off', pane: 'hardware', kind: 'bool' },
  'specdrum': { def: 'off', pane: 'hardware', kind: 'bool' },
  'spectrum-issue2': { def: 'off', pane: 'hardware', kind: 'bool' },
  'cpc-parados': { def: 'off', pane: 'hardware', kind: 'bool' },
  'cpc-crtc-type': { def: '0', pane: 'hardware', kind: 'string' },
  'cpc-ram-expansion': { def: 'none', pane: 'hardware', kind: 'string' },
  'cpc-ddi1': { def: 'off', pane: 'hardware', kind: 'bool' },
  'cpc-manufacturer': { def: 'amstrad', pane: 'hardware', kind: 'string' },
  'cpc-refresh': { def: '50', pane: 'hardware', kind: 'string' },
  'plusd': { def: 'off', pane: 'hardware', kind: 'bool' },
  'interface1': { def: 'off', pane: 'hardware', kind: 'bool' },
  'betadisk': { def: 'off', pane: 'hardware', kind: 'bool' },
  'uspeech': { def: 'off', pane: 'hardware', kind: 'bool' },
  'einstein-xtaldos': { def: 'on', pane: 'hardware', kind: 'bool' },
  'mtx-cpm': { def: 'off', pane: 'hardware', kind: 'bool' },
  'mtx-80-column': { def: 'off', pane: 'hardware', kind: 'bool' },
  'mtx-512k-ram': { def: 'off', pane: 'hardware', kind: 'bool' },
  'mtx-floppy': { def: 'on', pane: 'hardware', kind: 'bool' },
  'msx-floppy': { def: 'off', pane: 'hardware', kind: 'bool' },
  'bbc-disk-system': { def: '1770', pane: 'hardware', kind: 'string' },
  'bbc-swr': { def: '0', pane: 'hardware', kind: 'string' },
  'electron-plus1': { def: 'off', pane: 'hardware', kind: 'bool' },
  'electron-plus3': { def: 'off', pane: 'hardware', kind: 'bool' },
  'electron-dfs': { def: 'off', pane: 'hardware', kind: 'bool' },
  'lynx-fdc': { def: 'on', pane: 'hardware', kind: 'bool' },
  'pcw-60hz': { def: 'off', pane: 'hardware', kind: 'bool' },
  'pcw-phosphor': { def: 'auto', pane: 'hardware', kind: 'string' },
  'apple2-disk2': { def: 'on', pane: 'hardware', kind: 'bool' },
  'c64-drive': { def: 'on', pane: 'hardware', kind: 'bool' },
  'vic20-ram': { def: 'none', pane: 'hardware', kind: 'string' },
  'vic20-blk5': { def: 'off', pane: 'hardware', kind: 'bool' },
  'vic20-drive': { def: 'on', pane: 'hardware', kind: 'bool' },
  'c128-drive': { def: 'on', pane: 'hardware', kind: 'bool' },
  'c128-vdc-ram': { def: '16k', pane: 'hardware', kind: 'string' },
  'c128-vdc-chip': { def: 'r8', pane: 'hardware', kind: 'string' },
  'c128-display': { def: 'auto', pane: 'hardware', kind: 'string' },
  'plus4-drive': { def: 'on', pane: 'hardware', kind: 'bool' },
  'plus4-expansion': { def: 'none', pane: 'hardware', kind: 'string' },
  'apple2-langcard': { def: 'on', pane: 'hardware', kind: 'bool' },
  'apple2-joystick': { def: 'on', pane: 'hardware', kind: 'bool' },
  'apple2-mockingboard': { def: 'off', pane: 'hardware', kind: 'bool' },
  'apple2-80col': { def: 'off', pane: 'hardware', kind: 'bool' },
  'apple2e-80col': { def: 'on', pane: 'hardware', kind: 'bool' },
  'apple1-ram': { def: '8k', pane: 'hardware', kind: 'string' },
  'apple1-basic-ram': { def: 'on', pane: 'hardware', kind: 'bool' },
  'apple1-aci': { def: 'off', pane: 'hardware', kind: 'bool' },
  'atom-ram': { def: '12k', pane: 'hardware', kind: 'string' },
  'oric-microdisc': { def: 'off', pane: 'hardware', kind: 'bool' },
  'enterprise-exdos': { def: 'on', pane: 'hardware', kind: 'bool' },
  'zx8x-16k-ram': { def: 'off', pane: 'hardware', kind: 'bool' },
  'zx81-udg-ram': { def: 'off', pane: 'hardware', kind: 'bool' },
  'zx81-udg128-ram': { def: 'off', pane: 'hardware', kind: 'bool' },
  'zx81-wrx-hires': { def: 'off', pane: 'hardware', kind: 'bool' },
  'zx81-memotech-hrg': { def: 'off', pane: 'hardware', kind: 'bool' },
  'zx81-quicksilva-hrg': { def: 'off', pane: 'hardware', kind: 'bool' },
  'zx81-zx-printer': { def: 'off', pane: 'hardware', kind: 'bool' },
  'zx81-chroma81': { def: 'off', pane: 'hardware', kind: 'bool' },
  'zx8x-zonx': { def: 'off', pane: 'hardware', kind: 'bool' },
  'zx8x-vsync-sound': { def: 'off', pane: 'hardware', kind: 'bool' },
  'ace-ram-pack': { def: '48k', pane: 'hardware', kind: 'string' },

  // ── misc (not reset by any pane)
  'renderer': { def: 'webgl', pane: 'misc', kind: 'string' },
  'pause-on-blur': { def: 'on', pane: 'misc', kind: 'bool' },
} satisfies Record<string, SettingDef>;

type SettingKey = keyof typeof SETTINGS;
const D = (k: SettingKey): string => SETTINGS[k].def;

/** A module-level signal, created in its own root so it outlives any component. */
const signal = <T>(initial: T): Signal<T> => createRoot(() => createSignal(initial));

/**
 * The signal behind each catalogue key, filled in as the signals below are
 * created. The catalogue is therefore pure data — it can be read before any
 * signal exists — and everything else reaches a value through `settingValue` /
 * `setFlagSetting` / the shell's view, never through its own copy of the wiring.
 */
const SIGNALS = new Map<string, { get: () => unknown; set: (value: unknown) => void }>();

/** Create a stored setting's signal and register it under its catalogue key. */
function setting<T>(key: SettingKey, initial: T): Signal<T> {
  const sig = signal(initial);
  SIGNALS.set(key, {
    get: sig[0] as () => unknown,
    set: sig[1] as (value: unknown) => void,
  });
  return sig;
}

// ── Display settings ────────────────────────────────────────────────────

function getSavedNumber(key: string, fallback: string): number {
  const n = Number(getSaved(key, fallback));
  // A corrupted localStorage entry (older build, manual edit, future bug)
  // would otherwise leak NaN into renderers, audio mixing, etc. Treat any
  // non-finite parse as if the key were absent.
  return Number.isFinite(n) ? n : Number(fallback);
}

/** A setting's saved value, or its default. */
const savedText = (key: SettingKey): string => getSaved(key, D(key));
const savedNumber = (key: SettingKey): number => getSavedNumber(key, D(key));
/** An on/off setting, stored as the strings 'on' / 'off'. */
const savedFlag = (key: SettingKey): boolean => savedText(key) === 'on';

export const [scale, setScale] = setting('scale', savedNumber('scale'));
export const [brightness, setBrightness] = setting('brightness', savedNumber('brightness'));
export const [contrast, setContrast] = setting('contrast', savedNumber('contrast'));
export const [saturation, setSaturation] = setting('saturation', savedNumber('saturation'));
export const [gamma, setGamma] = setting('gamma', savedNumber('gamma'));
export const [smoothing, setSmoothing] = setting('smoothing', savedNumber('smoothing'));
export const [curvature, setCurvature] = setting('curvature', savedNumber('curvature'));
export const [scanlines, setScanlines] = setting('scanlines', savedNumber('scanlines'));
export const [maskType, setMaskType] = setting('mask-type', savedNumber('mask-type'));
export const [dotPitch, setDotPitch] = setting('dot-pitch', savedNumber('dot-pitch'));
export const [curvatureMode, setCurvatureMode] = setting('curvature-mode', savedNumber('curvature-mode'));
export const [noise, setNoise] = setting('noise', savedNumber('noise'));
export const [scalingMode, setScalingMode] = setting('scaling-mode', savedNumber('scaling-mode'));

// The Apple II's old 'green' video mode is now the generic green phosphor over its
// mono picture: migrate the saved choice once.
const legacyApple2Green = getSaved('apple2-video', '') === 'green';
if (legacyApple2Green) {
  setSaved('apple2-video', 'mono');
  if (getSaved('phosphor', '') === '') setSaved('phosphor', 'green');
}

export const [phosphor, setPhosphor] = setting('phosphor', parsePhosphor(savedText('phosphor')));
export const [monitor, setMonitor] = setting('monitor', savedText('monitor'));
export const [borderSize, setBorderSize] = setting('border-size', savedNumber('border-size'));
export const [renderer, setRenderer] = setting('renderer', savedText('renderer') as 'webgl' | 'canvas');

// Runtime-only: cleared when WebGL context creation fails so the UI can
// hide the option and emulator.ts can avoid retrying.
export const [webglAvailable, setWebglAvailable] = signal(true);
export const [colorMap, setColorMap] = setting('color-map', savedText('color-map') as 'basic' | 'measured' | 'vivid');
export const [cpcColorMap, setCpcColorMap] = setting('cpc-color-map', savedText('cpc-color-map') as 'basic' | 'gate-array' | 'asic');
export const [msxColorMap, setMsxColorMap] = setting('msx-color-map', savedText('msx-color-map') as 'pal' | 'ntsc');

export const [einsteinColorMap, setEinsteinColorMap] = setting('einstein-color-map', savedText('einstein-color-map') as 'mame' | 'accurate' | 'naive');

/** Atari palette id (see machines/atari/palette.ts); the machine falls back
 *  to its region's default for an id that region does not offer. */
export const [atariColorMap, setAtariColorMap] = setting('atari-color-map', savedText('atari-color-map'));
export const [scanlineAccuracy, setScanlineAccuracy] = setting('scanline-accuracy', savedText('scanline-accuracy') as 'high' | 'mid' | 'low');

// ── Sound settings ──────────────────────────────────────────────────────

export const [volume, setVolume] = setting('volume', savedNumber('volume'));

/**
 * A device volume saved by this build, else one derived from the old single
 * Beep↔PSG balance slider ('ay-mix', 0 = all beeper … 100 = all PSG) that the
 * per-device sliders replaced, so a balance the user had set carries over. The
 * old centre kept both at unity and each end faded the other out, hence the
 * `fromBalance` mappings below.
 */
function getSavedVolume(key: SettingKey, fromBalance?: (mix: number) => number): number {
  if (getSaved(key, '') !== '') return getSavedNumber(key, D(key));
  const legacy = getSaved('ay-mix', '');
  const mix = Number(legacy);
  if (fromBalance && legacy !== '' && Number.isFinite(mix)) {
    return Math.round(Math.min(100, Math.max(0, fromBalance(Math.min(100, Math.max(0, mix))))));
  }
  return Number(D(key));
}

export const [beeperVolume, setBeeperVolume] = setting('beeper-volume', getSavedVolume('beeper-volume', (m) => 2 * (100 - m)));
export const [psgVolume, setPsgVolume] = setting('psg-volume', getSavedVolume('psg-volume', (m) => 2 * m));
export const [ayStereo, setAyStereo] = setting('ay-stereo', savedText('ay-stereo'));
export const [snStereo, setSnStereo] = setting('sn-stereo', savedText('sn-stereo'));

export const [ayAntialias, setAyAntialias] = setting('ay-antialias', savedText('ay-antialias'));
export const [specdrumVolume, setSpecdrumVolume] = setting('specdrum-volume', savedNumber('specdrum-volume'));
export const [uspeechVolume, setUspeechVolume] = setting('uspeech-volume', savedNumber('uspeech-volume'));
export const [sccVolume, setSccVolume] = setting('scc-volume', savedNumber('scc-volume'));

/** Per-device Sound-pane volume signals, keyed by the setting a machine
 *  descriptor names in `soundDevices[].volumeSetting` — so the generic pane
 *  can drive a slider from the descriptor without knowing which device it is. */
export const DEVICE_VOLUMES: Readonly<Record<string, readonly [() => number, (v: number) => void]>> = {
  'beeper-volume': [beeperVolume, setBeeperVolume],
  'psg-volume': [psgVolume, setPsgVolume],
  'specdrum-volume': [specdrumVolume, setSpecdrumVolume],
  'uspeech-volume': [uspeechVolume, setUspeechVolume],
  'scc-volume': [sccVolume, setSccVolume],
};

// ── Joystick settings ───────────────────────────────────────────────────

export const [joyP1, setJoyP1] = setting('joy-p1', savedText('joy-p1'));
export const [joyP2, setJoyP2] = setting('joy-p2', savedText('joy-p2'));
export const [joyMapP1, setJoyMapP1] = setting('joy-map-p1', savedText('joy-map-p1'));
export const [joyMapP2, setJoyMapP2] = setting('joy-map-p2', savedText('joy-map-p2'));

// ── Gamepad configuration ───────────────────────────────────────────────

export type GamepadBinding =
  | { type: 'button'; index: number }
  | { type: 'axis'; index: number; direction: 'positive' | 'negative' };

export type GamepadConfig = {
  deadzone: number[]; // Neutral axis positions
  up: GamepadBinding;
  down: GamepadBinding;
  left: GamepadBinding;
  right: GamepadBinding;
  fire: GamepadBinding;
};

function loadGamepadConfig(player: 1 | 2): GamepadConfig | null {
  try {
    const saved = getSaved(`gamepad-config-p${player}`, '');
    return saved ? JSON.parse(saved) : null;
  } catch {
    return null;
  }
}

export const [gamepadConfigP1, setGamepadConfigP1] = signal<GamepadConfig | null>(loadGamepadConfig(1));
export const [gamepadConfigP2, setGamepadConfigP2] = signal<GamepadConfig | null>(loadGamepadConfig(2));

export function saveGamepadConfig(player: 1 | 2, config: GamepadConfig): void {
  if (player === 1) {
    setGamepadConfigP1(config);
  } else {
    setGamepadConfigP2(config);
  }
  setSaved(`gamepad-config-p${player}`, JSON.stringify(config));
}

// ── Font settings ───────────────────────────────────────────────────────

export const [fontName, setFontName] = setting('font', savedText('font'));

// ── Text/OCR overlay settings ──────────────────────────────────────────

export const [ocrFont, setOcrFont] = setting('ocr-font', savedText('ocr-font'));
export const [ocrLineHeight, setOcrLineHeight] = setting('ocr-line-height', savedNumber('ocr-line-height'));
export const [ocrTracking, setOcrTracking] = setting('ocr-tracking', savedNumber('ocr-tracking'));
export const [ocrOffsetX, setOcrOffsetX] = setting('ocr-offset-x', savedNumber('ocr-offset-x'));
export const [ocrOffsetY, setOcrOffsetY] = setting('ocr-offset-y', savedNumber('ocr-offset-y'));
export const [ocrScaleX, setOcrScaleX] = setting('ocr-scale-x', savedNumber('ocr-scale-x'));
export const [ocrScaleY, setOcrScaleY] = setting('ocr-scale-y', savedNumber('ocr-scale-y'));

// ── Disk mode ───────────────────────────────────────────────────────────

export const [diskSoundA, setDiskSoundA] = setting('disk-sound-a', savedFlag('disk-sound-a'));
export const [diskSoundB, setDiskSoundB] = setting('disk-sound-b', savedFlag('disk-sound-b'));
export const [writeProtectA, setWriteProtectA] = setting('write-protect-a', savedFlag('write-protect-a'));
export const [writeProtectB, setWriteProtectB] = setting('write-protect-b', savedFlag('write-protect-b'));
export const [driveBForceReady, setDriveBForceReady] = setting('drive-b-force-ready', savedFlag('drive-b-force-ready'));
export const [diskSoundC, setDiskSoundC] = setting('disk-sound-c', savedFlag('disk-sound-c'));
export const [diskSoundD, setDiskSoundD] = setting('disk-sound-d', savedFlag('disk-sound-d'));
export const [writeProtectC, setWriteProtectC] = setting('write-protect-c', savedFlag('write-protect-c'));
export const [writeProtectD, setWriteProtectD] = setting('write-protect-d', savedFlag('write-protect-d'));

// ── Tape settings ───────────────────────────────────────────────────────

export const [tapeAutoRewind, setTapeAutoRewind] = setting('tape-auto-rewind', savedFlag('tape-auto-rewind'));
export const [tapeCollapseBlocks, setTapeCollapseBlocks] = setting('tape-collapse-blocks', savedFlag('tape-collapse-blocks'));

// Persisted key strings are kept stable ('tape-instant-rom', 'tape-turbo-load')
// so existing saved prefs survive; only the signal names follow the UI wording:
// Fast ROM loading / Turbo while loading.
export const [tapeFastRom, setTapeFastRom] = setting('tape-instant-rom', savedFlag('tape-instant-rom'));
export const [tapeTurbo, setTapeTurbo] = setting('tape-turbo-load', savedFlag('tape-turbo-load'));
export const [tapeSoundEnabled, setTapeSoundEnabled] = setting('tape-sound', savedFlag('tape-sound'));

// ── Multiface ────────────────────────────────────────────────────────

export const [multifaceEnabled, setMultifaceEnabled] = setting('multiface', savedFlag('multiface'));
export const [cpcParados, setCpcParados] = setting('cpc-parados', savedFlag('cpc-parados'));
/** CPC 464/664/6128 CRTC type, '0'-'3' (see machines/cpc/options.ts). */
export const [cpcCrtcType, setCpcCrtcType] = setting('cpc-crtc-type', savedText('cpc-crtc-type'));
/** CPC RAM expansion: 'none', '256k' or '512k'. */
export const [cpcRamExpansion, setCpcRamExpansion] = setting('cpc-ram-expansion', savedText('cpc-ram-expansion'));
/** DDI-1 disk interface on the CPC 464. */
export const [cpcDdi1, setCpcDdi1] = setting('cpc-ddi1', savedFlag('cpc-ddi1'));
/** CPC distributor name links (LK1-LK3), e.g. 'amstrad', 'schneider'. */
export const [cpcManufacturer, setCpcManufacturer] = setting('cpc-manufacturer', savedText('cpc-manufacturer'));
/** CPC 50/60 Hz link (LK4): '50' or '60'. */
export const [cpcRefresh, setCpcRefresh] = setting('cpc-refresh', savedText('cpc-refresh'));

/** Megabytes fitted to the external megabyte interface, 0-4. 0 = not fitted. */

export const [einsteinXtalDos, setEinsteinXtalDos] = setting('einstein-xtaldos', savedFlag('einstein-xtaldos'));
export const [mtxCpm, setMtxCpm] = setting('mtx-cpm', savedFlag('mtx-cpm'));
export const [mtx80Column, setMtx80Column] = setting('mtx-80-column', savedFlag('mtx-80-column'));
export const [apple2Disk2, setApple2Disk2] = setting('apple2-disk2', savedFlag('apple2-disk2'));
export const [c64Drive, setC64Drive] = setting('c64-drive', savedFlag('c64-drive'));
/** Which SID the 64 has: '6581' (the original) or '8580' (the C64C's). */
export const [c64Sid, setC64Sid] = setting('c64-sid', savedText('c64-sid'));

// ── Built-in drive count ────────────────────────────────────────────────
// How many of a machine's built-in floppy drives are fitted, kept per machine
// kind (a count chosen on the Lynx says nothing about the BBC) as one JSON
// object. A kind with no entry has every drive its model can take.

function parseDriveCounts(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [kind, n] of Object.entries(parsed)) {
        if (Number.isInteger(n) && n >= 1) out[kind] = n as number;
      }
    }
  } catch { /* corrupted entry: start again with every drive fitted */ }
  return out;
}

function initialDriveCounts(): Record<string, number> {
  const counts = parseDriveCounts(savedText('drive-counts'));
  // The Apple II used to keep its count as a Hardware-pane option of its own.
  if (counts.apple2 === undefined && getSaved('apple2-drives', '') === '1') counts.apple2 = 1;
  return counts;
}

/**
 * The model of each drive, per machine kind, for machines whose drives are set
 * up one at a time (the Atari's SIO drives). The list's length is the number
 * of drives fitted. Held as JSON like the counts.
 */
function parseDriveModels(raw: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const [kind, models] of Object.entries(parsed)) {
        if (Array.isArray(models) && models.length > 0 && models.every(m => typeof m === 'string')) {
          out[kind] = models as string[];
        }
      }
    }
  } catch { /* corrupted entry: back to the machine's default drives */ }
  return out;
}

function initialDriveModels(): Record<string, string[]> {
  const models = parseDriveModels(savedText('drive-models'));
  // The Atari used to have one model for every drive, set in the Hardware pane.
  const legacy = getSaved('atari-disk-drive', '');
  if (models.atari === undefined && legacy !== '') models.atari = [legacy, legacy];
  return models;
}

const _driveModels = signal(initialDriveModels());
const setDriveModelsJson = (json: string): void => { _driveModels[1](parseDriveModels(json)); };
// Registered like every other setting's signal, so Reset and the view resolve
// these two JSON tables through the same key as the rest of the catalogue.
SIGNALS.set('drive-models', {
  get: () => _driveModels[0](),
  set: (value) => setDriveModelsJson(String(value)),
});

/** The drive models saved for a machine kind, or undefined when never set up. */
export function savedDriveModels(kind: string): readonly string[] | undefined {
  return _driveModels[0]()[kind];
}

/** The drive models for a machine kind: what the user set up, else `fallback`. */
export function driveModelsFor(kind: string, fallback: readonly string[]): readonly string[] {
  return savedDriveModels(kind) ?? fallback;
}

/** Choose and persist the drives a machine kind has, one model each. */
export function setDriveModelsFor(kind: string, models: readonly string[]): void {
  const next = { ..._driveModels[0](), [kind]: [...models] };
  _driveModels[1](next);
  persistSetting('drive-models', JSON.stringify(next));
}

const _driveCounts = signal(initialDriveCounts());
const setDriveCountsJson = (json: string): void => { _driveCounts[1](parseDriveCounts(json)); };
SIGNALS.set('drive-counts', {
  get: () => _driveCounts[0](),
  set: (value) => setDriveCountsJson(String(value)),
});

/** The count saved for a machine kind, or undefined when the user never chose one. */
export function savedDriveCount(kind: string): number | undefined {
  return _driveCounts[0]()[kind];
}

/** Drives fitted for a machine kind whose model takes at most `max`. */
export function driveCountFor(kind: string, max: number): number {
  return Math.min(max, Math.max(1, savedDriveCount(kind) ?? max));
}

/** Choose and persist how many built-in drives a machine kind has. */
export function setDriveCountFor(kind: string, count: number): void {
  const next = { ..._driveCounts[0](), [kind]: count };
  _driveCounts[1](next);
  persistSetting('drive-counts', JSON.stringify(next));
}

export const [apple2LangCard, setApple2LangCard] = setting('apple2-langcard', savedFlag('apple2-langcard'));
export const [apple2Joystick, setApple2Joystick] = setting('apple2-joystick', savedFlag('apple2-joystick'));
export const [apple2Mockingboard, setApple2Mockingboard] = setting('apple2-mockingboard', savedFlag('apple2-mockingboard'));
export const [apple2EightyCol, setApple2EightyCol] = setting('apple2-80col', savedFlag('apple2-80col'));
export const [apple2eEightyCol, setApple2eEightyCol] = setting('apple2e-80col', savedFlag('apple2e-80col'));

export const [apple1Ram, setApple1Ram] = setting('apple1-ram', 
  savedText('apple1-ram') as '4k' | '8k' | '16k' | '32k' | '48k');

export const [vic20Ram, setVic20Ram] = setting('vic20-ram', 
  savedText('vic20-ram') as 'none' | '3k' | '8k' | '16k' | '24k' | '27k');
export const [vic20Blk5, setVic20Blk5] = setting('vic20-blk5', savedFlag('vic20-blk5'));
export const [vic20Drive, setVic20Drive] = setting('vic20-drive', savedFlag('vic20-drive'));

export const [c128Drive, setC128Drive] = setting('c128-drive', savedFlag('c128-drive'));
/** VDC RAM: '16k' (the 128) or '64k' (the 128D and later boards). */
export const [c128VdcRam, setC128VdcRam] = setting('c128-vdc-ram', savedText('c128-vdc-ram') as '16k' | '64k');
/** The VDC chip: 'r7a' (8563 R7A), 'r8' (8563 R8/R9, the flat 128 and the 128D) or '8568' (the 128DCR). */
export const [c128VdcChip, setC128VdcChip] = setting('c128-vdc-chip', savedText('c128-vdc-chip') as 'r7a' | 'r8' | '8568');
/** Which video chip the one canvas shows: 'auto' (the 40/80 key), '40' or '80'. */
export const [c128Display, setC128Display] = setting('c128-display', savedText('c128-display') as 'auto' | '40' | '80');
export const [plus4Drive, setPlus4Drive] = setting('plus4-drive', savedFlag('plus4-drive'));
/** The 256K RAM board fitted: 'none', 'hannes' or 'csory'. */
export const [plus4Expansion, setPlus4Expansion] =
  setting('plus4-expansion', savedText('plus4-expansion') as 'none' | 'hannes' | 'csory');
export const [apple1BasicRam, setApple1BasicRam] = setting('apple1-basic-ram', savedFlag('apple1-basic-ram'));
export const [apple1Aci, setApple1Aci] = setting('apple1-aci', savedFlag('apple1-aci'));

/** Acorn Atom fitted RAM: 2 KB standard or 12 KB fully expanded. */
export const [atomRam, setAtomRam] = setting('atom-ram', savedText('atom-ram') as '2k' | '12k');
/** Oric Microdisc (WD1793 + boot EPROM) fitted. */
export const [oricMicrodisc, setOricMicrodisc] = setting('oric-microdisc', savedFlag('oric-microdisc'));
export const [mtx512kRam, setMtx512kRam] = setting('mtx-512k-ram', savedFlag('mtx-512k-ram'));
export const [mtxFloppy, setMtxFloppy] = setting('mtx-floppy', savedFlag('mtx-floppy'));
export const [msxFloppy, setMsxFloppy] = setting('msx-floppy', savedFlag('msx-floppy'));
export const [bbcColorMap, setBbcColorMap] = setting('bbc-color-map', savedText('bbc-color-map') as 'pal' | 'measured');

export const [apple2Video, setApple2Video] = setting('apple2-video', 
  savedText('apple2-video') as 'mono' | 'ntsc' | 'pal');

export const [bbcDiskSystem, setBbcDiskSystem] = setting('bbc-disk-system', 
  savedText('bbc-disk-system') as 'none' | 'acorn' | '1770');
/** Sideways-RAM sockets fitted, as a decimal bit mask (bit n = socket n). */
export const [bbcSwr, setBbcSwr] = setting('bbc-swr', savedText('bbc-swr'));

export const [electronPlus1, setElectronPlus1] = setting('electron-plus1', savedFlag('electron-plus1'));
export const [electronPlus3, setElectronPlus3] = setting('electron-plus3', savedFlag('electron-plus3'));
export const [electronDfs, setElectronDfs] = setting('electron-dfs', savedFlag('electron-dfs'));
export const [lynxFdc, setLynxFdc] = setting('lynx-fdc', savedFlag('lynx-fdc'));
/** Amstrad PCW 50/60Hz link: on = a 60Hz machine (260-line frame, 200 lines shown). */
export const [pcw60Hz, setPcw60Hz] = setting('pcw-60hz', savedFlag('pcw-60hz'));
/** PCW monitor phosphor: 'auto' = whatever monitor the model shipped with. */
export const [pcwPhosphor, setPcwPhosphor] =
  setting('pcw-phosphor', savedText('pcw-phosphor') as 'auto' | 'green' | 'white');

/** Enterprise EXDOS disk card (WD1770 + EXDOS ROM) fitted. */
export const [enterpriseExdos, setEnterpriseExdos] = setting('enterprise-exdos', savedFlag('enterprise-exdos'));
export const [zx8x16kRam, setZx8x16kRam] = setting('zx8x-16k-ram', savedFlag('zx8x-16k-ram'));
export const [zx81UdgRam, setZx81UdgRam] = setting('zx81-udg-ram', savedFlag('zx81-udg-ram'));
export const [zx81Udg128Ram, setZx81Udg128Ram] = setting('zx81-udg128-ram', savedFlag('zx81-udg128-ram'));
export const [zx81WrxHires, setZx81WrxHires] = setting('zx81-wrx-hires', savedFlag('zx81-wrx-hires'));
export const [zx81MemotechHrg, setZx81MemotechHrg] = setting('zx81-memotech-hrg', savedFlag('zx81-memotech-hrg'));
export const [zx81QuickSilvaHrg, setZx81QuickSilvaHrg] = setting('zx81-quicksilva-hrg', savedFlag('zx81-quicksilva-hrg'));
/** ZX81 ZX Printer on port 0xFB. */
export const [zx81ZxPrinter, setZx81ZxPrinter] = setting('zx81-zx-printer', savedFlag('zx81-zx-printer'));
/** ZX81 Chroma 81 colour interface. */
export const [zx81Chroma81, setZx81Chroma81] = setting('zx81-chroma81', savedFlag('zx81-chroma81'));
/** ZX80/ZX81 ZON X-81 AY sound interface. */
export const [zx8xZonx, setZx8xZonx] = setting('zx8x-zonx', savedFlag('zx8x-zonx'));
/** ZX80/ZX81 vertical sync (the MIC line) mixed into the sound. */
export const [zx8xVsyncSound, setZx8xVsyncSound] = setting('zx8x-vsync-sound', savedFlag('zx8x-vsync-sound'));

/** Jupiter Ace RAM pack: 'none' (stock 3K), '16k' (16K pack, 19K total) or
 *  '48k' (48K pack, 51K total). The 48K pack is the default. */
export const [aceRamPack, setAceRamPack] = setting('ace-ram-pack', savedText('ace-ram-pack') as 'none' | '16k' | '48k');
export const [vtx5000Enabled, setVtx5000Enabled] = setting('vtx5000', savedFlag('vtx5000'));
export const [specdrumEnabled, setSpecdrumEnabled] = setting('specdrum', savedFlag('specdrum'));
/** 16K/48K board issue: on = Issue 1/2 (port 0xFE bit 6 follows OUT bits 3 and 4),
 *  off = Issue 3 (bit 4 alone). */
export const [spectrumIssue2, setSpectrumIssue2] = setting('spectrum-issue2', savedFlag('spectrum-issue2'));
export const [plusDEnabled, setPlusDEnabled] = setting('plusd', savedFlag('plusd'));
export const [betaDiskEnabled, setBetaDiskEnabled] = setting('betadisk', savedFlag('betadisk'));
export const [interface1Enabled, setInterface1Enabled] = setting('interface1', savedFlag('interface1'));
export const [uspeechEnabled, setUspeechEnabled] = setting('uspeech', savedFlag('uspeech'));

// ── Behaviour settings ──────────────────────────────────────────────────

export const [pauseOnFocusLost, setPauseOnFocusLost] = setting('pause-on-blur', savedFlag('pause-on-blur'));

// ── Derived ─────────────────────────────────────────────────────────────

export const needsGamepadPolling = /*@once*/ createRoot(() => createMemo(() =>
  joyMapP1() === 'gamepad' || joyMapP2() === 'gamepad'
));

// ── Persistence helpers ─────────────────────────────────────────────────

export function persistSetting(key: string, value: string | number): void {
  setSaved(key, String(value));
}

/**
 * Set and persist a boolean setting by its key, for a change that starts in a
 * machine rather than a pane (a snapshot that records a board option). Returns
 * false, changing nothing, for a key that is not a known boolean setting.
 */
export function setFlagSetting(key: string, on: boolean): boolean {
  const def = defOf(key);
  if (!def || def.kind !== 'bool') return false;
  SIGNALS.get(key)?.set(on);
  persistSetting(key, on ? 'on' : 'off');
  return true;
}

/**
 * Set and persist a string setting by its key, for a change that starts in a
 * machine rather than a pane (a program that needs other expansion RAM).
 * Returns false, changing nothing, for a key that is not a known string setting.
 */
export function setTextSetting(key: string, value: string): boolean {
  const def = defOf(key);
  if (!def || def.kind !== 'string') return false;
  SIGNALS.get(key)?.set(value);
  persistSetting(key, value);
  return true;
}

/** Reset every setting in a named pane group back to its default. */
export function resetSettingsGroup(pane: string): void {
  for (const [key, def] of Object.entries(SETTINGS) as [SettingKey, SettingDef][]) {
    if (def.pane !== pane) continue;
    setSaved(key, def.def);
    SIGNALS.get(key)?.set(coerce(def, def.def));
  }
}

// ── The catalogue, seen by the shell's SettingsView ───────────────────────

/** The catalogue entry for a key, or undefined if it is not a setting. */
export function defOf(key: string): SettingDef | undefined {
  return (SETTINGS as Record<string, SettingDef>)[key];
}

/** Whether a key is a setting with a readable signal. */
export function hasSignal(key: string): boolean {
  return SIGNALS.has(key);
}

/** A setting's current value, read reactively (call inside a tracking scope). */
export function settingValue(key: string): unknown {
  return SIGNALS.get(key)?.get();
}

/** A stored string as the value its `kind` describes. */
function coerce(def: SettingDef, raw: string): unknown {
  if (def.kind === 'number') return Number(raw);
  if (def.kind === 'bool') return raw === 'on';
  return raw;
}
