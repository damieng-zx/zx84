/**
 * Persisted display/sound/joystick settings as signals.
 */

import { createSignal, createMemo, createRoot, type Signal } from 'solid-js';
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
  'ay-antialias': 'mute',
  // Level of the SpecDrum DAC channel (0-100), separate from master volume.
  'specdrum-volume': '100',
  // Level of the Currah µSpeech speech output (0-200).
  'uspeech-volume': '100',
  'scc-volume': '100',

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
  'spectrum-issue2': 'off',
  'cpc-parados':    'off',
  'cpc-crtc-type':  '0',
  'cpc-ram-expansion': 'none',
  'cpc-ddi1':       'off',
  'cpc-manufacturer': 'amstrad',
  'cpc-refresh':    '50',
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
  'bbc-swr':        '0',
  'electron-plus1': 'off',
  'electron-plus3': 'off',
  'electron-dfs':   'off',
  'lynx-fdc':       'on',
  'pcw-60hz':       'off',
  'apple2-disk2':   'on',
  'c64-drive':      'on',
  'c64-sid':        '6581',
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
  'zx81-zx-printer': 'off',
  'zx81-chroma81': 'off',
  'zx8x-zonx':     'off',
  'zx8x-vsync-sound': 'off',
  'ace-ram-pack':  '48k',
} as const;

type SettingKey = keyof typeof DEFAULTS;
const D = (k: SettingKey): string => DEFAULTS[k];

/** A module-level signal, created in its own root so it outlives any component. */
const signal = <T>(initial: T): Signal<T> => createRoot(() => createSignal(initial));

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

export const [scale, setScale] = signal(savedNumber('scale'));
export const [brightness, setBrightness] = signal(savedNumber('brightness'));
export const [contrast, setContrast] = signal(savedNumber('contrast'));
export const [saturation, setSaturation] = signal(savedNumber('saturation'));
export const [gamma, setGamma] = signal(savedNumber('gamma'));
export const [smoothing, setSmoothing] = signal(savedNumber('smoothing'));
export const [curvature, setCurvature] = signal(savedNumber('curvature'));
export const [scanlines, setScanlines] = signal(savedNumber('scanlines'));
export const [maskType, setMaskType] = signal(savedNumber('mask-type'));
export const [dotPitch, setDotPitch] = signal(savedNumber('dot-pitch'));
export const [curvatureMode, setCurvatureMode] = signal(savedNumber('curvature-mode'));
export const [noise, setNoise] = signal(savedNumber('noise'));
export const [scalingMode, setScalingMode] = signal(savedNumber('scaling-mode'));

// The Apple II's old 'green' video mode is now the generic green phosphor over its
// mono picture: migrate the saved choice once.
const legacyApple2Green = getSaved('apple2-video', '') === 'green';
if (legacyApple2Green) {
  setSaved('apple2-video', 'mono');
  if (getSaved('phosphor', '') === '') setSaved('phosphor', 'green');
}

export const [phosphor, setPhosphor] = signal(parsePhosphor(savedText('phosphor')));
export const [monitor, setMonitor] = signal(savedText('monitor'));
export const [borderSize, setBorderSize] = signal(savedNumber('border-size'));
export const [renderer, setRenderer] = signal(savedText('renderer') as 'webgl' | 'canvas');

// Runtime-only: cleared when WebGL context creation fails so the UI can
// hide the option and emulator.ts can avoid retrying.
export const [webglAvailable, setWebglAvailable] = signal(true);
export const [colorMap, setColorMap] = signal(savedText('color-map') as 'basic' | 'measured' | 'vivid');
export const [cpcColorMap, setCpcColorMap] = signal(savedText('cpc-color-map') as 'basic' | 'gate-array' | 'asic');
export const [msxColorMap, setMsxColorMap] = signal(savedText('msx-color-map') as 'pal' | 'ntsc');


export const [einsteinColorMap, setEinsteinColorMap] = signal(savedText('einstein-color-map') as 'mame' | 'accurate' | 'naive');

/** Atari palette id (see machines/atari/palette.ts); the machine falls back
 *  to its region's default for an id that region does not offer. */
export const [atariColorMap, setAtariColorMap] = signal(savedText('atari-color-map'));
export const [scanlineAccuracy, setScanlineAccuracy] = signal(savedText('scanline-accuracy') as 'high' | 'mid' | 'low');

// ── Sound settings ──────────────────────────────────────────────────────

export const [volume, setVolume] = signal(savedNumber('volume'));

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

export const [beeperVolume, setBeeperVolume] = signal(getSavedVolume('beeper-volume', (m) => 2 * (100 - m)));
export const [psgVolume, setPsgVolume] = signal(getSavedVolume('psg-volume', (m) => 2 * m));
export const [ayStereo, setAyStereo] = signal(savedText('ay-stereo'));
export const [snStereo, setSnStereo] = signal(savedText('sn-stereo'));


export const [ayAntialias, setAyAntialias] = signal(savedText('ay-antialias'));
export const [specdrumVolume, setSpecdrumVolume] = signal(savedNumber('specdrum-volume'));
export const [uspeechVolume, setUspeechVolume] = signal(savedNumber('uspeech-volume'));
export const [sccVolume, setSccVolume] = signal(savedNumber('scc-volume'));

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

export const [joyP1, setJoyP1] = signal(savedText('joy-p1'));
export const [joyP2, setJoyP2] = signal(savedText('joy-p2'));
export const [joyMapP1, setJoyMapP1] = signal(savedText('joy-map-p1'));
export const [joyMapP2, setJoyMapP2] = signal(savedText('joy-map-p2'));

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

export const [fontName, setFontName] = signal(savedText('font'));

// ── Text/OCR overlay settings ──────────────────────────────────────────

export const [ocrFont, setOcrFont] = signal(savedText('ocr-font'));
export const [ocrLineHeight, setOcrLineHeight] = signal(savedNumber('ocr-line-height'));
export const [ocrTracking, setOcrTracking] = signal(savedNumber('ocr-tracking'));
export const [ocrOffsetX, setOcrOffsetX] = signal(savedNumber('ocr-offset-x'));
export const [ocrOffsetY, setOcrOffsetY] = signal(savedNumber('ocr-offset-y'));
export const [ocrScaleX, setOcrScaleX] = signal(savedNumber('ocr-scale-x'));
export const [ocrScaleY, setOcrScaleY] = signal(savedNumber('ocr-scale-y'));

// ── Disk mode ───────────────────────────────────────────────────────────

export const [diskSoundA, setDiskSoundA] = signal(savedFlag('disk-sound-a'));
export const [diskSoundB, setDiskSoundB] = signal(savedFlag('disk-sound-b'));
export const [writeProtectA, setWriteProtectA] = signal(savedFlag('write-protect-a'));
export const [writeProtectB, setWriteProtectB] = signal(savedFlag('write-protect-b'));
export const [driveBForceReady, setDriveBForceReady] = signal(savedFlag('drive-b-force-ready'));
export const [diskSoundC, setDiskSoundC] = signal(savedFlag('disk-sound-c'));
export const [diskSoundD, setDiskSoundD] = signal(savedFlag('disk-sound-d'));
export const [writeProtectC, setWriteProtectC] = signal(savedFlag('write-protect-c'));
export const [writeProtectD, setWriteProtectD] = signal(savedFlag('write-protect-d'));

// ── Tape settings ───────────────────────────────────────────────────────

export const [tapeAutoRewind, setTapeAutoRewind] = signal(savedFlag('tape-auto-rewind'));
export const [tapeCollapseBlocks, setTapeCollapseBlocks] = signal(savedFlag('tape-collapse-blocks'));

// Persisted key strings are kept stable ('tape-instant-rom', 'tape-turbo-load')
// so existing saved prefs survive; only the signal names follow the UI wording:
// Fast ROM loading / Turbo while loading.
export const [tapeFastRom, setTapeFastRom] = signal(savedFlag('tape-instant-rom'));
export const [tapeTurbo, setTapeTurbo] = signal(savedFlag('tape-turbo-load'));
export const [tapeSoundEnabled, setTapeSoundEnabled] = signal(savedFlag('tape-sound'));

// ── Multiface ────────────────────────────────────────────────────────

export const [multifaceEnabled, setMultifaceEnabled] = signal(savedFlag('multiface'));
export const [cpcParados, setCpcParados] = signal(savedFlag('cpc-parados'));
/** CPC 464/664/6128 CRTC type, '0'-'3' (see machines/cpc/options.ts). */
export const [cpcCrtcType, setCpcCrtcType] = signal(savedText('cpc-crtc-type'));
/** CPC RAM expansion: 'none', '256k' or '512k'. */
export const [cpcRamExpansion, setCpcRamExpansion] = signal(savedText('cpc-ram-expansion'));
/** DDI-1 disk interface on the CPC 464. */
export const [cpcDdi1, setCpcDdi1] = signal(savedFlag('cpc-ddi1'));
/** CPC distributor name links (LK1-LK3), e.g. 'amstrad', 'schneider'. */
export const [cpcManufacturer, setCpcManufacturer] = signal(savedText('cpc-manufacturer'));
/** CPC 50/60 Hz link (LK4): '50' or '60'. */
export const [cpcRefresh, setCpcRefresh] = signal(savedText('cpc-refresh'));

/** Megabytes fitted to the external megabyte interface, 0-4. 0 = not fitted. */

export const [einsteinXtalDos, setEinsteinXtalDos] = signal(savedFlag('einstein-xtaldos'));
export const [mtxCpm, setMtxCpm] = signal(savedFlag('mtx-cpm'));
export const [mtx80Column, setMtx80Column] = signal(savedFlag('mtx-80-column'));
export const [apple2Disk2, setApple2Disk2] = signal(savedFlag('apple2-disk2'));
export const [c64Drive, setC64Drive] = signal(savedFlag('c64-drive'));
/** Which SID the 64 has: '6581' (the original) or '8580' (the C64C's). */
export const [c64Sid, setC64Sid] = signal(savedText('c64-sid'));

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

export const [apple2LangCard, setApple2LangCard] = signal(savedFlag('apple2-langcard'));
export const [apple2Joystick, setApple2Joystick] = signal(savedFlag('apple2-joystick'));
export const [apple2Mockingboard, setApple2Mockingboard] = signal(savedFlag('apple2-mockingboard'));
export const [apple2EightyCol, setApple2EightyCol] = signal(savedFlag('apple2-80col'));
export const [apple2eEightyCol, setApple2eEightyCol] = signal(savedFlag('apple2e-80col'));

export const [apple1Ram, setApple1Ram] = signal(
  savedText('apple1-ram') as '4k' | '8k' | '16k' | '32k' | '48k');

export const [apple1BasicRam, setApple1BasicRam] = signal(savedFlag('apple1-basic-ram'));
export const [apple1Aci, setApple1Aci] = signal(savedFlag('apple1-aci'));
export const [mtx512kRam, setMtx512kRam] = signal(savedFlag('mtx-512k-ram'));
export const [mtxFloppy, setMtxFloppy] = signal(savedFlag('mtx-floppy'));
export const [msxFloppy, setMsxFloppy] = signal(savedFlag('msx-floppy'));
export const [bbcColorMap, setBbcColorMap] = signal(savedText('bbc-color-map') as 'pal' | 'measured');

export const [apple2Video, setApple2Video] = signal(
  savedText('apple2-video') as 'mono' | 'ntsc' | 'pal');

export const [bbcDiskSystem, setBbcDiskSystem] = signal(
  savedText('bbc-disk-system') as 'none' | 'acorn' | '1770');
/** Sideways-RAM sockets fitted, as a decimal bit mask (bit n = socket n). */
export const [bbcSwr, setBbcSwr] = signal(savedText('bbc-swr'));

export const [electronPlus1, setElectronPlus1] = signal(savedFlag('electron-plus1'));
export const [electronPlus3, setElectronPlus3] = signal(savedFlag('electron-plus3'));
export const [electronDfs, setElectronDfs] = signal(savedFlag('electron-dfs'));
export const [lynxFdc, setLynxFdc] = signal(savedFlag('lynx-fdc'));
/** Amstrad PCW 50/60Hz link: on = a 60Hz machine (260-line frame, 200 lines shown). */
export const [pcw60Hz, setPcw60Hz] = signal(savedFlag('pcw-60hz'));

/** Enterprise EXDOS disk card (WD1770 + EXDOS ROM) fitted. */
export const [enterpriseExdos, setEnterpriseExdos] = signal(savedFlag('enterprise-exdos'));
export const [zx8x16kRam, setZx8x16kRam] = signal(savedFlag('zx8x-16k-ram'));
export const [zx81UdgRam, setZx81UdgRam] = signal(savedFlag('zx81-udg-ram'));
export const [zx81Udg128Ram, setZx81Udg128Ram] = signal(savedFlag('zx81-udg128-ram'));
export const [zx81WrxHires, setZx81WrxHires] = signal(savedFlag('zx81-wrx-hires'));
export const [zx81MemotechHrg, setZx81MemotechHrg] = signal(savedFlag('zx81-memotech-hrg'));
export const [zx81QuickSilvaHrg, setZx81QuickSilvaHrg] = signal(savedFlag('zx81-quicksilva-hrg'));
/** ZX81 ZX Printer on port 0xFB. */
export const [zx81ZxPrinter, setZx81ZxPrinter] = signal(savedFlag('zx81-zx-printer'));
/** ZX81 Chroma 81 colour interface. */
export const [zx81Chroma81, setZx81Chroma81] = signal(savedFlag('zx81-chroma81'));
/** ZX80/ZX81 ZON X-81 AY sound interface. */
export const [zx8xZonx, setZx8xZonx] = signal(savedFlag('zx8x-zonx'));
/** ZX80/ZX81 vertical sync (the MIC line) mixed into the sound. */
export const [zx8xVsyncSound, setZx8xVsyncSound] = signal(savedFlag('zx8x-vsync-sound'));

/** Jupiter Ace RAM pack: 'none' (stock 3K), '16k' (16K pack, 19K total) or
 *  '48k' (48K pack, 51K total). The 48K pack is the default. */
export const [aceRamPack, setAceRamPack] = signal(savedText('ace-ram-pack') as 'none' | '16k' | '48k');
export const [vtx5000Enabled, setVtx5000Enabled] = signal(savedFlag('vtx5000'));
export const [specdrumEnabled, setSpecdrumEnabled] = signal(savedFlag('specdrum'));
/** 16K/48K board issue: on = Issue 1/2 (port 0xFE bit 6 follows OUT bits 3 and 4),
 *  off = Issue 3 (bit 4 alone). */
export const [spectrumIssue2, setSpectrumIssue2] = signal(savedFlag('spectrum-issue2'));
export const [plusDEnabled, setPlusDEnabled] = signal(savedFlag('plusd'));
export const [betaDiskEnabled, setBetaDiskEnabled] = signal(savedFlag('betadisk'));
export const [interface1Enabled, setInterface1Enabled] = signal(savedFlag('interface1'));
export const [uspeechEnabled, setUspeechEnabled] = signal(savedFlag('uspeech'));

// ── Behaviour settings ──────────────────────────────────────────────────

export const [pauseOnFocusLost, setPauseOnFocusLost] = signal(savedFlag('pause-on-blur'));

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
    { key: 'ay-antialias', set: setAyAntialias, type: 'string' },
    { key: 'c64-sid',     set: setC64Sid,     type: 'string' },
    { key: 'specdrum-volume', set: setSpecdrumVolume, type: 'number' },
    { key: 'uspeech-volume', set: setUspeechVolume, type: 'number' },
    { key: 'scc-volume', set: setSccVolume, type: 'number' },
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
    { key: 'spectrum-issue2', set: setSpectrumIssue2,  type: 'bool' },
    { key: 'cpc-parados',    set: setCpcParados,        type: 'bool' },
    { key: 'cpc-crtc-type',  set: setCpcCrtcType,       type: 'string' },
    { key: 'cpc-ram-expansion', set: setCpcRamExpansion, type: 'string' },
    { key: 'cpc-ddi1',       set: setCpcDdi1,           type: 'bool' },
    { key: 'cpc-manufacturer', set: setCpcManufacturer, type: 'string' },
    { key: 'cpc-refresh',    set: setCpcRefresh,        type: 'string' },
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
    { key: 'bbc-swr', set: setBbcSwr, type: 'string' },
    { key: 'electron-plus1', set: setElectronPlus1, type: 'bool' },
    { key: 'electron-plus3', set: setElectronPlus3, type: 'bool' },
    { key: 'electron-dfs', set: setElectronDfs, type: 'bool' },
    { key: 'lynx-fdc', set: setLynxFdc, type: 'bool' },
    { key: 'pcw-60hz', set: setPcw60Hz, type: 'bool' },
    { key: 'apple2-disk2', set: setApple2Disk2, type: 'bool' },
    { key: 'c64-drive', set: setC64Drive, type: 'bool' },
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
    { key: 'zx81-zx-printer', set: setZx81ZxPrinter, type: 'bool' },
    { key: 'zx81-chroma81', set: setZx81Chroma81, type: 'bool' },
    { key: 'zx8x-zonx', set: setZx8xZonx, type: 'bool' },
    { key: 'zx8x-vsync-sound', set: setZx8xVsyncSound, type: 'bool' },
    { key: 'ace-ram-pack', set: setAceRamPack, type: 'string' },
  ],
  font: [
    { key: 'font', set: setFontName, type: 'string' },
  ],
};

/**
 * Set and persist a boolean setting by its key, for a change that starts in a
 * machine rather than a pane (a snapshot that records a board option). Returns
 * false, changing nothing, for a key that is not a known boolean setting.
 */
export function setFlagSetting(key: string, on: boolean): boolean {
  for (const defs of Object.values(PANE_SETTINGS)) {
    for (const d of defs) {
      if (d.key !== key || d.type !== 'bool') continue;
      d.set(on);
      persistSetting(key, on ? 'on' : 'off');
      return true;
    }
  }
  return false;
}

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
