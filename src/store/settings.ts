/**
 * Persisted display/sound/joystick settings as signals.
 */

import { createSignal, createMemo, createRoot } from 'solid-js';
import { getSaved, setSaved } from '@/store/persistence.ts';
import { parsePhosphor } from '@/display/phosphor.ts';

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
  'saturation':        '50',
  'gamma':             '0',
  'smoothing':         '0',
  'curvature':         '0',
  'scanlines':         '0',
  'mask-type':         '0',
  'dot-pitch':         '10',
  'curvature-mode':    '0',
  'noise':             '0',
  'scaling-mode':      '0',
  'monitor':           'raw',
  'phosphor':          'color',
  'border-size':       '1',
  'renderer':          'webgl',
  'color-map':         'measured',
  'cpc-color-map':     'gate-array',
  'msx-color-map':     'pal',
  'einstein-color-map': 'accurate',
  'bbc-color-map':     'pal',
  'apple2-video':      'ntsc',
  'atari-color-map':   'tv',
  'scanline-accuracy': 'high',

  // Sound
  'volume':       '70',
  // Per-device levels (percent), one slider per hardware sound device on a machine
  // with more than one. Beeper/speaker and the main sound chip are 0-100; the
  // fitted DAC and speech board go to 200.
  'beeper-volume': '100',
  'psg-volume':   '100',
  'ay-stereo':    'ABC',
  // SN76489 tone-channel split; the chip is mono, so that is the default.
  'sn-stereo':    'MONO',
  'ay-dc-block':  'on',
  'ay-antialias': 'mute',
  // Level of the SpecDrum DAC channel (0-100), separate from master volume.
  'specdrum-volume': '100',
  // Level of the Currah µSpeech speech output (0-200).
  'uspeech-volume': '100',
  // Whether the Spectrum's MIC line leaks into the speaker mix (it does on real
  // hardware); off hides sync/trigger ticks that software pulses on it.
  'mic-audible':  'on',

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
  'tape-turbo-load':     'on',
  'tape-sound':          'on',

  // Behaviour
  'pause-on-blur': 'on',

  // Hardware
  'multiface':      'off',
  'vtx5000':        'off',
  'specdrum':       'off',
  'cpc-parados':    'off',
  'plusd':          'off',
  'interface1':     'off',
  'betadisk':       'off',
  'uspeech':        'off',
  'einstein-xtaldos': 'on',
  'mtx-cpm':        'off',
  'mtx-80-column':  'off',
  'mtx-512k-ram':   'off',
  'mtx-floppy':     'on',
  'msx-floppy':     'off',
  'bbc-disk-system': '1770',
  'electron-plus1': 'off',
  'electron-plus3': 'off',
  'electron-dfs':   'off',
  'lynx-fdc':       'on',
  'apple2-disk2':   'on',
  'drive-counts':   '{}',
  'drive-models':   '{}',
  'apple2-langcard': 'on',
  'apple2-joystick': 'on',
  'apple2-mockingboard': 'off',
  'apple2-80col':   'off',
  'apple2e-80col':  'on',
  'apple1-ram':     '8k',
  'apple1-basic-ram': 'on',
  'apple1-aci':     'off',
  'enterprise-exdos': 'on',
  'zx8x-16k-ram':  'off',
  'zx81-udg-ram':  'off',
  'zx81-udg128-ram': 'off',
  'zx81-wrx-hires': 'off',
  'zx81-memotech-hrg': 'off',
  'zx81-quicksilva-hrg': 'off',
  'ace-ram-pack':  '48k',
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

const _saturation = /*@once*/ createRoot(() => createSignal(getSavedNumber('saturation', D('saturation'))));
export const saturation = _saturation[0];
export const setSaturation = _saturation[1];

const _gamma = /*@once*/ createRoot(() => createSignal(getSavedNumber('gamma', D('gamma'))));
export const gamma = _gamma[0];
export const setGamma = _gamma[1];

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

// The Apple II's old 'green' video mode is now the generic green phosphor over its
// mono picture: migrate the saved choice once.
const legacyApple2Green = getSaved('apple2-video', '') === 'green';
if (legacyApple2Green) {
  setSaved('apple2-video', 'mono');
  if (getSaved('phosphor', '') === '') setSaved('phosphor', 'green');
}

const _phosphor = /*@once*/ createRoot(() => createSignal(parsePhosphor(getSaved('phosphor', D('phosphor')))));
export const phosphor = _phosphor[0];
export const setPhosphor = _phosphor[1];

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

const _msxColorMap = /*@once*/ createRoot(() => createSignal(getSaved('msx-color-map', D('msx-color-map')) as 'pal' | 'ntsc'));
export const msxColorMap = _msxColorMap[0];
export const setMsxColorMap = _msxColorMap[1];


const _einsteinColorMap = /*@once*/ createRoot(() => createSignal(getSaved('einstein-color-map', D('einstein-color-map')) as 'mame' | 'accurate' | 'naive'));
export const einsteinColorMap = _einsteinColorMap[0];
export const setEinsteinColorMap = _einsteinColorMap[1];

/** Atari palette id (see machines/atari/palette.ts); the machine falls back
 *  to its region's default for an id that region does not offer. */
const _atariColorMap = /*@once*/ createRoot(() => createSignal(getSaved('atari-color-map', D('atari-color-map'))));
export const atariColorMap = _atariColorMap[0];
export const setAtariColorMap = _atariColorMap[1];

const _scanlineAccuracy = /*@once*/ createRoot(() => createSignal(getSaved('scanline-accuracy', D('scanline-accuracy')) as 'high' | 'mid' | 'low'));
export const scanlineAccuracy = _scanlineAccuracy[0];
export const setScanlineAccuracy = _scanlineAccuracy[1];

// ── Sound settings ──────────────────────────────────────────────────────

const _volume = /*@once*/ createRoot(() => createSignal(getSavedNumber('volume', D('volume'))));
export const volume = _volume[0];
export const setVolume = _volume[1];

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

const _beeperVolume = /*@once*/ createRoot(() => createSignal(getSavedVolume('beeper-volume', (m) => 2 * (100 - m))));
export const beeperVolume = _beeperVolume[0];
export const setBeeperVolume = _beeperVolume[1];

const _psgVolume = /*@once*/ createRoot(() => createSignal(getSavedVolume('psg-volume', (m) => 2 * m)));
export const psgVolume = _psgVolume[0];
export const setPsgVolume = _psgVolume[1];

const _ayStereo = /*@once*/ createRoot(() => createSignal(getSaved('ay-stereo', D('ay-stereo'))));
export const ayStereo = _ayStereo[0];
export const setAyStereo = _ayStereo[1];

const _snStereo = /*@once*/ createRoot(() => createSignal(getSaved('sn-stereo', D('sn-stereo'))));
export const snStereo = _snStereo[0];
export const setSnStereo = _snStereo[1];

const _ayDcBlock = /*@once*/ createRoot(() => createSignal(getSaved('ay-dc-block', D('ay-dc-block')) === 'on'));
export const ayDcBlock = _ayDcBlock[0];
export const setAyDcBlock = _ayDcBlock[1];

const _ayAntialias = /*@once*/ createRoot(() => createSignal(getSaved('ay-antialias', D('ay-antialias'))));
export const ayAntialias = _ayAntialias[0];
export const setAyAntialias = _ayAntialias[1];

const _specdrumVolume = /*@once*/ createRoot(() => createSignal(getSavedNumber('specdrum-volume', D('specdrum-volume'))));
export const specdrumVolume = _specdrumVolume[0];
export const setSpecdrumVolume = _specdrumVolume[1];

const _uspeechVolume = /*@once*/ createRoot(() => createSignal(getSavedNumber('uspeech-volume', D('uspeech-volume'))));
export const uspeechVolume = _uspeechVolume[0];
export const setUspeechVolume = _uspeechVolume[1];

const _micAudible = /*@once*/ createRoot(() => createSignal(getSaved('mic-audible', D('mic-audible')) === 'on'));
export const micAudible = _micAudible[0];
export const setMicAudible = _micAudible[1];

/** Per-device Sound-pane volume signals, keyed by the setting a machine
 *  descriptor names in `soundDevices[].volumeSetting` — so the generic pane
 *  can drive a slider from the descriptor without knowing which device it is. */
export const DEVICE_VOLUMES: Readonly<Record<string, readonly [() => number, (v: number) => void]>> = {
  'beeper-volume': [beeperVolume, setBeeperVolume],
  'psg-volume': [psgVolume, setPsgVolume],
  'specdrum-volume': [specdrumVolume, setSpecdrumVolume],
  'uspeech-volume': [uspeechVolume, setUspeechVolume],
};

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

// Persisted key strings are kept stable ('tape-instant-rom', 'tape-turbo-load')
// so existing saved prefs survive; only the signal names follow the UI wording:
// Fast ROM loading / Turbo while loading.
const _tapeFastRom = /*@once*/ createRoot(() => createSignal(getSaved('tape-instant-rom', D('tape-instant-rom')) === 'on'));
export const tapeFastRom = _tapeFastRom[0];
export const setTapeFastRom = _tapeFastRom[1];

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

const _cpcParados = /*@once*/ createRoot(() => createSignal(getSaved('cpc-parados', D('cpc-parados')) === 'on'));
export const cpcParados = _cpcParados[0];
export const setCpcParados = _cpcParados[1];

/** Megabytes fitted to the external megabyte interface, 0-4. 0 = not fitted. */

const _einsteinXtalDos = /*@once*/ createRoot(() => createSignal(getSaved('einstein-xtaldos', D('einstein-xtaldos')) === 'on'));
export const einsteinXtalDos = _einsteinXtalDos[0];
export const setEinsteinXtalDos = _einsteinXtalDos[1];

const _mtxCpm = /*@once*/ createRoot(() => createSignal(getSaved('mtx-cpm', D('mtx-cpm')) === 'on'));
export const mtxCpm = _mtxCpm[0];
export const setMtxCpm = _mtxCpm[1];

const _mtx80Column = /*@once*/ createRoot(() => createSignal(getSaved('mtx-80-column', D('mtx-80-column')) === 'on'));
export const mtx80Column = _mtx80Column[0];
export const setMtx80Column = _mtx80Column[1];

const _apple2Disk2 = /*@once*/ createRoot(() => createSignal(getSaved('apple2-disk2', D('apple2-disk2')) === 'on'));
export const apple2Disk2 = _apple2Disk2[0];
export const setApple2Disk2 = _apple2Disk2[1];

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
  const counts = parseDriveCounts(getSaved('drive-counts', D('drive-counts')));
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
  const models = parseDriveModels(getSaved('drive-models', D('drive-models')));
  // The Atari used to have one model for every drive, set in the Hardware pane.
  const legacy = getSaved('atari-disk-drive', '');
  if (models.atari === undefined && legacy !== '') models.atari = [legacy, legacy];
  return models;
}

const _driveModels = /*@once*/ createRoot(() => createSignal(initialDriveModels()));
const setDriveModelsJson = (json: string): void => { _driveModels[1](parseDriveModels(json)); };

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

const _driveCounts = /*@once*/ createRoot(() => createSignal(initialDriveCounts()));
const setDriveCountsJson = (json: string): void => { _driveCounts[1](parseDriveCounts(json)); };

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

const _apple2LangCard = /*@once*/ createRoot(() => createSignal(getSaved('apple2-langcard', D('apple2-langcard')) === 'on'));
export const apple2LangCard = _apple2LangCard[0];
export const setApple2LangCard = _apple2LangCard[1];

const _apple2Joystick = /*@once*/ createRoot(() => createSignal(getSaved('apple2-joystick', D('apple2-joystick')) === 'on'));
export const apple2Joystick = _apple2Joystick[0];
export const setApple2Joystick = _apple2Joystick[1];

const _apple2Mockingboard = /*@once*/ createRoot(() => createSignal(getSaved('apple2-mockingboard', D('apple2-mockingboard')) === 'on'));
export const apple2Mockingboard = _apple2Mockingboard[0];
export const setApple2Mockingboard = _apple2Mockingboard[1];

const _apple2EightyCol = /*@once*/ createRoot(() => createSignal(getSaved('apple2-80col', D('apple2-80col')) === 'on'));
export const apple2EightyCol = _apple2EightyCol[0];
export const setApple2EightyCol = _apple2EightyCol[1];

const _apple2eEightyCol = /*@once*/ createRoot(() => createSignal(getSaved('apple2e-80col', D('apple2e-80col')) === 'on'));
export const apple2eEightyCol = _apple2eEightyCol[0];
export const setApple2eEightyCol = _apple2eEightyCol[1];

const _apple1Ram = /*@once*/ createRoot(() => createSignal(
  getSaved('apple1-ram', D('apple1-ram')) as '4k' | '8k' | '16k' | '32k' | '48k'));
export const apple1Ram = _apple1Ram[0];
export const setApple1Ram = _apple1Ram[1];

const _apple1BasicRam = /*@once*/ createRoot(() => createSignal(getSaved('apple1-basic-ram', D('apple1-basic-ram')) === 'on'));
export const apple1BasicRam = _apple1BasicRam[0];
export const setApple1BasicRam = _apple1BasicRam[1];

const _apple1Aci = /*@once*/ createRoot(() => createSignal(getSaved('apple1-aci', D('apple1-aci')) === 'on'));
export const apple1Aci = _apple1Aci[0];
export const setApple1Aci = _apple1Aci[1];

const _mtx512kRam = /*@once*/ createRoot(() => createSignal(getSaved('mtx-512k-ram', D('mtx-512k-ram')) === 'on'));
export const mtx512kRam = _mtx512kRam[0];
export const setMtx512kRam = _mtx512kRam[1];

const _mtxFloppy = /*@once*/ createRoot(() => createSignal(getSaved('mtx-floppy', D('mtx-floppy')) === 'on'));
export const mtxFloppy = _mtxFloppy[0];
export const setMtxFloppy = _mtxFloppy[1];

const _msxFloppy = /*@once*/ createRoot(() => createSignal(getSaved('msx-floppy', D('msx-floppy')) === 'on'));
export const msxFloppy = _msxFloppy[0];
export const setMsxFloppy = _msxFloppy[1];

const _bbcColorMap = /*@once*/ createRoot(() => createSignal(getSaved('bbc-color-map', D('bbc-color-map')) as 'pal' | 'measured'));
export const bbcColorMap = _bbcColorMap[0];
export const setBbcColorMap = _bbcColorMap[1];

const _apple2Video = /*@once*/ createRoot(() => createSignal(
  getSaved('apple2-video', D('apple2-video')) as 'mono' | 'ntsc' | 'pal'));
export const apple2Video = _apple2Video[0];
export const setApple2Video = _apple2Video[1];

const _bbcDiskSystem = /*@once*/ createRoot(() => createSignal(
  getSaved('bbc-disk-system', D('bbc-disk-system')) as 'none' | 'acorn' | '1770'));
export const bbcDiskSystem = _bbcDiskSystem[0];
export const setBbcDiskSystem = _bbcDiskSystem[1];

const _electronPlus1 = /*@once*/ createRoot(() => createSignal(getSaved('electron-plus1', D('electron-plus1')) === 'on'));
export const electronPlus1 = _electronPlus1[0];
export const setElectronPlus1 = _electronPlus1[1];

const _electronPlus3 = /*@once*/ createRoot(() => createSignal(getSaved('electron-plus3', D('electron-plus3')) === 'on'));
export const electronPlus3 = _electronPlus3[0];
export const setElectronPlus3 = _electronPlus3[1];

const _electronDfs = /*@once*/ createRoot(() => createSignal(getSaved('electron-dfs', D('electron-dfs')) === 'on'));
export const electronDfs = _electronDfs[0];
export const setElectronDfs = _electronDfs[1];

const _lynxFdc = /*@once*/ createRoot(() => createSignal(getSaved('lynx-fdc', D('lynx-fdc')) === 'on'));
export const lynxFdc = _lynxFdc[0];
export const setLynxFdc = _lynxFdc[1];

/** Enterprise EXDOS disk card (WD1770 + EXDOS ROM) fitted. */
const _enterpriseExdos = /*@once*/ createRoot(() => createSignal(getSaved('enterprise-exdos', D('enterprise-exdos')) === 'on'));
export const enterpriseExdos = _enterpriseExdos[0];
export const setEnterpriseExdos = _enterpriseExdos[1];

const _zx8x16kRam = /*@once*/ createRoot(() => createSignal(getSaved('zx8x-16k-ram', D('zx8x-16k-ram')) === 'on'));
export const zx8x16kRam = _zx8x16kRam[0];
export const setZx8x16kRam = _zx8x16kRam[1];

const _zx81UdgRam = /*@once*/ createRoot(() => createSignal(getSaved('zx81-udg-ram', D('zx81-udg-ram')) === 'on'));
export const zx81UdgRam = _zx81UdgRam[0];
export const setZx81UdgRam = _zx81UdgRam[1];

const _zx81Udg128Ram = /*@once*/ createRoot(() => createSignal(getSaved('zx81-udg128-ram', D('zx81-udg128-ram')) === 'on'));
export const zx81Udg128Ram = _zx81Udg128Ram[0];
export const setZx81Udg128Ram = _zx81Udg128Ram[1];

const _zx81WrxHires = /*@once*/ createRoot(() => createSignal(getSaved('zx81-wrx-hires', D('zx81-wrx-hires')) === 'on'));
export const zx81WrxHires = _zx81WrxHires[0];
export const setZx81WrxHires = _zx81WrxHires[1];

const _zx81MemotechHrg = /*@once*/ createRoot(() => createSignal(getSaved('zx81-memotech-hrg', D('zx81-memotech-hrg')) === 'on'));
export const zx81MemotechHrg = _zx81MemotechHrg[0];
export const setZx81MemotechHrg = _zx81MemotechHrg[1];

const _zx81QuickSilvaHrg = /*@once*/ createRoot(() => createSignal(getSaved('zx81-quicksilva-hrg', D('zx81-quicksilva-hrg')) === 'on'));
export const zx81QuickSilvaHrg = _zx81QuickSilvaHrg[0];
export const setZx81QuickSilvaHrg = _zx81QuickSilvaHrg[1];

/** Jupiter Ace RAM pack: 'none' (stock 3K), '16k' (16K pack, 19K total) or
 *  '48k' (48K pack, 51K total). The 48K pack is the default. */
const _aceRamPack = /*@once*/ createRoot(() => createSignal(getSaved('ace-ram-pack', D('ace-ram-pack')) as 'none' | '16k' | '48k'));
export const aceRamPack = _aceRamPack[0];
export const setAceRamPack = _aceRamPack[1];

const _vtx5000Enabled = /*@once*/ createRoot(() => createSignal(getSaved('vtx5000', D('vtx5000')) === 'on'));
export const vtx5000Enabled = _vtx5000Enabled[0];
export const setVtx5000Enabled = _vtx5000Enabled[1];

const _specdrumEnabled = /*@once*/ createRoot(() => createSignal(getSaved('specdrum', D('specdrum')) === 'on'));
export const specdrumEnabled = _specdrumEnabled[0];
export const setSpecdrumEnabled = _specdrumEnabled[1];

const _plusDEnabled = /*@once*/ createRoot(() => createSignal(getSaved('plusd', D('plusd')) === 'on'));
export const plusDEnabled = _plusDEnabled[0];
export const setPlusDEnabled = _plusDEnabled[1];

const _betaDiskEnabled = /*@once*/ createRoot(() => createSignal(getSaved('betadisk', D('betadisk')) === 'on'));
export const betaDiskEnabled = _betaDiskEnabled[0];
export const setBetaDiskEnabled = _betaDiskEnabled[1];

const _interface1Enabled = /*@once*/ createRoot(() => createSignal(getSaved('interface1', D('interface1')) === 'on'));
export const interface1Enabled = _interface1Enabled[0];
export const setInterface1Enabled = _interface1Enabled[1];

const _uspeechEnabled = /*@once*/ createRoot(() => createSignal(getSaved('uspeech', D('uspeech')) === 'on'));
export const uspeechEnabled = _uspeechEnabled[0];
export const setUspeechEnabled = _uspeechEnabled[1];

// ── Behaviour settings ──────────────────────────────────────────────────

const _pauseOnFocusLost = /*@once*/ createRoot(() => createSignal(getSaved('pause-on-blur', D('pause-on-blur')) === 'on'));
export const pauseOnFocusLost = _pauseOnFocusLost[0];
export const setPauseOnFocusLost = _pauseOnFocusLost[1];

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
    { key: 'scaling-mode',      set: setScalingMode,      type: 'number' },
    { key: 'border-size',       set: setBorderSize,       type: 'number' },
    { key: 'color-map',         set: setColorMap,         type: 'string' },
    { key: 'cpc-color-map',     set: setCpcColorMap,      type: 'string' },
    { key: 'msx-color-map',     set: setMsxColorMap,      type: 'string' },
    { key: 'einstein-color-map', set: setEinsteinColorMap, type: 'string' },
    { key: 'bbc-color-map',     set: setBbcColorMap,      type: 'string' },
    { key: 'apple2-video',      set: setApple2Video,      type: 'string' },
    { key: 'atari-color-map',   set: setAtariColorMap,    type: 'string' },
    { key: 'scanline-accuracy', set: setScanlineAccuracy, type: 'string' },
  ],
  monitor: [
    { key: 'brightness',        set: setBrightness,       type: 'number' },
    { key: 'contrast',          set: setContrast,         type: 'number' },
    { key: 'saturation',        set: setSaturation,       type: 'number' },
    { key: 'gamma',             set: setGamma,            type: 'number' },
    { key: 'smoothing',         set: setSmoothing,        type: 'number' },
    { key: 'curvature',         set: setCurvature,        type: 'number' },
    { key: 'scanlines',         set: setScanlines,        type: 'number' },
    { key: 'mask-type',         set: setMaskType,         type: 'number' },
    { key: 'dot-pitch',         set: setDotPitch,         type: 'number' },
    { key: 'curvature-mode',    set: setCurvatureMode,    type: 'number' },
    { key: 'noise',             set: setNoise,            type: 'number' },
    { key: 'monitor',           set: setMonitor,          type: 'string' },
    { key: 'phosphor',          set: setPhosphor,         type: 'string' },
  ],
  sound: [
    { key: 'volume',      set: setVolume,     type: 'number' },
    { key: 'beeper-volume', set: setBeeperVolume, type: 'number' },
    { key: 'psg-volume',  set: setPsgVolume,  type: 'number' },
    { key: 'ay-stereo',   set: setAyStereo,   type: 'string' },
    { key: 'sn-stereo',   set: setSnStereo,   type: 'string' },
    { key: 'ay-dc-block', set: setAyDcBlock,  type: 'bool' },
    { key: 'ay-antialias', set: setAyAntialias, type: 'string' },
    { key: 'specdrum-volume', set: setSpecdrumVolume, type: 'number' },
    { key: 'uspeech-volume', set: setUspeechVolume, type: 'number' },
    { key: 'mic-audible', set: setMicAudible, type: 'bool' },
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
    { key: 'drive-counts',        set: setDriveCountsJson,  type: 'string' },
    { key: 'drive-models',        set: setDriveModelsJson,  type: 'string' },
  ],
  tape: [
    { key: 'tape-auto-rewind',     set: setTapeAutoRewind,     type: 'bool' },
    { key: 'tape-collapse-blocks', set: setTapeCollapseBlocks, type: 'bool' },
    { key: 'tape-instant-rom',     set: setTapeFastRom,        type: 'bool' },
    { key: 'tape-turbo-load',      set: setTapeTurbo,          type: 'bool' },
    { key: 'tape-sound',           set: setTapeSoundEnabled,   type: 'bool' },
  ],
  hardware: [
    { key: 'multiface',      set: setMultifaceEnabled, type: 'bool' },
    { key: 'vtx5000',        set: setVtx5000Enabled,   type: 'bool' },
    { key: 'specdrum',       set: setSpecdrumEnabled,  type: 'bool' },
    { key: 'cpc-parados',    set: setCpcParados,        type: 'bool' },
    { key: 'plusd',          set: setPlusDEnabled,     type: 'bool' },
    { key: 'betadisk',       set: setBetaDiskEnabled,  type: 'bool' },
    { key: 'interface1',     set: setInterface1Enabled, type: 'bool' },
    { key: 'uspeech',        set: setUspeechEnabled,   type: 'bool' },
    { key: 'einstein-xtaldos', set: setEinsteinXtalDos, type: 'bool' },
    { key: 'mtx-cpm', set: setMtxCpm, type: 'bool' },
    { key: 'mtx-80-column', set: setMtx80Column, type: 'bool' },
    { key: 'mtx-512k-ram', set: setMtx512kRam, type: 'bool' },
    { key: 'mtx-floppy', set: setMtxFloppy, type: 'bool' },
    { key: 'msx-floppy', set: setMsxFloppy, type: 'bool' },
    { key: 'bbc-disk-system', set: setBbcDiskSystem, type: 'string' },
    { key: 'electron-plus1', set: setElectronPlus1, type: 'bool' },
    { key: 'electron-plus3', set: setElectronPlus3, type: 'bool' },
    { key: 'electron-dfs', set: setElectronDfs, type: 'bool' },
    { key: 'lynx-fdc', set: setLynxFdc, type: 'bool' },
    { key: 'apple2-disk2', set: setApple2Disk2, type: 'bool' },
    { key: 'apple2-langcard', set: setApple2LangCard, type: 'bool' },
    { key: 'apple2-joystick', set: setApple2Joystick, type: 'bool' },
    { key: 'apple2-mockingboard', set: setApple2Mockingboard, type: 'bool' },
    { key: 'apple2-80col', set: setApple2EightyCol, type: 'bool' },
    { key: 'apple2e-80col', set: setApple2eEightyCol, type: 'bool' },
    { key: 'apple1-ram', set: setApple1Ram, type: 'string' },
    { key: 'apple1-basic-ram', set: setApple1BasicRam, type: 'bool' },
    { key: 'apple1-aci', set: setApple1Aci, type: 'bool' },
    { key: 'enterprise-exdos', set: setEnterpriseExdos, type: 'bool' },
    { key: 'zx8x-16k-ram', set: setZx8x16kRam, type: 'bool' },
    { key: 'zx81-udg-ram', set: setZx81UdgRam, type: 'bool' },
    { key: 'zx81-udg128-ram', set: setZx81Udg128Ram, type: 'bool' },
    { key: 'zx81-wrx-hires', set: setZx81WrxHires, type: 'bool' },
    { key: 'zx81-memotech-hrg', set: setZx81MemotechHrg, type: 'bool' },
    { key: 'zx81-quicksilva-hrg', set: setZx81QuickSilvaHrg, type: 'bool' },
    { key: 'ace-ram-pack', set: setAceRamPack, type: 'string' },
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
