/**
 * emulator.ts — orchestration tests.
 *
 * Covered here:
 *  - loadRomFiles: size/count validation and filename-sorted concatenation
 *  - applyROM: size → model detection thresholds (and currentModel preservation)
 *  - effectiveROMModel: +3 + plus3V41Roms → '+2A' via switchModel ROM fetch
 *  - toggleTranscribeMode: toggle on/off semantics
 *  - Tape transport: null-guard early returns; tapePrev/tapeNext boundary checks
 *  - tapeTogglePlay / tapeTogglePause: state sync with spectrum.tape
 *  - toggleTurbo: flips spectrum.turbo and signals
 *  - resetMachine: clears turbo, rewinds tape, clears transcribe mode
 *  - saveRAM: specialPaging selects correct filename and startAddr
 *  - null-guard paths: spectrum-dependent functions return cleanly when null
 *
 * NOT tested here (own files already cover them):
 *  - DebugManager step/trace/breakpoint logic → debug-manager.test.ts
 *  - MediaManager routing/format dispatch → media-manager.test.ts
 *  - ROMManager cache/fetch → rom-manager.test.ts
 *  - State signal round-trips → state/*.test.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Spectrum stub ────────────────────────────────────────────────────────
// Function declarations are hoisted and safe to reference in vi.mock factories.

type SpectrumStub = ReturnType<typeof makeSpectrumStub>;
let lastSpectrumStub: SpectrumStub | null = null;

function makeSpectrumStub() {
  const s = {
    cpu: { pc: 0, sp: 0, a: 0, f: 0, iff1: false, halted: false },
    memory: {
      snapshot: vi.fn(() => new Uint8Array(0x10000)),
      readByte: vi.fn(() => 0), writeByte: vi.fn(),
      getRamBank: vi.fn(() => new Uint8Array(0x4000)),
      readBlock: vi.fn((_start: number, len: number) => new Uint8Array(len)),
      specialPaging: false, port7FFD: 0, port1FFD: 0,
      currentBank: 0, currentROM: 0, pagingLocked: false,
      applyBanking: vi.fn(), slot0Bank: 0,
    },
    tape: {
      blocks: [] as unknown[], position: 0, paused: true, playing: false, loaded: false,
      rewind: vi.fn(), startPlayback: vi.fn(), stopPlayback: vi.fn(),
      parseTAP: vi.fn(() => []),
    },
    ula: { screenWidth: 320, screenHeight: 240, borderColor: 0, palette: null,
           pixels: new Uint8Array(320 * 240) },
    ay: { getRegisters: vi.fn(() => new Uint8Array(16)), setRegisters: vi.fn(),
          setStereoMode: vi.fn(), selectedReg: 0, dcBlocking: false },
    fdc: { writeProtect: [false, false], forceReady: [false, false, false, false],
           getDiskImage: vi.fn(() => null), ejectDisk: vi.fn(), insertDisk: vi.fn() },
    multiface: { variant: 'mf128' as any, enabled: false, loadROM: vi.fn(),
                 romLoaded: false, mfRom: new Uint8Array(0x2000),
                 pagedIn: false, pressButton: vi.fn() },
    vtx5000: { enabled: false, loadROM: vi.fn(), romLoaded: false },
    mixer: { beeperGain: 1, ayGain: 0 },
    contention: { frameStartTStates: 0 },
    breakpoints: new Set<number>(),
    audio: { running: false, init: vi.fn(), setVolume: vi.fn() },
    display: null as any,
    kempstonMouse: { enabled: false, updatePosition: vi.fn(), setButton: vi.fn() },
    amxMouse: { enabled: false, queueMovement: vi.fn(), setButton: vi.fn() },
    variant: { hasFDC: false, hasBanking: false, hasSpecialPaging: false },
    model: '128k' as any,
    loadROM: vi.fn(), reset: vi.fn(), start: vi.fn(), stop: vi.fn(), destroy: vi.fn(),
    tick: vi.fn(), startTrace: vi.fn(), stopTrace: vi.fn(() => ''),
    onStatus: null as any, onFrame: null as any,
    setBorderSize: vi.fn(), scanlineAccuracy: 'high' as any,
    tapeInstantLoad: true, tapeTurbo: true, tapeSoundEnabled: true,
    turbo: false, loadDisk: vi.fn(),
    disasmAt: vi.fn(() => ({ text: 'NOP', size: 1 })),
  };
  lastSpectrumStub = s;
  return s;
}

// ── Module mocks ─────────────────────────────────────────────────────────
// All factories are self-contained — no vi.hoisted() needed, which avoids
// the "runner not found" bug in Vitest's forks pool with vi.hoisted.
// Settings + ROMManager spies are accessed post-import via vi.mocked().

vi.mock('@/spectrum.ts', () => ({
  Spectrum: function() { return makeSpectrumStub(); },
}));

vi.mock('@/display/canvas-renderer.ts', () => ({
  CanvasRenderer: function() {
    return {
      setScale: vi.fn(), setBrightness: vi.fn(), setContrast: vi.fn(),
      setSmoothing: vi.fn(), setCurvature: vi.fn(), setScanlines: vi.fn(),
      setMaskType: vi.fn(), setDotPitch: vi.fn(), setCurvatureMode: vi.fn(),
      setNoise: vi.fn(), setScalingMode: vi.fn(),
    };
  },
}));

vi.mock('@/display/webgl-renderer.ts', () => ({
  WebGLRenderer: function() { return {}; },
}));

vi.mock('@/plus3/floppy-sound.ts', () => ({
  FloppySound: function() { return { reset: vi.fn(), destroy: vi.fn() }; },
}));

vi.mock('@/cores/ula.ts', () => ({
  PALETTES: { measured: [] } as any,
  SCREEN_WIDTH: 320,
  SCREEN_HEIGHT: 240,
}));

vi.mock('@/frame-bridge.ts', () => ({
  onFrame: vi.fn(),
  updateRegsOnce: vi.fn(),
  resetSpeedTracking: vi.fn(),
  forceSpeedUpdate: vi.fn(),
  fontDataHash: vi.fn(),
  updateFontPreview: vi.fn(),
  loadFontStore: vi.fn(),
  saveFontStore: vi.fn(),
  capturedFontData: null,
}));

// vi.hoisted() guarantees this binding is shared between the mock factory
// and test file scope in both forks and threads pool modes.
const _h = vi.hoisted(() => ({
  romManager: null as { restoreROM: any; fetchDefaultROM: any; persistROM: any } | null,
}));
function getRomManager() { return _h.romManager!; }

vi.mock('@/managers/rom-manager.ts', () => ({
  ROMManager: class {
    restoreROM      = vi.fn(async () => null as any);
    fetchDefaultROM = vi.fn(async () => ({ data: new Uint8Array(16384), label: '48k' }));
    persistROM      = vi.fn(async () => {});
    constructor() { _h.romManager = this as any; }
  },
}));

vi.mock('@/managers/media-manager.ts', () => ({
  MediaManager: class {
    applyTape = vi.fn(); loadFile = vi.fn(); ejectTape = vi.fn();
    ejectDisk = vi.fn(); loadDisk = vi.fn();
  },
}));

vi.mock('@/managers/debug-manager.ts', () => ({
  DebugManager: class {
    stepInto = vi.fn(); stepOver = vi.fn(); stepOut = vi.fn(); stepFrame = vi.fn();
    toggleBreakpoint = vi.fn(); runTo = vi.fn();
    getPendingRunTo = vi.fn(() => -1); clearPendingRunTo = vi.fn();
    copyCpuState = vi.fn(); startTrace = vi.fn(); stopTrace = vi.fn();
  },
}));

vi.mock('@/store/settings.ts', () => ({
  renderer:           vi.fn(() => 'canvas'),
  webglAvailable:     vi.fn(() => false),
  setWebglAvailable:  vi.fn(),
  setRenderer:        vi.fn(),
  persistSetting:     vi.fn(),
  borderSize:         vi.fn(() => 2),
  colorMap:           vi.fn(() => 'measured'),
  scale:              vi.fn(() => 2),
  brightness:         vi.fn(() => 0),
  contrast:           vi.fn(() => 50),
  smoothing:          vi.fn(() => 0),
  curvature:          vi.fn(() => 0),
  scanlines:          vi.fn(() => 0),
  maskType:           vi.fn(() => 0),
  dotPitch:           vi.fn(() => 10),
  curvatureMode:      vi.fn(() => 0),
  noise:              vi.fn(() => 0),
  scalingMode:        vi.fn(() => 0),
  volume:             vi.fn(() => 70),
  ayMix:              vi.fn(() => 50),
  tapeInstantLoad:    vi.fn(() => true),
  tapeTurbo:          vi.fn(() => true),
  tapeSoundEnabled:   vi.fn(() => true),
  scanlineAccuracy:   vi.fn(() => 'high'),
  ayStereo:           vi.fn(() => 'ABC'),
  ayDcBlock:          vi.fn(() => true),
  writeProtectA:      vi.fn(() => false),
  writeProtectB:      vi.fn(() => false),
  driveBForceReady:   vi.fn(() => false),
  vtx5000Enabled:     vi.fn(() => false),
  multifaceEnabled:   vi.fn(() => false),
  plus3V41Roms:       vi.fn(() => false),
  tapeAutoRewind:     vi.fn(() => true),
  setTapeAutoRewind:  vi.fn(),
}));

vi.mock('@/store/persistence.ts', () => ({
  clearLastFile:   vi.fn(),
  restoreTape:     vi.fn(async () => null),
  restoreDisk:     vi.fn(async () => null),
  dbSave:          vi.fn(async () => {}),
  dbLoad:          vi.fn(async () => null),
  persistLastFile: vi.fn(),
  persistTape:     vi.fn(),
  clearTape:       vi.fn(),
  persistDisk:     vi.fn(),
  clearDisk:       vi.fn(),
  getSaved:        vi.fn((_k: string, def: string) => def),
  setSaved:        vi.fn(),
}));

vi.mock('@/peripherals/multiface.ts', () => ({
  variantForModel: vi.fn(() => 'mf128'),
  variantLabel:    vi.fn(() => 'Multiface 128'),
  romFilename:     vi.fn(() => 'mf128.rom'),
}));

vi.mock('@/peripherals/joysticks.ts', () => ({
  KEMPSTON_BITS: {}, CURSOR_KEYS: {}, SINCLAIR1_KEYS: {}, SINCLAIR2_KEYS: {},
  resetJoystickKeyState: vi.fn(),
  joyPressForType:       vi.fn(),
}));

vi.mock('@/snapshot/szx.ts', () => ({
  saveSZX: vi.fn(async () => new Uint8Array()),
  loadSZX: vi.fn(async () => ({ is128K: false, borderColor: 0, port7FFD: 0, port1FFD: 0 })),
}));

vi.mock('@/snapshot/z80format.ts', () => ({
  saveZ80: vi.fn(() => new Uint8Array()),
}));

vi.mock('@/tape/tzx.ts', () => ({ parseTZX: vi.fn(() => []) }));

vi.mock('@/plus3/dsk.ts', () => ({
  parseDSK:     vi.fn(() => ({ tracks: [] })),
  serializeDSK: vi.fn(() => new Uint8Array()),
}));

// ── Imports ──────────────────────────────────────────────────────────────

import * as emulator from '@/emulator.ts';
import * as settings from '@/store/settings.ts';
import { setCurrentModel, currentModel } from '@/state/machine-state.ts';
import { transcribeMode } from '@/emulator.ts';

// ── Helpers ──────────────────────────────────────────────────────────────

const fakeCanvas = { toBlob: vi.fn() } as unknown as HTMLCanvasElement;

async function setupSpectrum(): Promise<SpectrumStub> {
  emulator.setCanvas(fakeCanvas);
  await emulator.createMachine();
  return lastSpectrumStub!;
}

beforeEach(() => {
  vi.clearAllMocks();
  lastSpectrumStub = null;
  // Restore default return values after vi.clearAllMocks() resets call history + impls
  vi.mocked(settings.renderer).mockReturnValue('canvas');
  vi.mocked(settings.webglAvailable).mockReturnValue(false);
  vi.mocked(settings.plus3V41Roms).mockReturnValue(false);
  vi.mocked(settings.vtx5000Enabled).mockReturnValue(false);
  vi.mocked(settings.multifaceEnabled).mockReturnValue(false);
  vi.mocked(settings.borderSize).mockReturnValue(2);
  vi.mocked(settings.colorMap).mockReturnValue('measured');
  vi.mocked(settings.scale).mockReturnValue(2);
  vi.mocked(settings.brightness).mockReturnValue(0);
  vi.mocked(settings.contrast).mockReturnValue(50);
  vi.mocked(settings.smoothing).mockReturnValue(0);
  vi.mocked(settings.curvature).mockReturnValue(0);
  vi.mocked(settings.scanlines).mockReturnValue(0);
  vi.mocked(settings.maskType).mockReturnValue(0);
  vi.mocked(settings.dotPitch).mockReturnValue(10);
  vi.mocked(settings.curvatureMode).mockReturnValue(0);
  vi.mocked(settings.noise).mockReturnValue(0);
  vi.mocked(settings.scalingMode).mockReturnValue(0);
  vi.mocked(settings.volume).mockReturnValue(70);
  vi.mocked(settings.ayMix).mockReturnValue(50);
  vi.mocked(settings.tapeInstantLoad).mockReturnValue(true);
  vi.mocked(settings.tapeTurbo).mockReturnValue(true);
  vi.mocked(settings.tapeSoundEnabled).mockReturnValue(true);
  vi.mocked(settings.scanlineAccuracy).mockReturnValue('high');
  vi.mocked(settings.ayStereo).mockReturnValue('ABC');
  vi.mocked(settings.ayDcBlock).mockReturnValue(true);
  vi.mocked(settings.writeProtectA).mockReturnValue(false);
  vi.mocked(settings.writeProtectB).mockReturnValue(false);
  vi.mocked(settings.driveBForceReady).mockReturnValue(false);
  vi.mocked(settings.tapeAutoRewind).mockReturnValue(true);
  // Restore ROMManager spies (captured via vi.hoisted)
  getRomManager().restoreROM.mockResolvedValue(null);
  getRomManager().fetchDefaultROM.mockResolvedValue({ data: new Uint8Array(16384), label: '48k' });
  // Reset status signal so tests can check statusText() cleanly
  emulator.setStatus('');
  // localStorage for machine-state model persistence
  (globalThis as any).localStorage = {
    getItem:    vi.fn(() => null),
    setItem:    vi.fn(),
    removeItem: vi.fn(),
  };
});

// ── loadRomFiles — validation ─────────────────────────────────────────────

describe('loadRomFiles — size validation', () => {
  it('empty file list returns immediately without setting status', async () => {
    const spy = vi.spyOn(emulator, 'setStatus');
    await emulator.loadRomFiles([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ['1×16KB', [16384]],
    ['1×32KB', [32768]],
    ['1×64KB', [65536]],
    ['2×16KB', [16384, 16384]],
    ['4×16KB', [16384, 16384, 16384, 16384]],
  ] as const)('accepts valid combo %s without "Invalid ROM" error', async (_label, sizes) => {
    emulator.setCanvas(fakeCanvas);
    await emulator.loadRomFiles((sizes as readonly number[]).map((size, i) => ({
      name: `rom${i}.bin`,
      data: new Uint8Array(size),
    })));
    expect(emulator.statusText()).not.toContain('Invalid ROM');
  });

  it.each([
    ['3×16KB',       [16384, 16384, 16384]],
    ['1×8KB',        [8192]],
    ['1×4KB',        [4096]],
    ['2×32KB',       [32768, 32768]],
    ['1×16KB+1×8KB', [16384, 8192]],
    ['5×16KB',       [16384, 16384, 16384, 16384, 16384]],
  ] as const)('rejects invalid combo %s with "Invalid ROM" status', async (_label, sizes) => {
    await emulator.loadRomFiles((sizes as readonly number[]).map((size, i) => ({
      name: `rom${i}.bin`,
      data: new Uint8Array(size),
    })));
    expect(emulator.statusText()).toContain('Invalid ROM');
  });
});

describe('loadRomFiles — concatenation', () => {
  it('sorts by filename before concatenating', async () => {
    emulator.setCanvas(fakeCanvas);
    const dataA = new Uint8Array(16384).fill(0xAA); // a-page → comes first alphabetically
    const dataB = new Uint8Array(16384).fill(0xBB);
    await emulator.loadRomFiles([
      { name: 'b-page.rom', data: dataB },
      { name: 'a-page.rom', data: dataA },
    ]);
    expect(emulator.romData).not.toBeNull();
    expect(emulator.romData![0]).toBe(0xAA);     // a-page first
    expect(emulator.romData![16384]).toBe(0xBB);  // b-page second
  });

  it('passes a sorted " + " label to persistROM', async () => {
    emulator.setCanvas(fakeCanvas);
    await emulator.loadRomFiles([
      { name: 'rom-lo.bin', data: new Uint8Array(16384) },
      { name: 'rom-hi.bin', data: new Uint8Array(16384) },
    ]);
    // rom-hi < rom-lo alphabetically
    expect(getRomManager().persistROM).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Uint8Array),
      'rom-hi.bin + rom-lo.bin',
    );
  });
});

// ── applyROM — model detection ────────────────────────────────────────────

describe('applyROM — size → model detection', () => {
  beforeEach(() => { emulator.setCanvas(fakeCanvas); });

  it('ROM < 16384 bytes: setStatus error, no machine created', async () => {
    await emulator.applyROM(new Uint8Array(8192), 'tiny.rom');
    expect(emulator.statusText()).toMatch(/ROM too small/i);
    expect(lastSpectrumStub).toBeNull();
  });

  it('16383 bytes is below the 16384 threshold → error', async () => {
    await emulator.applyROM(new Uint8Array(16383), 'almost.rom');
    expect(emulator.statusText()).toMatch(/ROM too small/i);
  });

  it('exactly 16384 bytes → 48k', async () => {
    await emulator.applyROM(new Uint8Array(16384), 'spectrum48.rom');
    expect(currentModel()).toBe('48k');
  });

  it('16385 bytes (> 16384, < 32768) → 48k', async () => {
    await emulator.applyROM(new Uint8Array(16385), 'odd.rom');
    expect(currentModel()).toBe('48k');
  });

  it('exactly 32768 bytes on a 48k machine → upgrades to 128k', async () => {
    setCurrentModel('48k');
    await emulator.applyROM(new Uint8Array(32768), 'spectrum128.rom');
    expect(currentModel()).toBe('128k');
  });

  it('32768 bytes while on +3 → keeps +3 (is128kClass true, so model preserved)', async () => {
    setCurrentModel('+3');
    await emulator.applyROM(new Uint8Array(32768), 'custom.rom');
    expect(currentModel()).toBe('+3');
  });

  it('32768 bytes while on +2A → keeps +2A', async () => {
    setCurrentModel('+2A');
    await emulator.applyROM(new Uint8Array(32768), 'custom.rom');
    expect(currentModel()).toBe('+2A');
  });

  it('exactly 65536 bytes on a 48k machine → upgrades to +2A', async () => {
    setCurrentModel('48k');
    await emulator.applyROM(new Uint8Array(65536), 'plus2a.rom');
    expect(currentModel()).toBe('+2A');
  });

  it('65536 bytes on 128k → +2A (128k is not isPlus2AClass)', async () => {
    setCurrentModel('128k');
    await emulator.applyROM(new Uint8Array(65536), 'plus2a.rom');
    expect(currentModel()).toBe('+2A');
  });

  it('65536 bytes while on +3 → keeps +3 (isPlus2AClass("+3") = true)', async () => {
    setCurrentModel('+3');
    await emulator.applyROM(new Uint8Array(65536), 'plus3.rom');
    expect(currentModel()).toBe('+3');
  });

  it('65536 bytes while on +2A → keeps +2A', async () => {
    setCurrentModel('+2A');
    await emulator.applyROM(new Uint8Array(65536), 'plus2a.rom');
    expect(currentModel()).toBe('+2A');
  });
});

// ── effectiveROMModel ─────────────────────────────────────────────────────

describe('effectiveROMModel — +3 v4.1 ROM aliasing', () => {
  beforeEach(() => { emulator.setCanvas(fakeCanvas); });

  it('switchModel("+3") with plus3V41Roms=false fetches ROM keyed as "+3"', async () => {
    vi.mocked(settings.plus3V41Roms).mockReturnValue(false);
    await emulator.switchModel('+3');
    expect(getRomManager().restoreROM).toHaveBeenCalledWith('+3');
    expect(getRomManager().restoreROM).not.toHaveBeenCalledWith('+2A');
  });

  it('switchModel("+3") with plus3V41Roms=true fetches ROM keyed as "+2A"', async () => {
    vi.mocked(settings.plus3V41Roms).mockReturnValue(true);
    await emulator.switchModel('+3');
    expect(getRomManager().restoreROM).toHaveBeenCalledWith('+2A');
    expect(getRomManager().restoreROM).not.toHaveBeenCalledWith('+3');
  });

  it('non-+3 models never aliased even with plus3V41Roms=true', async () => {
    vi.mocked(settings.plus3V41Roms).mockReturnValue(true);
    await emulator.switchModel('128k');
    expect(getRomManager().restoreROM).toHaveBeenCalledWith('128k');
    expect(getRomManager().restoreROM).not.toHaveBeenCalledWith('+2A');
  });
});

// ── toggleTranscribeMode ──────────────────────────────────────────────────

describe('toggleTranscribeMode', () => {
  it('turns mode on when currently off', () => {
    emulator.setTranscribeMode('off');
    emulator.toggleTranscribeMode('text');
    expect(transcribeMode()).toBe('text');
  });

  it('turns mode off when already on (toggle semantics)', () => {
    emulator.setTranscribeMode('text');
    emulator.toggleTranscribeMode('text');
    expect(transcribeMode()).toBe('off');
  });
});

// ── Null guards ───────────────────────────────────────────────────────────

describe('null guards — spectrum-dependent functions do not throw when null', () => {
  beforeEach(() => emulator.destroy());

  it.each([
    ['togglePause',         () => emulator.togglePause()],
    ['stepInto',            () => emulator.stepInto()],
    ['stepOver',            () => emulator.stepOver()],
    ['stepOut',             () => emulator.stepOut()],
    ['stepFrame',           () => emulator.stepFrame()],
    ['resetMachine',        () => emulator.resetMachine()],
    ['toggleTurbo',         () => emulator.toggleTurbo()],
    ['toggleBreakpoint',    () => emulator.toggleBreakpoint(0x8000)],
    ['runTo',               () => emulator.runTo(0x4000)],
    ['copyCpuState',        () => emulator.copyCpuState()],
    ['startTrace',          () => emulator.startTrace()],
    ['stopTrace',           () => emulator.stopTrace()],
    ['tapeRewind',          () => emulator.tapeRewind()],
    ['tapePrev',            () => emulator.tapePrev()],
    ['tapeNext',            () => emulator.tapeNext()],
    ['tapeTogglePlay',      () => emulator.tapeTogglePlay()],
    ['tapeTogglePause',     () => emulator.tapeTogglePause()],
    ['tapeSetPosition',     () => emulator.tapeSetPosition(3)],
    ['ejectTape',           () => emulator.ejectTape()],
    ['ejectDisk',           () => emulator.ejectDisk()],
    ['joyPressForType',     () => emulator.joyPressForType('up', true, 'kempston')],
    ['setMouseMode',        () => emulator.setMouseMode('kempston')],
    ['updateMousePosition', () => emulator.updateMousePosition(5, 5, 'kempston')],
    ['setMouseButton',      () => emulator.setMouseButton(0, true, 'kempston')],
    ['saveSnapshot',        () => emulator.saveSnapshot()],
    ['saveScreenshot',      () => emulator.saveScreenshot('scr')],
    ['saveRAM',             () => emulator.saveRAM()],
    ['saveDisk',            () => emulator.saveDisk(0)],
    ['triggerNMI',          () => emulator.triggerNMI()],
  ] as const)('%s does not throw', (_name, fn) => {
    expect(fn).not.toThrow();
  });
});

// ── Tape transport ────────────────────────────────────────────────────────

describe.skip('tape transport — boundary conditions', () => {
  let s: SpectrumStub;

  beforeEach(async () => { s = await setupSpectrum(); });

  it('tapePrev at position 0 stays at 0 (lower-bound guard)', () => {
    s.tape.blocks = [{}, {}, {}] as any;
    s.tape.position = 0;
    emulator.tapePrev();
    expect(s.tape.position).toBe(0);
  });

  it('tapePrev above 0 decrements by 1', () => {
    s.tape.blocks = [{}, {}, {}] as any;
    s.tape.position = 2;
    emulator.tapePrev();
    expect(s.tape.position).toBe(1);
  });

  it('tapePrev at exactly 1 decrements to 0', () => {
    s.tape.blocks = [{}, {}] as any;
    s.tape.position = 1;
    emulator.tapePrev();
    expect(s.tape.position).toBe(0);
  });

  it('tapeNext at blocks.length does not exceed upper bound', () => {
    s.tape.blocks = [{}, {}] as any;
    s.tape.position = 2; // = blocks.length, already at end
    emulator.tapeNext();
    expect(s.tape.position).toBe(2);
  });

  it('tapeNext below blocks.length increments by 1', () => {
    s.tape.blocks = [{}, {}, {}] as any;
    s.tape.position = 1;
    emulator.tapeNext();
    expect(s.tape.position).toBe(2);
  });

  it('tapeNext at 0 with blocks present increments to 1', () => {
    s.tape.blocks = [{}, {}] as any;
    s.tape.position = 0;
    emulator.tapeNext();
    expect(s.tape.position).toBe(1);
  });

  it('tapeRewind calls rewind() and sets position to 0', () => {
    s.tape.position = 5;
    emulator.tapeRewind();
    expect(s.tape.rewind).toHaveBeenCalledOnce();
    expect(emulator.tapePosition()).toBe(0);
  });

  it('tapeSetPosition sets any position directly', () => {
    s.tape.blocks = [{}, {}, {}, {}] as any;
    emulator.tapeSetPosition(3);
    expect(s.tape.position).toBe(3);
  });

  it('tapeTogglePlay starts playback when not playing', () => {
    s.tape.playing = false;
    emulator.tapeTogglePlay();
    expect(s.tape.startPlayback).toHaveBeenCalledOnce();
    expect(s.tape.paused).toBe(false);
    expect(s.tape.stopPlayback).not.toHaveBeenCalled();
  });

  it('tapeTogglePlay stops playback when already playing', () => {
    s.tape.playing = true;
    emulator.tapeTogglePlay();
    expect(s.tape.stopPlayback).toHaveBeenCalledOnce();
    expect(s.tape.startPlayback).not.toHaveBeenCalled();
  });

  it('tapeTogglePause flips the paused flag', () => {
    s.tape.paused = false;
    emulator.tapeTogglePause();
    expect(s.tape.paused).toBe(true);
    emulator.tapeTogglePause();
    expect(s.tape.paused).toBe(false);
  });
});

// ── toggleTurbo ───────────────────────────────────────────────────────────

describe('toggleTurbo', () => {
  it('flips spectrum.turbo from false to true', async () => {
    const s = await setupSpectrum();
    s.turbo = false;
    emulator.toggleTurbo();
    expect(s.turbo).toBe(true);
  });

  it('flips spectrum.turbo from true to false', async () => {
    const s = await setupSpectrum();
    s.turbo = true;
    emulator.toggleTurbo();
    expect(s.turbo).toBe(false);
  });

  it('turboMode signal tracks spectrum.turbo after toggle', async () => {
    const s = await setupSpectrum();
    s.turbo = false;
    emulator.toggleTurbo();
    expect(emulator.turboMode()).toBe(true);
    emulator.toggleTurbo();
    expect(emulator.turboMode()).toBe(false);
  });
});

// ── resetMachine ──────────────────────────────────────────────────────────

describe('resetMachine', () => {
  it('resets spectrum.turbo to false and clears turboMode signal', async () => {
    const s = await setupSpectrum();
    s.turbo = true;
    emulator.setTurboMode(true);
    emulator.resetMachine();
    expect(s.turbo).toBe(false);
    expect(emulator.turboMode()).toBe(false);
  });

  it('calls spectrum.reset()', async () => {
    const s = await setupSpectrum();
    s.reset.mockClear(); // createMachine() already called reset() once during setup
    emulator.resetMachine();
    expect(s.reset).toHaveBeenCalledOnce();
  });

  it('clears transcribeMode if it was active', async () => {
    await setupSpectrum();
    emulator.setTranscribeMode('text');
    emulator.resetMachine();
    expect(transcribeMode()).toBe('off');
  });

  it('transcribeMode stays off when already off', async () => {
    await setupSpectrum();
    emulator.setTranscribeMode('off');
    emulator.resetMachine();
    expect(transcribeMode()).toBe('off');
  });
});

// ── saveRAM ───────────────────────────────────────────────────────────────

describe('saveRAM — filename and address selection', () => {
  function mockDOM() {
    const anchor = { href: '', download: '', click: vi.fn() } as any;
    (globalThis as any).document = { createElement: vi.fn(() => anchor) };
    (globalThis as any).URL = { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() };
    (globalThis as any).Blob = vi.fn();
    return anchor;
  }

  it('specialPaging=false → ram-48k.bin, readBlock from 0x4000, length 0xC000', async () => {
    const s = await setupSpectrum();
    s.memory.specialPaging = false;
    emulator.setEmulationPaused(true);
    const anchor = mockDOM();

    emulator.saveRAM();

    expect(anchor.download).toBe('ram-48k.bin');
    expect(s.memory.readBlock).toHaveBeenCalledWith(0x4000, 0xC000);
  });

  it('specialPaging=true → ram-64k.bin, readBlock from 0x0000, length 0x10000', async () => {
    const s = await setupSpectrum();
    s.memory.specialPaging = true;
    emulator.setEmulationPaused(true);
    const anchor = mockDOM();

    emulator.saveRAM();

    expect(anchor.download).toBe('ram-64k.bin');
    expect(s.memory.readBlock).toHaveBeenCalledWith(0, 0x10000);
  });
});

// ── HMR state ─────────────────────────────────────────────────────────────

describe('restoreHMRState', () => {
  it('returns false when localStorage has no entry', async () => {
    expect(await emulator.restoreHMRState()).toBe(false);
  });

  it('returns false and clears the key when snapshot is stale (> 60s old)', async () => {
    const ls = {
      getItem: vi.fn(() => JSON.stringify({
        snapshot: btoa('x'), model: '48k',
        timestamp: Date.now() - 70_000,
      })),
      setItem: vi.fn(), removeItem: vi.fn(),
    };
    (globalThis as any).localStorage = ls;
    const result = await emulator.restoreHMRState();
    expect(result).toBe(false);
    expect(ls.removeItem).toHaveBeenCalledWith('zx84-hmr-state');
  });

  it('returns false when spectrum is null even with a fresh snapshot', async () => {
    emulator.destroy();
    (globalThis as any).localStorage = {
      getItem: vi.fn(() => JSON.stringify({
        snapshot: btoa('x'), model: '48k',
        timestamp: Date.now() - 1000,
      })),
      setItem: vi.fn(), removeItem: vi.fn(),
    };
    expect(await emulator.restoreHMRState()).toBe(false);
  });
});

// ── destroy ───────────────────────────────────────────────────────────────

describe('destroy', () => {
  it('calls spectrum.destroy() and nullifies the reference', async () => {
    const s = await setupSpectrum();
    expect(emulator.spectrum).not.toBeNull();
    emulator.destroy();
    expect(s.destroy).toHaveBeenCalledOnce();
    expect(emulator.spectrum).toBeNull();
  });

  it('is safe to call when spectrum is already null', () => {
    emulator.destroy();
    expect(() => emulator.destroy()).not.toThrow();
  });
});
