/**
 * Persisted display/sound/joystick settings as signals.
 */

import { createSignal, createMemo, createRoot } from 'solid-js';
import { getSaved, setSaved } from '@/store/persistence.ts';

// ── Defaults — single source of truth ──────────────────────────────────
//
// Each persisted setting's default lives here exactly once. Both the
// createSignal initialisers (via getSaved/getSavedNumber fallbacks) and the
// PANE_SETTINGS table used by resetSettingsGroup reference these constants,
// so "fresh boot" and "press Reset" always produce the same values.
//
// All values are stored as strings — getSavedNumber coerces numerics, and
// the on/off bool values are compared as strings.

const DEFAULTS = {
  // Display
  'scale':             '2',
  'brightness':        '0',
  'contrast':          '50',
  'smoothing':         '0',
  'curvature':         '0',
  'scanlines':         '0',
  'mask-type':         '0',
  'dot-pitch':         '10',
  'curvature-mode':    '0',
  'noise':             '0',
  'scaling-mode':      '0',
  'monitor':           'raw',
  'border-size':       '1',
  'renderer':          'webgl',
  'color-map':         'measured',
  'cpc-color-map':     'gate-array',
  'scanline-accuracy': 'high',

  // Sound
  'volume':       '70',
  'ay-mix':       '50',
  'ay-stereo':    'ABC',
  'ay-dc-block':  'on',

  // Joystick
  'joy-p1':     'kempston',
  'joy-p2':     'sinclair2',
  'joy-map-p1': 'none',
  'joy-map-p2': 'none',

  // Font / text overlay (these are the tuned values; the previous PANE_SETTINGS
  // defaults were stale placeholders from when the overlay was first scaffolded)
  'font':            '',
  'ocr-font':        'JetBrains Mono',
  'ocr-line-height': '100',
  'ocr-tracking':    '0',
  'ocr-offset-x':    '3',
  'ocr-offset-y':    '3',
  'ocr-scale-x':     '100',
  'ocr-scale-y':     '100',

  // Drive
  'disk-sound-a':        'on',
  'disk-sound-b':        'on',
  'write-protect-a':     'off',
  'write-protect-b':     'off',
  'drive-b-force-ready': 'off',
  // +D drives C/D
  'disk-sound-c':        'on',
  'disk-sound-d':        'on',
  'write-protect-c':     'off',
  'write-protect-d':     'off',

  // Tape
  'tape-auto-rewind':     'on',
  'tape-collapse-blocks': 'on',
  'tape-instant-rom':    'on',
  'tape-edge-loading':   'off',
  'tape-turbo-load':     'on',
  'tape-sound':          'on',

  // Hardware
  'multiface':      'off',
  'plus3-v41-roms': 'off',
  'vtx5000':        'off',
  'cpc-parados':    'off',
  'plusd':          'off',
} as const;

type SettingKey = keyof typeof DEFAULTS;
const D = (k: SettingKey): string => DEFAULTS[k];

// ── Display settings ────────────────────────────────────────────────────

function getSavedNumber(key: string, fallback: string): number {
  const n = Number(getSaved(key, fallback));
  // A corrupted localStorage entry (older build, manual edit, future bug)
  // would otherwise leak NaN into renderers, audio mixing, etc. Treat any
  // non-finite parse as if the key were absent.
  return Number.isFinite(n) ? n : Number(fallback);
}

const _scale = /*@once*/ createRoot(() => createSignal(getSavedNumber('scale', D('scale'))));
export const scale = _scale[0];
export const setScale = _scale[1];

const _brightness = /*@once*/ createRoot(() => createSignal(getSavedNumber('brightness', D('brightness'))));
export const brightness = _brightness[0];
export const setBrightness = _brightness[1];

const _contrast = /*@once*/ createRoot(() => createSignal(getSavedNumber('contrast', D('contrast'))));
export const contrast = _contrast[0];
export const setContrast = _contrast[1];

const _smoothing = /*@once*/ createRoot(() => createSignal(getSavedNumber('smoothing', D('smoothing'))));
export const smoothing = _smoothing[0];
export const setSmoothing = _smoothing[1];

const _curvature = /*@once*/ createRoot(() => createSignal(getSavedNumber('curvature', D('curvature'))));
export const curvature = _curvature[0];
export const setCurvature = _curvature[1];

const _scanlines = /*@once*/ createRoot(() => createSignal(getSavedNumber('scanlines', D('scanlines'))));
export const scanlines = _scanlines[0];
export const setScanlines = _scanlines[1];

const _maskType = /*@once*/ createRoot(() => createSignal(getSavedNumber('mask-type', D('mask-type'))));
export const maskType = _maskType[0];
export const setMaskType = _maskType[1];

const _dotPitch = /*@once*/ createRoot(() => createSignal(getSavedNumber('dot-pitch', D('dot-pitch'))));
export const dotPitch = _dotPitch[0];
export const setDotPitch = _dotPitch[1];

const _curvatureMode = /*@once*/ createRoot(() => createSignal(getSavedNumber('curvature-mode', D('curvature-mode'))));
export const curvatureMode = _curvatureMode[0];
export const setCurvatureMode = _curvatureMode[1];

const _noise = /*@once*/ createRoot(() => createSignal(getSavedNumber('noise', D('noise'))));
export const noise = _noise[0];
export const setNoise = _noise[1];

const _scalingMode = /*@once*/ createRoot(() => createSignal(getSavedNumber('scaling-mode', D('scaling-mode'))));
export const scalingMode = _scalingMode[0];
export const setScalingMode = _scalingMode[1];

const _monitor = /*@once*/ createRoot(() => createSignal(getSaved('monitor', D('monitor'))));
export const monitor = _monitor[0];
export const setMonitor = _monitor[1];

const _borderSize = /*@once*/ createRoot(() => createSignal(getSavedNumber('border-size', D('border-size'))));
export const borderSize = _borderSize[0];
export const setBorderSize = _borderSize[1];

const _renderer = /*@once*/ createRoot(() => createSignal(getSaved('renderer', D('renderer')) as 'webgl' | 'canvas'));
export const renderer = _renderer[0];
export const setRenderer = _renderer[1];

// Runtime-only: cleared when WebGL context creation fails so the UI can
// hide the option and emulator.ts can avoid retrying.
const _webglAvailable = /*@once*/ createRoot(() => createSignal(true));
export const webglAvailable = _webglAvailable[0];
export const setWebglAvailable = _webglAvailable[1];

const _colorMap = /*@once*/ createRoot(() => createSignal(getSaved('color-map', D('color-map')) as 'basic' | 'measured' | 'vivid'));
export const colorMap = _colorMap[0];
export const setColorMap = _colorMap[1];

const _cpcColorMap = /*@once*/ createRoot(() => createSignal(getSaved('cpc-color-map', D('cpc-color-map')) as 'basic' | 'gate-array' | 'asic'));
export const cpcColorMap = _cpcColorMap[0];
export const setCpcColorMap = _cpcColorMap[1];

const _scanlineAccuracy = /*@once*/ createRoot(() => createSignal(getSaved('scanline-accuracy', D('scanline-accuracy')) as 'high' | 'mid' | 'low'));
export const scanlineAccuracy = _scanlineAccuracy[0];
export const setScanlineAccuracy = _scanlineAccuracy[1];

// ── Sound settings ──────────────────────────────────────────────────────

const _volume = /*@once*/ createRoot(() => createSignal(getSavedNumber('volume', D('volume'))));
export const volume = _volume[0];
export const setVolume = _volume[1];

const _ayMix = /*@once*/ createRoot(() => createSignal(getSavedNumber('ay-mix', D('ay-mix'))));
export const ayMix = _ayMix[0];
export const setAyMix = _ayMix[1];

const _ayStereo = /*@once*/ createRoot(() => createSignal(getSaved('ay-stereo', D('ay-stereo'))));
export const ayStereo = _ayStereo[0];
export const setAyStereo = _ayStereo[1];

const _ayDcBlock = /*@once*/ createRoot(() => createSignal(getSaved('ay-dc-block', D('ay-dc-block')) === 'on'));
export const ayDcBlock = _ayDcBlock[0];
export const setAyDcBlock = _ayDcBlock[1];

// ── Joystick settings ───────────────────────────────────────────────────

const _joyP1 = /*@once*/ createRoot(() => createSignal(getSaved('joy-p1', D('joy-p1'))));
export const joyP1 = _joyP1[0];
export const setJoyP1 = _joyP1[1];

const _joyP2 = /*@once*/ createRoot(() => createSignal(getSaved('joy-p2', D('joy-p2'))));
export const joyP2 = _joyP2[0];
export const setJoyP2 = _joyP2[1];

const _joyMapP1 = /*@once*/ createRoot(() => createSignal(getSaved('joy-map-p1', D('joy-map-p1'))));
export const joyMapP1 = _joyMapP1[0];
export const setJoyMapP1 = _joyMapP1[1];

const _joyMapP2 = /*@once*/ createRoot(() => createSignal(getSaved('joy-map-p2', D('joy-map-p2'))));
export const joyMapP2 = _joyMapP2[0];
export const setJoyMapP2 = _joyMapP2[1];

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

const _gamepadConfigP1 = /*@once*/ createRoot(() => createSignal<GamepadConfig | null>(loadGamepadConfig(1)));
export const gamepadConfigP1 = _gamepadConfigP1[0];
export const setGamepadConfigP1 = _gamepadConfigP1[1];

const _gamepadConfigP2 = /*@once*/ createRoot(() => createSignal<GamepadConfig | null>(loadGamepadConfig(2)));
export const gamepadConfigP2 = _gamepadConfigP2[0];
export const setGamepadConfigP2 = _gamepadConfigP2[1];

export function saveGamepadConfig(player: 1 | 2, config: GamepadConfig): void {
  if (player === 1) {
    setGamepadConfigP1(config);
  } else {
    setGamepadConfigP2(config);
  }
  setSaved(`gamepad-config-p${player}`, JSON.stringify(config));
}

// ── Font settings ───────────────────────────────────────────────────────

const _fontName = /*@once*/ createRoot(() => createSignal(getSaved('font', D('font'))));
export const fontName = _fontName[0];
export const setFontName = _fontName[1];

// ── Text/OCR overlay settings ──────────────────────────────────────────

const _ocrFont = /*@once*/ createRoot(() => createSignal(getSaved('ocr-font', D('ocr-font'))));
export const ocrFont = _ocrFont[0];
export const setOcrFont = _ocrFont[1];

const _ocrLineHeight = /*@once*/ createRoot(() => createSignal(getSavedNumber('ocr-line-height', D('ocr-line-height'))));
export const ocrLineHeight = _ocrLineHeight[0];
export const setOcrLineHeight = _ocrLineHeight[1];

const _ocrTracking = /*@once*/ createRoot(() => createSignal(getSavedNumber('ocr-tracking', D('ocr-tracking'))));
export const ocrTracking = _ocrTracking[0];
export const setOcrTracking = _ocrTracking[1];

const _ocrOffsetX = /*@once*/ createRoot(() => createSignal(getSavedNumber('ocr-offset-x', D('ocr-offset-x'))));
export const ocrOffsetX = _ocrOffsetX[0];
export const setOcrOffsetX = _ocrOffsetX[1];

const _ocrOffsetY = /*@once*/ createRoot(() => createSignal(getSavedNumber('ocr-offset-y', D('ocr-offset-y'))));
export const ocrOffsetY = _ocrOffsetY[0];
export const setOcrOffsetY = _ocrOffsetY[1];

const _ocrScaleX = /*@once*/ createRoot(() => createSignal(getSavedNumber('ocr-scale-x', D('ocr-scale-x'))));
export const ocrScaleX = _ocrScaleX[0];
export const setOcrScaleX = _ocrScaleX[1];

const _ocrScaleY = /*@once*/ createRoot(() => createSignal(getSavedNumber('ocr-scale-y', D('ocr-scale-y'))));
export const ocrScaleY = _ocrScaleY[0];
export const setOcrScaleY = _ocrScaleY[1];

// ── Disk mode ───────────────────────────────────────────────────────────

const _diskSoundA = /*@once*/ createRoot(() => createSignal(getSaved('disk-sound-a', D('disk-sound-a')) === 'on'));
export const diskSoundA = _diskSoundA[0];
export const setDiskSoundA = _diskSoundA[1];

const _diskSoundB = /*@once*/ createRoot(() => createSignal(getSaved('disk-sound-b', D('disk-sound-b')) === 'on'));
export const diskSoundB = _diskSoundB[0];
export const setDiskSoundB = _diskSoundB[1];

const _writeProtectA = /*@once*/ createRoot(() => createSignal(getSaved('write-protect-a', D('write-protect-a')) === 'on'));
export const writeProtectA = _writeProtectA[0];
export const setWriteProtectA = _writeProtectA[1];

const _writeProtectB = /*@once*/ createRoot(() => createSignal(getSaved('write-protect-b', D('write-protect-b')) === 'on'));
export const writeProtectB = _writeProtectB[0];
export const setWriteProtectB = _writeProtectB[1];

const _driveBForceReady = /*@once*/ createRoot(() => createSignal(getSaved('drive-b-force-ready', D('drive-b-force-ready')) === 'on'));
export const driveBForceReady = _driveBForceReady[0];
export const setDriveBForceReady = _driveBForceReady[1];

const _diskSoundC = /*@once*/ createRoot(() => createSignal(getSaved('disk-sound-c', D('disk-sound-c')) === 'on'));
export const diskSoundC = _diskSoundC[0];
export const setDiskSoundC = _diskSoundC[1];

const _diskSoundD = /*@once*/ createRoot(() => createSignal(getSaved('disk-sound-d', D('disk-sound-d')) === 'on'));
export const diskSoundD = _diskSoundD[0];
export const setDiskSoundD = _diskSoundD[1];

const _writeProtectC = /*@once*/ createRoot(() => createSignal(getSaved('write-protect-c', D('write-protect-c')) === 'on'));
export const writeProtectC = _writeProtectC[0];
export const setWriteProtectC = _writeProtectC[1];

const _writeProtectD = /*@once*/ createRoot(() => createSignal(getSaved('write-protect-d', D('write-protect-d')) === 'on'));
export const writeProtectD = _writeProtectD[0];
export const setWriteProtectD = _writeProtectD[1];

// ── Tape settings ───────────────────────────────────────────────────────

const _tapeAutoRewind = /*@once*/ createRoot(() => createSignal(getSaved('tape-auto-rewind', D('tape-auto-rewind')) === 'on'));
export const tapeAutoRewind = _tapeAutoRewind[0];
export const setTapeAutoRewind = _tapeAutoRewind[1];

const _tapeCollapseBlocks = /*@once*/ createRoot(() => createSignal(getSaved('tape-collapse-blocks', D('tape-collapse-blocks')) === 'on'));
export const tapeCollapseBlocks = _tapeCollapseBlocks[0];
export const setTapeCollapseBlocks = _tapeCollapseBlocks[1];

// Persisted key strings are kept stable ('tape-instant-rom', 'tape-edge-loading',
// 'tape-turbo-load') so existing saved prefs survive; only the signal names follow
// the UI wording: Fast ROM loading / Fast edge loading / Turbo while loading.
const _tapeFastRom = /*@once*/ createRoot(() => createSignal(getSaved('tape-instant-rom', D('tape-instant-rom')) === 'on'));
export const tapeFastRom = _tapeFastRom[0];
export const setTapeFastRom = _tapeFastRom[1];

const _tapeFastEdge = /*@once*/ createRoot(() => createSignal(getSaved('tape-edge-loading', D('tape-edge-loading')) === 'on'));
export const tapeFastEdge = _tapeFastEdge[0];
export const setTapeFastEdge = _tapeFastEdge[1];

const _tapeTurbo = /*@once*/ createRoot(() => createSignal(getSaved('tape-turbo-load', D('tape-turbo-load')) === 'on'));
export const tapeTurbo = _tapeTurbo[0];
export const setTapeTurbo = _tapeTurbo[1];

const _tapeSoundEnabled = /*@once*/ createRoot(() => createSignal(getSaved('tape-sound', D('tape-sound')) === 'on'));
export const tapeSoundEnabled = _tapeSoundEnabled[0];
export const setTapeSoundEnabled = _tapeSoundEnabled[1];

// ── Multiface ────────────────────────────────────────────────────────

const _multifaceEnabled = /*@once*/ createRoot(() => createSignal(getSaved('multiface', D('multiface')) === 'on'));
export const multifaceEnabled = _multifaceEnabled[0];
export const setMultifaceEnabled = _multifaceEnabled[1];

const _plus3V41Roms = /*@once*/ createRoot(() => createSignal(getSaved('plus3-v41-roms', D('plus3-v41-roms')) === 'on'));
export const plus3V41Roms = _plus3V41Roms[0];
export const setPlus3V41Roms = _plus3V41Roms[1];

const _cpcParados = /*@once*/ createRoot(() => createSignal(getSaved('cpc-parados', D('cpc-parados')) === 'on'));
export const cpcParados = _cpcParados[0];
export const setCpcParados = _cpcParados[1];

const _vtx5000Enabled = /*@once*/ createRoot(() => createSignal(getSaved('vtx5000', D('vtx5000')) === 'on'));
export const vtx5000Enabled = _vtx5000Enabled[0];
export const setVtx5000Enabled = _vtx5000Enabled[1];

const _plusDEnabled = /*@once*/ createRoot(() => createSignal(getSaved('plusd', D('plusd')) === 'on'));
export const plusDEnabled = _plusDEnabled[0];
export const setPlusDEnabled = _plusDEnabled[1];

// ── Derived ─────────────────────────────────────────────────────────────

export const needsGamepadPolling = /*@once*/ createRoot(() => createMemo(() =>
  joyMapP1() === 'gamepad' || joyMapP2() === 'gamepad'
));

// ── Persistence helpers ─────────────────────────────────────────────────

export function persistSetting(key: string, value: string | number): void {
  setSaved(key, String(value));
}

// ── Per-pane defaults and reset ─────────────────────────────────────────

type SettingDef =
  | { key: SettingKey; set: (v: number) => void; type: 'number' }
  | { key: SettingKey; set: (v: string) => void; type: 'string' }
  | { key: SettingKey; set: (v: boolean) => void; type: 'bool' };

// The `default` for each setting comes from DEFAULTS above — never inline a
// literal here. If a setting needs a different default, change it in DEFAULTS
// so signal init and reset stay in sync.
const PANE_SETTINGS: Record<string, SettingDef[]> = {
  display: [
    { key: 'scale',             set: setScale,            type: 'number' },
    { key: 'brightness',        set: setBrightness,       type: 'number' },
    { key: 'contrast',          set: setContrast,         type: 'number' },
    { key: 'smoothing',         set: setSmoothing,        type: 'number' },
    { key: 'curvature',         set: setCurvature,        type: 'number' },
    { key: 'scanlines',         set: setScanlines,        type: 'number' },
    { key: 'mask-type',         set: setMaskType,         type: 'number' },
    { key: 'dot-pitch',         set: setDotPitch,         type: 'number' },
    { key: 'curvature-mode',    set: setCurvatureMode,    type: 'number' },
    { key: 'noise',             set: setNoise,            type: 'number' },
    { key: 'scaling-mode',      set: setScalingMode,      type: 'number' },
    { key: 'monitor',           set: setMonitor,          type: 'string' },
    { key: 'border-size',       set: setBorderSize,       type: 'number' },
    { key: 'color-map',         set: setColorMap,         type: 'string' },
    { key: 'cpc-color-map',     set: setCpcColorMap,      type: 'string' },
    { key: 'scanline-accuracy', set: setScanlineAccuracy, type: 'string' },
  ],
  sound: [
    { key: 'volume',      set: setVolume,     type: 'number' },
    { key: 'ay-mix',      set: setAyMix,      type: 'number' },
    { key: 'ay-stereo',   set: setAyStereo,   type: 'string' },
    { key: 'ay-dc-block', set: setAyDcBlock,  type: 'bool' },
  ],
  joystick: [
    { key: 'joy-p1',     set: setJoyP1,    type: 'string' },
    { key: 'joy-p2',     set: setJoyP2,    type: 'string' },
    { key: 'joy-map-p1', set: setJoyMapP1, type: 'string' },
    { key: 'joy-map-p2', set: setJoyMapP2, type: 'string' },
  ],
  text: [
    { key: 'ocr-font',        set: setOcrFont,       type: 'string' },
    { key: 'ocr-line-height', set: setOcrLineHeight, type: 'number' },
    { key: 'ocr-tracking',    set: setOcrTracking,   type: 'number' },
    { key: 'ocr-offset-x',    set: setOcrOffsetX,    type: 'number' },
    { key: 'ocr-offset-y',    set: setOcrOffsetY,    type: 'number' },
    { key: 'ocr-scale-x',     set: setOcrScaleX,     type: 'number' },
    { key: 'ocr-scale-y',     set: setOcrScaleY,     type: 'number' },
  ],
  drive: [
    { key: 'disk-sound-a',        set: setDiskSoundA,       type: 'bool' },
    { key: 'disk-sound-b',        set: setDiskSoundB,       type: 'bool' },
    { key: 'write-protect-a',     set: setWriteProtectA,    type: 'bool' },
    { key: 'write-protect-b',     set: setWriteProtectB,    type: 'bool' },
    { key: 'drive-b-force-ready', set: setDriveBForceReady, type: 'bool' },
    { key: 'disk-sound-c',        set: setDiskSoundC,       type: 'bool' },
    { key: 'disk-sound-d',        set: setDiskSoundD,       type: 'bool' },
    { key: 'write-protect-c',     set: setWriteProtectC,    type: 'bool' },
    { key: 'write-protect-d',     set: setWriteProtectD,    type: 'bool' },
  ],
  tape: [
    { key: 'tape-auto-rewind',     set: setTapeAutoRewind,     type: 'bool' },
    { key: 'tape-collapse-blocks', set: setTapeCollapseBlocks, type: 'bool' },
    { key: 'tape-instant-rom',     set: setTapeFastRom,        type: 'bool' },
    { key: 'tape-edge-loading',    set: setTapeFastEdge,       type: 'bool' },
    { key: 'tape-turbo-load',      set: setTapeTurbo,          type: 'bool' },
    { key: 'tape-sound',           set: setTapeSoundEnabled,   type: 'bool' },
  ],
  hardware: [
    { key: 'multiface',      set: setMultifaceEnabled, type: 'bool' },
    { key: 'plus3-v41-roms', set: setPlus3V41Roms,     type: 'bool' },
    { key: 'vtx5000',        set: setVtx5000Enabled,   type: 'bool' },
    { key: 'cpc-parados',    set: setCpcParados,        type: 'bool' },
    { key: 'plusd',          set: setPlusDEnabled,     type: 'bool' },
  ],
  font: [
    { key: 'font', set: setFontName, type: 'string' },
  ],
};

/** Reset all settings for a named group back to defaults. */
export function resetSettingsGroup(group: string): void {
  const defs = PANE_SETTINGS[group];
  if (!defs) return;
  for (const d of defs) {
    const def = D(d.key);
    setSaved(d.key, def);
    if (d.type === 'number') d.set(Number(def));
    else if (d.type === 'bool') d.set(def === 'on');
    else d.set(def);
  }
}
