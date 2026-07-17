import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/spectrum.ts', () => ({ Spectrum: function() { return { cpu: {}, memory: { snapshot: vi.fn(() => new Uint8Array()), readByte: vi.fn(() => 0), writeByte: vi.fn(), getRamBank: vi.fn(() => new Uint8Array()), readBlock: vi.fn((_s: number, l: number) => new Uint8Array(l)), specialPaging: false, port7FFD: 0, port1FFD: 0, currentBank: 0, currentROM: 0, pagingLocked: false, applyBanking: vi.fn(), slot0Bank: 0 }, tape: { blocks: [], position: 0, paused: true, playing: false, loaded: false, rewind: vi.fn(), startPlayback: vi.fn(), stopPlayback: vi.fn(), parseTAP: vi.fn(() => []) }, ula: { screenWidth: 320, screenHeight: 240, borderColor: 0, palette: null, pixels: new Uint8Array(320*240) }, ay: { getRegisters: vi.fn(() => new Uint8Array(16)), setRegisters: vi.fn(), setStereoMode: vi.fn(), selectedReg: 0, dcBlocking: false }, fdc: { writeProtect: [false,false], forceReady: [false,false,false,false], getDiskImage: vi.fn(() => null), ejectDisk: vi.fn(), insertDisk: vi.fn() }, multiface: { variant: 'mf128', enabled: false, loadROM: vi.fn(), romLoaded: false, mfRom: new Uint8Array(0x2000), pagedIn: false, pressButton: vi.fn() }, vtx5000: { enabled: false, loadROM: vi.fn(), romLoaded: false }, mixer: { beeperGain: 1, ayGain: 0 }, contention: { frameStartTStates: 0 }, breakpoints: new Set(), audio: { running: false, init: vi.fn(), setVolume: vi.fn() }, display: null, kempstonMouse: { enabled: false, updatePosition: vi.fn(), setButton: vi.fn() }, amxMouse: { enabled: false, queueMovement: vi.fn(), setButton: vi.fn() }, variant: { hasFDC: false, hasBanking: false, hasSpecialPaging: false }, model: '128k', loadROM: vi.fn(), reset: vi.fn(), start: vi.fn(), stop: vi.fn(), destroy: vi.fn(), tick: vi.fn(), startTrace: vi.fn(), stopTrace: vi.fn(() => ''), onStatus: null, onFrame: null, setBorderSize: vi.fn(), scanlineAccuracy: 'high', tapeFastRom: true, tapeTurbo: true, tapeSoundEnabled: true, turbo: false, loadDisk: vi.fn(), disasmAt: vi.fn(() => ({ text: 'NOP', size: 1 })) }; } }));
vi.mock('@/display/canvas-renderer.ts', () => ({ CanvasRenderer: function() { return { setScale: vi.fn(), setBrightness: vi.fn(), setContrast: vi.fn(), setSaturation: vi.fn(), setGamma: vi.fn(), setSmoothing: vi.fn(), setCurvature: vi.fn(), setScanlines: vi.fn(), setMaskType: vi.fn(), setDotPitch: vi.fn(), setCurvatureMode: vi.fn(), setNoise: vi.fn(), setScalingMode: vi.fn() }; } }));
vi.mock('@/display/webgl-renderer.ts', () => ({ WebGLRenderer: function() { return {}; } }));
vi.mock('@/floppy/floppy-sound.ts', () => ({ FloppySound: function() { return { reset: vi.fn(), destroy: vi.fn() }; } }));
vi.mock('@/cores/ula.ts', () => ({ PALETTES: { measured: [] }, SCREEN_WIDTH: 320, SCREEN_HEIGHT: 240 }));
vi.mock('@/frame-bridge.ts', () => ({ onFrame: vi.fn(), updateRegsOnce: vi.fn(), resetSpeedTracking: vi.fn(), forceSpeedUpdate: vi.fn(), fontDataHash: vi.fn(), updateFontPreview: vi.fn(), loadFontStore: vi.fn(), saveFontStore: vi.fn(), capturedFontData: null }));
vi.mock('@/managers/rom-manager.ts', () => ({ ROMManager: class { restoreROM = vi.fn(async () => null); fetchDefaultROM = vi.fn(async () => ({ data: new Uint8Array(16384), label: '48k' })); persistROM = vi.fn(); } }));
vi.mock('@/managers/media-manager.ts', () => ({ MediaManager: class { applyTape = vi.fn(); loadFile = vi.fn(); ejectTape = vi.fn(); ejectDisk = vi.fn(); loadDisk = vi.fn(); } }));
vi.mock('@/managers/debug-manager.ts', () => ({ DebugManager: class { stepInto = vi.fn(); stepOver = vi.fn(); stepOut = vi.fn(); stepFrame = vi.fn(); toggleBreakpoint = vi.fn(); runTo = vi.fn(); getPendingRunTo = vi.fn(() => -1); clearPendingRunTo = vi.fn(); copyCpuState = vi.fn(); startTrace = vi.fn(); stopTrace = vi.fn(); } }));
vi.mock('@/store/settings.ts', () => ({ renderer: vi.fn(() => 'canvas'), webglAvailable: vi.fn(() => false), setWebglAvailable: vi.fn(), setRenderer: vi.fn(), persistSetting: vi.fn(), borderSize: vi.fn(() => 2), colorMap: vi.fn(() => 'measured'), scale: vi.fn(() => 2), brightness: vi.fn(() => 0), contrast: vi.fn(() => 50), saturation: vi.fn(() => 50), gamma: vi.fn(() => 0), smoothing: vi.fn(() => 0), curvature: vi.fn(() => 0), scanlines: vi.fn(() => 0), maskType: vi.fn(() => 0), dotPitch: vi.fn(() => 10), curvatureMode: vi.fn(() => 0), noise: vi.fn(() => 0), scalingMode: vi.fn(() => 0), volume: vi.fn(() => 70), ayMix: vi.fn(() => 50), tapeFastRom: vi.fn(() => true), tapeTurbo: vi.fn(() => true), tapeSoundEnabled: vi.fn(() => true), scanlineAccuracy: vi.fn(() => 'high'), ayStereo: vi.fn(() => 'ABC'), ayDcBlock: vi.fn(() => true), writeProtectA: vi.fn(() => false), writeProtectB: vi.fn(() => false), driveBForceReady: vi.fn(() => false), vtx5000Enabled: vi.fn(() => false), multifaceEnabled: vi.fn(() => false), plus3V41Roms: vi.fn(() => false), tapeAutoRewind: vi.fn(() => true), setTapeAutoRewind: vi.fn() }));
vi.mock('@/store/persistence.ts', () => ({ clearLastFile: vi.fn(), restoreTape: vi.fn(async () => null), restoreDisk: vi.fn(async () => null), dbSave: vi.fn(async () => {}), dbLoad: vi.fn(async () => null), persistLastFile: vi.fn(), persistTape: vi.fn(), clearTape: vi.fn(), persistDisk: vi.fn(), clearDisk: vi.fn(), getSaved: vi.fn((_k: string, def: string) => def), setSaved: vi.fn() }));
vi.mock('@/peripherals/multiface.ts', () => ({ variantForModel: vi.fn(() => 'mf128'), variantLabel: vi.fn(() => 'Multiface 128'), romFilename: vi.fn(() => 'mf128.rom') }));
vi.mock('@/peripherals/joysticks.ts', () => ({ KEMPSTON_BITS: {}, CURSOR_KEYS: {}, SINCLAIR1_KEYS: {}, SINCLAIR2_KEYS: {}, resetJoystickKeyState: vi.fn(), joyPressForType: vi.fn() }));
vi.mock('@/snapshot/szx.ts', () => ({ saveSZX: vi.fn(async () => new Uint8Array()), loadSZX: vi.fn(async () => ({ is128K: false, borderColor: 0, port7FFD: 0, port1FFD: 0 })) }));
vi.mock('@/snapshot/z80format.ts', () => ({ saveZ80: vi.fn(() => new Uint8Array()) }));
vi.mock('@/tape/tzx.ts', () => ({ parseTZX: vi.fn(() => []) }));
vi.mock('@/floppy/dsk.ts', () => ({ parseDSK: vi.fn(() => ({ tracks: [] })), serializeDSK: vi.fn(() => new Uint8Array()) }));

import * as emulator from '@/emulator.ts';

beforeEach(() => {
  (globalThis as any).localStorage = { getItem: vi.fn(() => null), setItem: vi.fn(), removeItem: vi.fn() };
});

describe('smoke', () => {
  it('imports without error', () => {
    expect(emulator).toBeDefined();
  });
  it('loadRomFiles empty is noop', async () => {
    await expect(emulator.loadRomFiles([])).resolves.toBeUndefined();
  });
});
