/**
 * Tests for frame-bridge.ts.
 *
 * Scope notes:
 *  - frame-bridge.ts imports ~30 named exports from @/emulator.ts plus three
 *    settings modules. We mock @/emulator.ts and @/store/settings.ts via
 *    vi.mock so the bridge can be exercised in isolation.
 *  - `spectrum` is a mutable export (export let …); ES module live bindings
 *    let us swap the underlying fake by mutating the mock object.
 *  - `onFrame` is 150 lines that touches 30+ collaborators. We test the
 *    subset whose contract is independently expressible (early-out when no
 *    spectrum, breakpoint handling, trace auto-stop). The rest is left to
 *    integration testing — flagged in critique below.
 *
 * Outstanding smells documented but NOT asserted as correct:
 *  - setLedText is OR'd with `a.earReads > 0`, mixing transcribe mode with
 *    tape-EAR activity on the same LED signal. Probably a bug.
 *  - forceSpeedUpdate() docs "force immediate MHz update on next frame", but
 *    it sets speedFrameCount=0 so the next sample is 50 frames (~1s) away.
 *  - onFrame trace auto-stop calls navigator.clipboard.writeText fire-and-
 *    forget, same pattern fixed in DebugManager.copyCpuState.
 *  - `setLedAy(a.ayWrites > 5)` and `setLedRainbow(a.attrWrites > 768)`
 *    embed magic thresholds without comments.
 *  - smoothedMhz === 0 used as "uninitialized" sentinel; a real 0 reading
 *    would re-seed the EMA.
 *  - cachedExtraFonts is captured when transcribe mode toggles on and never
 *    invalidated when the user edits the font store mid-session.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mock @/emulator.ts (must be defined BEFORE importing frame-bridge) ────

type MockSpectrum = {
  memory: { snapshot: () => Uint8Array };
  cpu: { tStates: number; pc: number };
  variant: { hasBanking: boolean; hasFDC: boolean; hasAY: boolean };
  fdc: { currentUnit: number };
  mgtPlusD: { enabled: boolean };
  breakpointHit: number;
  breakpoints: Set<number>;
  stop: ReturnType<typeof vi.fn>;
  stopTrace: ReturnType<typeof vi.fn>;
  tracing: boolean;
  turbo: boolean;
  tapeTurboActive: boolean;
  tape: { loaded: boolean; position: number; playing: boolean; paused: boolean; finished: boolean; startPlayback: () => void; cpuClock: number };
  activity: Record<string, number | boolean>;
  screenText: { active: boolean; activate: () => void; deactivate: () => void };
  loaderDetector: { signature: string };
  ocrScreenStyled: ReturnType<typeof vi.fn>;
} | null;

const { emu, settingsMock, panesMock } = vi.hoisted(() => ({
  emu: {
    spectrum: null as any,
    // On a Spectrum the active machine IS the spectrum; the bridge now reads
    // `machine` for the (machine-agnostic) clock-speed readout, so mirror it.
    get machine() { return this.spectrum; },
    floppySound: null as any,
    currentModel: vi.fn(() => '48k' as const),
    emulationPaused: vi.fn(() => false),
    tracing: vi.fn(() => false),
    tapePaused: vi.fn(() => false),
    tapePlaying: vi.fn(() => false),
    transcribeMode: vi.fn(() => 'off' as const),
    getPendingRunTo: vi.fn(() => -1),
    clearPendingRunTo: vi.fn(),
    // Setters — every one is a vi.fn so call-counts are observable.
    setRegsRev: vi.fn(),
    setSysvarRev: vi.fn(),
    setBasicHtml: vi.fn(),
    setBasicVarsHtml: vi.fn(),
    setBanksHtml: vi.fn(),
    setDriveAStatus: vi.fn(),
    setDriveBStatus: vi.fn(),
    setShowTrapLog: vi.fn(),
    setDisasmText: vi.fn(),
    setCurrentDiskInfo: vi.fn(),
    setCurrentDiskInfoB: vi.fn(),
    setDriveCStatus: vi.fn(),
    setDriveDStatus: vi.fn(),
    setCurrentDiskInfoC: vi.fn(),
    setCurrentDiskInfoD: vi.fn(),
    setClockSpeedText: vi.fn(),
    setTapePosition: vi.fn(),
    setTapePaused: vi.fn(),
    setTapePlaying: vi.fn(),
    setTranscribeText: vi.fn(),
    setTranscribeHtml: vi.fn(),
    setTranscribeGrid: vi.fn(),
    setLedKbd: vi.fn(),
    setLedKemp: vi.fn(),
    setLedEar: vi.fn(),
    setLedLoad: vi.fn(),
    setLedText: vi.fn(),
    setLedBeep: vi.fn(),
    setLedAy: vi.fn(),
    setLedDsk: vi.fn(),
    setLedRainbow: vi.fn(),
    setLedMouse: vi.fn(),
    setLedTapeTurbo: vi.fn(),
    setStatus: vi.fn(),
    setEmulationPaused: vi.fn(),
    setTracing: vi.fn(),
  },
  settingsMock: {
    fontName: vi.fn(() => ''),
    tapeAutoRewind: vi.fn(() => false),
    diskSoundA: vi.fn(() => false),
    diskSoundB: vi.fn(() => false),
    diskSoundC: vi.fn(() => false),
    diskSoundD: vi.fn(() => false),
  },
  panesMock: {
    isCollapsed: vi.fn((_id: string) => true),
  },
}));

vi.mock('@/emulator.ts', () => emu);
vi.mock('@/store/settings.ts', () => settingsMock);

// Mock @/ui/panes.ts so isCollapsed is deterministic.
vi.mock('@/ui/panes.ts', () => panesMock);

// Mock dsk.ts since refreshDiskMetadata is called only when an FDC format
// completes — we don't exercise that path here.
vi.mock('@/plus3/dsk.ts', () => ({ refreshDiskMetadata: vi.fn() }));

// Mock z80-disasm + basic-parser since they're only called from updateRegsOnce
// + the onFrame breakpoint path; not part of the lock-in tests below.
vi.mock('@/debug/z80-disasm.ts', () => ({
  disassembleAroundPC: vi.fn(() => []),
  formatDisasmHtml: vi.fn(() => ''),
}));
vi.mock('@/debug/basic-parser.ts', () => ({
  parseBasicProgram: vi.fn(() => ''),
  parseBasicVariables: vi.fn(() => ''),
}));

// localStorage fake (Node has no DOM).
class FakeLS {
  store = new Map<string, string>();
  throwOnSet = false;
  throwOnGet = false;
  getItem(k: string) {
    if (this.throwOnGet) throw new DOMException('blocked');
    return this.store.has(k) ? this.store.get(k)! : null;
  }
  setItem(k: string, v: string) {
    if (this.throwOnSet) throw new DOMException('quota', 'QuotaExceededError');
    this.store.set(k, v);
  }
  clear() { this.store.clear(); }
}

let fakeLS: FakeLS;
beforeEach(() => {
  fakeLS = new FakeLS();
  (globalThis as any).localStorage = fakeLS;
  resetLedActivity();   // clear the 500ms LED hold between tests (module state)
  emu.spectrum = null;
  emu.floppySound = null;
  settingsMock.fontName.mockReturnValue('');
  for (const fn of Object.values(emu)) {
    if (typeof fn === 'function' && 'mockClear' in fn) (fn as any).mockClear();
  }
});

// Imports under test — AFTER all vi.mock calls.
import {
  fontDataHash,
  loadFontStore,
  saveFontStore,
  updateFontPreview,
  capturedFontData as _capturedFontData,
  resetSpeedTracking,
  resetLedActivity,
  forceSpeedUpdate,
  updateRegsOnce,
  onFrame,
} from '@/frame-bridge.ts';
import type { FontEntry } from '@/frame-bridge.ts';

// ── fontDataHash ─────────────────────────────────────────────────────────

describe('fontDataHash', () => {
  it('is stable across calls for identical input', () => {
    const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(fontDataHash(buf, 0, 8)).toBe(fontDataHash(buf, 0, 8));
  });

  it('responds to any byte change within the window', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 9]); // last byte differs
    expect(fontDataHash(a, 0, 8)).not.toBe(fontDataHash(b, 0, 8));
  });

  it('honours offset and length (windowed hash)', () => {
    // [9,9,1,2,3,9,9] hashed @ offset=2 len=3 ≡ [1,2,3] @ offset=0 len=3
    const a = new Uint8Array([9, 9, 1, 2, 3, 9, 9]);
    const b = new Uint8Array([1, 2, 3]);
    expect(fontDataHash(a, 2, 3)).toBe(fontDataHash(b, 0, 3));
  });

  it('a zero-length window collapses to 0 (the seed)', () => {
    expect(fontDataHash(new Uint8Array([1, 2, 3]), 0, 0)).toBe(0);
  });
});

// ── saveFontStore / loadFontStore ─────────────────────────────────────────

describe('saveFontStore / loadFontStore', () => {
  const entry = (id: string): FontEntry => ({
    id, label: id, address: null, technique: 'file', data: btoa('xx'),
  });

  it('round-trips a font store through localStorage', () => {
    saveFontStore([entry('A'), entry('B')]);
    const back = loadFontStore();
    expect(back.map(e => e.id)).toEqual(['A', 'B']);
  });

  it('returns [] when localStorage has no entry', () => {
    expect(loadFontStore()).toEqual([]);
  });

  it('returns [] when stored JSON is malformed', () => {
    fakeLS.store.set('zx84-fonts', '{not valid json');
    expect(loadFontStore()).toEqual([]);
  });

  it('migrates the legacy Record<string, string> format into FontEntry[]', () => {
    fakeLS.store.set('zx84-fonts', JSON.stringify({ Old1: 'YWE=', Old2: 'YmI=' }));
    const got = loadFontStore();
    expect(got.length).toBe(2);
    expect(got[0]!.id).toBe('Old1');
    expect(got[0]!.label).toBe('Old1');
    expect(got[0]!.technique).toBe('file');
    expect(got[0]!.address).toBeNull();
    // Migration persists the new format — reading again returns an array,
    // not the legacy object.
    const stored = JSON.parse(fakeLS.store.get('zx84-fonts')!);
    expect(Array.isArray(stored)).toBe(true);
  });

  it('saveFontStore swallows localStorage failures (private mode / quota)', () => {
    fakeLS.throwOnSet = true;
    expect(() => saveFontStore([entry('A')])).not.toThrow();
  });

  it('loadFontStore returns [] when localStorage.getItem throws', () => {
    fakeLS.throwOnGet = true;
    expect(loadFontStore()).toEqual([]);
  });
});

// ── updateFontPreview ─────────────────────────────────────────────────────

function makeSpectrumWithSnap(snap: Uint8Array): MockSpectrum {
  return {
    memory: { snapshot: () => snap },
    cpu: { tStates: 0, pc: 0 },
    variant: { hasBanking: false, hasFDC: false, hasAY: false },
    fdc: { currentUnit: 0 },
    mgtPlusD: { enabled: false },
    breakpointHit: -1,
    breakpoints: new Set(),
    stop: vi.fn(),
    stopTrace: vi.fn(() => ''),
    tracing: false,
    turbo: false,
    tapeTurboActive: false,
    tape: { loaded: false, position: 0, playing: false, paused: false, finished: false, startPlayback: vi.fn(), cpuClock: 3_546_900 },
    activity: {},
    screenText: { active: false, activate: vi.fn(), deactivate: vi.fn() },
    loaderDetector: { signature: 'unknown' },
    ocrScreenStyled: vi.fn(() => ({ text: '', html: '', grid: [], mask: [] as number[] })),
  };
}

describe('updateFontPreview', () => {
  it('returns the custom font when a fontName is selected', () => {
    const fontBytes = new Uint8Array(8).fill(0xAA);
    const b64 = btoa(String.fromCharCode(...fontBytes));
    fakeLS.store.set('zx84-fonts', JSON.stringify([
      { id: 'MYFONT', label: 'MYFONT', address: null, technique: 'file', data: b64 },
    ]));
    settingsMock.fontName.mockReturnValue('MYFONT');
    const got = updateFontPreview();
    expect(got?.type).toBe('custom');
    expect(Array.from(got!.data)).toEqual(Array.from(fontBytes));
  });

  it('returns null if the selected font id is not in the store', () => {
    settingsMock.fontName.mockReturnValue('NOPE');
    fakeLS.store.set('zx84-fonts', JSON.stringify([]));
    expect(updateFontPreview()).toBeNull();
  });

  it('returns null when no spectrum is attached (ROM path)', () => {
    emu.spectrum = null;
    expect(updateFontPreview()).toBeNull();
  });

  it('detects the ROM font at the standard CHARS=0x3C00 default', () => {
    const snap = new Uint8Array(0x10000);
    // sys var CHARS at 5C36 = 0 → uses default 0x3C00.
    snap[0x5C36] = 0; snap[0x5C37] = 0;
    // The "space" character (first 8 bytes after CHARS+256 = 0x3D00) must be all-zero.
    // Beyond, populate with a recognisable pattern to verify it's captured.
    for (let i = 0x3D00 + 8; i < 0x3D00 + 768; i++) snap[i] = (i & 0xFF);
    emu.spectrum = makeSpectrumWithSnap(snap);
    const got = updateFontPreview();
    expect(got?.type).toBe('rom');
    expect(got!.data.length).toBe(768);
    // First 8 bytes are the blank space char.
    for (let i = 0; i < 8; i++) expect(got!.data[i]).toBe(0);
  });

  it('returns null when the space character is non-blank (heuristic guard)', () => {
    const snap = new Uint8Array(0x10000);
    snap[0x5C36] = 0; snap[0x5C37] = 0;
    snap[0x3D00] = 0x01; // space char first byte not zero
    emu.spectrum = makeSpectrumWithSnap(snap);
    expect(updateFontPreview()).toBeNull();
  });

  it('returns null when the CHARS pointer would overflow the 64KB window', () => {
    const snap = new Uint8Array(0x10000);
    // CHARS = 0xFD00 → fontStart = 0xFD00 + 256 = 0xFE00; +768 = 0x10100 > 64K.
    snap[0x5C36] = 0x00; snap[0x5C37] = 0xFD;
    emu.spectrum = makeSpectrumWithSnap(snap);
    expect(updateFontPreview()).toBeNull();
  });

  it('caches by (fontStart, hash) — repeated identical snapshots return null', () => {
    const snap = new Uint8Array(0x10000);
    snap[0x5C36] = 0; snap[0x5C37] = 0;
    // Use a distinct byte pattern from earlier tests so the module-level
    // hash cache doesn't already match an earlier capture.
    for (let i = 0x3D00 + 8; i < 0x3D00 + 768; i++) snap[i] = (i ^ 0x5A) & 0xFF;
    emu.spectrum = makeSpectrumWithSnap(snap);

    const first = updateFontPreview();
    expect(first?.type).toBe('rom');
    // Second call with identical bytes → cache hit → null.
    expect(updateFontPreview()).toBeNull();

    // Mutating a byte invalidates the cache.
    snap[0x3D00 + 100] ^= 0xFF;
    const third = updateFontPreview();
    expect(third?.type).toBe('rom');
  });

  it('switching to a custom font invalidates the ROM-font cache', () => {
    const snap = new Uint8Array(0x10000);
    snap[0x5C36] = 0; snap[0x5C37] = 0;
    for (let i = 0x3D00 + 8; i < 0x3D00 + 768; i++) snap[i] = i & 0xFF;
    emu.spectrum = makeSpectrumWithSnap(snap);
    updateFontPreview(); // primes ROM cache

    // Now select a custom font, then switch back to ROM.
    const custom = new Uint8Array(8).fill(0x55);
    fakeLS.store.set('zx84-fonts', JSON.stringify([
      { id: 'X', label: 'X', address: null, technique: 'file', data: btoa(String.fromCharCode(...custom)) },
    ]));
    settingsMock.fontName.mockReturnValue('X');
    expect(updateFontPreview()?.type).toBe('custom');

    settingsMock.fontName.mockReturnValue('');
    // ROM cache was invalidated by the custom switch → expect a non-null return.
    expect(updateFontPreview()?.type).toBe('rom');
  });
});

// ── resetSpeedTracking / forceSpeedUpdate ────────────────────────────────

describe('resetSpeedTracking / forceSpeedUpdate', () => {
  it('resetSpeedTracking paints the nominal clock immediately', () => {
    const snap = new Uint8Array(0x10000);
    const s = makeSpectrumWithSnap(snap)!;
    s.tape.cpuClock = 3_546_900;   // 128K
    emu.spectrum = s;
    resetSpeedTracking();
    // 3.5469 MHz truncated to 2dp → "3.54" (the UI appends the "MHz" unit).
    expect(emu.setClockSpeedText).toHaveBeenCalledWith('3.54');
  });

  it('forceSpeedUpdate does NOT immediately set the clock-speed signal', () => {
    // It only arms a repaint for the next frame; nothing is emitted yet.
    forceSpeedUpdate();
    expect(emu.setClockSpeedText).not.toHaveBeenCalled();
  });
});

// ── updateRegsOnce / onFrame: early-out + breakpoint paths ────────────────

describe('updateRegsOnce', () => {
  it('is a no-op when no spectrum is attached', () => {
    emu.spectrum = null;
    expect(() => updateRegsOnce()).not.toThrow();
    expect(emu.setRegsRev).not.toHaveBeenCalled();
  });

  it('bumps register/sysvar revs and updates banks when a spectrum is attached', () => {
    const snap = new Uint8Array(0x10000);
    const spec = makeSpectrumWithSnap(snap);
    spec!.variant = { hasBanking: true, hasFDC: false, hasAY: false };
    (spec as any).memory = {
      ...spec!.memory,
      port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false,
      currentROM: 0, currentBank: 0,
    };
    emu.spectrum = spec;
    updateRegsOnce();
    expect(emu.setRegsRev).toHaveBeenCalled();
    expect(emu.setSysvarRev).toHaveBeenCalled();
    expect(emu.setBanksHtml).toHaveBeenCalled();
  });
});

describe('onFrame — breakpoint handling', () => {
  it('is a no-op when no spectrum is attached', () => {
    emu.spectrum = null;
    expect(() => onFrame()).not.toThrow();
    expect(emu.setEmulationPaused).not.toHaveBeenCalled();
  });

  it('pauses emulation and sets status when a breakpoint fires', () => {
    const snap = new Uint8Array(0x10000);
    const spec = makeSpectrumWithSnap(snap)!;
    spec.breakpointHit = 0xABCD;
    (spec as any).memory = { ...spec.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false, currentROM: 0, currentBank: 0 };
    emu.spectrum = spec;
    onFrame();
    expect(spec.stop).toHaveBeenCalledOnce();
    expect(emu.setEmulationPaused).toHaveBeenCalledWith(true);
    expect(emu.setStatus).toHaveBeenCalledWith(expect.stringMatching(/breakpoint hit.*ABCD/i));
  });

  it('a run-to breakpoint hit removes the breakpoint and clears pendingRunTo', () => {
    const snap = new Uint8Array(0x10000);
    const spec = makeSpectrumWithSnap(snap)!;
    spec.breakpointHit = 0x4000;
    spec.breakpoints.add(0x4000);
    (spec as any).memory = { ...spec.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false, currentROM: 0, currentBank: 0 };
    emu.spectrum = spec;
    emu.getPendingRunTo.mockReturnValueOnce(0x4000);
    onFrame();
    expect(spec.breakpoints.has(0x4000)).toBe(false);
    expect(emu.clearPendingRunTo).toHaveBeenCalledOnce();
    expect(emu.setStatus).toHaveBeenCalledWith(expect.stringMatching(/run-to reached.*4000/i));
  });

  it('a user breakpoint hit (non run-to) keeps the breakpoint in place', () => {
    const snap = new Uint8Array(0x10000);
    const spec = makeSpectrumWithSnap(snap)!;
    spec.breakpointHit = 0x4000;
    spec.breakpoints.add(0x4000);
    (spec as any).memory = { ...spec.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false, currentROM: 0, currentBank: 0 };
    emu.spectrum = spec;
    emu.getPendingRunTo.mockReturnValue(-1); // no pending run-to
    onFrame();
    expect(spec.breakpoints.has(0x4000)).toBe(true);
    expect(emu.clearPendingRunTo).not.toHaveBeenCalled();
  });
});

describe('onFrame — LED thresholds', () => {
  function specWithActivity(activity: Partial<Record<string, number | boolean>>): MockSpectrum {
    const snap = new Uint8Array(0x10000);
    const s = makeSpectrumWithSnap(snap)!;
    s.activity = {
      ulaReads: 0, kempstonReads: 0, earReads: 0, tapeLoads: 0,
      beeperToggled: false, ayWrites: 0, fdcAccesses: 0, attrWrites: 0,
      mouseReads: 0,
      ...activity,
    };
    (s as any).memory = { ...s.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false, currentROM: 0, currentBank: 0 };
    return s;
  }

  it('LedAy lights only when ayWrites > 5 (low-threshold filter)', () => {
    emu.spectrum = specWithActivity({ ayWrites: 5 });
    onFrame();
    expect(emu.setLedAy).toHaveBeenCalledWith(false);
    emu.setLedAy.mockClear();
    emu.spectrum = specWithActivity({ ayWrites: 6 });
    onFrame();
    expect(emu.setLedAy).toHaveBeenCalledWith(true);
  });

  it('LedRainbow lights only when attrWrites > 768 (more than one full attr refresh)', () => {
    emu.spectrum = specWithActivity({ attrWrites: 768 });
    onFrame();
    expect(emu.setLedRainbow).toHaveBeenCalledWith(false);
    emu.setLedRainbow.mockClear();
    emu.spectrum = specWithActivity({ attrWrites: 769 });
    onFrame();
    expect(emu.setLedRainbow).toHaveBeenCalledWith(true);
  });

  it('SMELL: setLedText is OR\'d with earReads — transcribe LED lights on tape EAR activity', () => {
    // With transcribe mode off but tape EAR reads non-zero, setLedText(true).
    // That conflates two different concepts on one LED.
    emu.transcribeMode.mockReturnValue('off');
    emu.spectrum = specWithActivity({ earReads: 1 });
    onFrame();
    expect(emu.setLedText).toHaveBeenCalledWith(true);
  });

  it('LedLoad (TAPE) lights while the tape is playing, even with no ROM LD-BYTES hits', () => {
    // Custom/turbo loaders (Speedlock et al.) poll the ULA from their own code
    // and never execute 0x0556, so tapeLoads stays 0. The TAPE LED must follow
    // live playback or it would sit dark for the entire turbo load.
    const s = specWithActivity({ tapeLoads: 0 })!;
    s.tape = { ...s.tape, loaded: true, playing: true, paused: false };
    emu.spectrum = s;
    onFrame();
    expect(emu.setLedLoad).toHaveBeenCalledWith(true);
  });

  it('LedLoad (TAPE) is off when the tape is stopped and no ROM load occurred', () => {
    const s = specWithActivity({ tapeLoads: 0 })!;
    s.tape = { ...s.tape, loaded: true, playing: false, paused: false };
    emu.spectrum = s;
    onFrame();
    expect(emu.setLedLoad).toHaveBeenCalledWith(false);
  });

  it('LedLoad (TAPE) is off while the tape is paused', () => {
    const s = specWithActivity({ tapeLoads: 0 })!;
    s.tape = { ...s.tape, loaded: true, playing: true, paused: true };
    emu.spectrum = s;
    onFrame();
    expect(emu.setLedLoad).toHaveBeenCalledWith(false);
  });
});

// ── FDC mock helpers ─────────────────────────────────────────────────────

function makeFdcMock(opts: {
  motorOn?: boolean; isExecuting?: boolean; isWriting?: boolean;
  currentUnit?: number; currentTrack?: number; currentSector?: number;
  formattedUnit?: number;
} = {}) {
  const { motorOn = false, isExecuting = false, isWriting = false,
    currentUnit = 0, currentTrack = 0, currentSector = 1, formattedUnit = -1 } = opts;
  return {
    motorOn, isExecuting, isWriting, currentUnit, currentTrack, currentSector, formattedUnit,
    tickFrame: vi.fn(),
    getUnitTrack: vi.fn((_u: number) => currentTrack),
    getDiskImage: vi.fn((_u: number) => null as any),
  };
}

function makeSpectrumWithFDC(fdcOpts?: Parameters<typeof makeFdcMock>[0]): ReturnType<typeof makeSpectrumWithSnap> {
  const snap = new Uint8Array(0x10000);
  const s = makeSpectrumWithSnap(snap) as any;
  s.variant = { hasBanking: false, hasFDC: true, hasAY: false };
  s.fdc = makeFdcMock(fdcOpts);
  s.memory = {
    ...s.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false,
    specialPaging: false, currentROM: 0, currentBank: 0,
  };
  return s;
}

// ── renderBanks content ───────────────────────────────────────────────────

describe('renderBanks (via updateRegsOnce)', () => {
  function make128K(memOverrides: Record<string, unknown> = {}, model: string = '128k') {
    emu.currentModel.mockReturnValue(model as any);
    const snap = new Uint8Array(0x10000);
    const s = makeSpectrumWithSnap(snap)!;
    s.variant = { hasBanking: true, hasFDC: false, hasAY: false };
    (s as any).memory = {
      ...s.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false,
      specialPaging: false, currentROM: 0, currentBank: 0,
      ...memOverrides,
    };
    return s;
  }

  afterEach(() => { emu.currentModel.mockReturnValue('48k' as any); });

  it('48K: setBanksHtml is not called when hasBanking is false', () => {
    const snap = new Uint8Array(0x10000);
    const s = makeSpectrumWithSnap(snap)!;
    s.variant = { hasBanking: false, hasFDC: false, hasAY: false };
    (s as any).memory = { ...s.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false, currentROM: 0, currentBank: 0 };
    emu.spectrum = s;
    updateRegsOnce();
    expect(emu.setBanksHtml).not.toHaveBeenCalled();
  });

  it('128K ROM 0 → "128K Editor ROM"', () => {
    emu.spectrum = make128K({ currentROM: 0 });
    updateRegsOnce();
    expect(emu.setBanksHtml).toHaveBeenCalledWith(expect.stringContaining('128K Editor ROM'));
  });

  it('128K ROM 1 → "48K BASIC ROM"', () => {
    emu.spectrum = make128K({ currentROM: 1 });
    updateRegsOnce();
    expect(emu.setBanksHtml).toHaveBeenCalledWith(expect.stringContaining('48K BASIC ROM'));
  });

  it('bank 5 marked (Screen) when port7FFD bit 3 is clear (default screen)', () => {
    emu.spectrum = make128K({ port7FFD: 0x00, currentBank: 0 });
    updateRegsOnce();
    expect(emu.setBanksHtml).toHaveBeenCalledWith(expect.stringContaining('RAM Bank 5 (Screen)'));
  });

  it('bank 7 marked (Screen) and bank 5 not marked when port7FFD bit 3 is set', () => {
    emu.spectrum = make128K({ port7FFD: 0x08, currentBank: 7 });
    updateRegsOnce();
    const html: string = emu.setBanksHtml.mock.calls[0]![0];
    expect(html).toContain('RAM Bank 7 (Screen)');
    expect(html).not.toContain('RAM Bank 5 (Screen)');
  });

  it('current RAM bank shown at C000-FFFF', () => {
    emu.spectrum = make128K({ currentBank: 3 });
    updateRegsOnce();
    const html: string = emu.setBanksHtml.mock.calls[0]![0];
    expect(html).toMatch(/C000-FFFF.*RAM Bank 3/);
  });

  it('pagingLocked=true shows "Lock" and "Y"', () => {
    emu.spectrum = make128K({ pagingLocked: true });
    updateRegsOnce();
    const html: string = emu.setBanksHtml.mock.calls[0]![0];
    expect(html).toContain('Lock');
    expect(html).toContain('Y');
  });

  it('+2A normal paging shows "ROM Page N"', () => {
    emu.spectrum = make128K({ currentROM: 2, specialPaging: false }, '+2A');
    updateRegsOnce();
    expect(emu.setBanksHtml).toHaveBeenCalledWith(expect.stringContaining('ROM Page 2'));
  });

  it('+2A port line includes 1FFD column', () => {
    emu.spectrum = make128K({ port7FFD: 0x10, port1FFD: 0x04, specialPaging: false }, '+2A');
    updateRegsOnce();
    const html: string = emu.setBanksHtml.mock.calls[0]![0];
    expect(html).toContain('7FFD');
    expect(html).toContain('1FFD');
  });

  it('+2A special paging mode 0 → banks 0,1,2,3 from bottom to top', () => {
    // mode = (port1FFD >> 1) & 3 = 0 → configs[0] = ['0','1','2','3']
    emu.spectrum = make128K({ specialPaging: true, port1FFD: 0x00 }, '+2A');
    updateRegsOnce();
    const html: string = emu.setBanksHtml.mock.calls[0]![0];
    expect(html).toContain('RAM Bank 0');
    expect(html).toContain('RAM Bank 1');
    expect(html).toContain('RAM Bank 2');
    expect(html).toContain('RAM Bank 3');
  });

  it('+2A special paging mode 1 → banks 4,5,6,7', () => {
    // mode = (0x02 >> 1) & 3 = 1 → configs[1] = ['4','5','6','7']
    emu.spectrum = make128K({ specialPaging: true, port1FFD: 0x02 }, '+2A');
    updateRegsOnce();
    const html: string = emu.setBanksHtml.mock.calls[0]![0];
    expect(html).toContain('RAM Bank 4');
    expect(html).toContain('RAM Bank 5');
    expect(html).toContain('RAM Bank 6');
    expect(html).toContain('RAM Bank 7');
  });

  it('+2A special paging mode 2 → banks 4,5,6,3', () => {
    // mode = (0x04 >> 1) & 3 = 2 → configs[2] = ['4','5','6','3']
    emu.spectrum = make128K({ specialPaging: true, port1FFD: 0x04 }, '+2A');
    updateRegsOnce();
    const html: string = emu.setBanksHtml.mock.calls[0]![0];
    // All four banks appear; spot-check the top (C000) and bottom (0000)
    expect(html).toContain('RAM Bank 3');  // C000-FFFF
    expect(html).toContain('RAM Bank 4');  // 0000-3FFF
  });

  it('+2A special paging mode 3 → banks 4,7,6,3', () => {
    // mode = (0x06 >> 1) & 3 = 3 → configs[3] = ['4','7','6','3']
    emu.spectrum = make128K({ specialPaging: true, port1FFD: 0x06 }, '+2A');
    updateRegsOnce();
    const html: string = emu.setBanksHtml.mock.calls[0]![0];
    expect(html).toContain('RAM Bank 3');
    expect(html).toContain('RAM Bank 7');
    expect(html).toContain('RAM Bank 4');
  });
});

// ── renderDriveStatus LED states ──────────────────────────────────────────

describe('renderDriveStatus LED states (via onFrame)', () => {
  it('LED is "off" when motor is off', () => {
    emu.spectrum = makeSpectrumWithFDC({ motorOn: false, currentUnit: 0 });
    onFrame();
    expect(emu.setDriveAStatus).toHaveBeenCalledWith(expect.objectContaining({ led: 'off' }));
  });

  it('inactive drive B is "off" even when motor is on and executing', () => {
    // activeUnit = fdc.currentUnit = 0 (drive A active), so drive B is inactive
    emu.spectrum = makeSpectrumWithFDC({ motorOn: true, isExecuting: true, currentUnit: 0 });
    onFrame();
    expect(emu.setDriveBStatus).toHaveBeenCalledWith(expect.objectContaining({ led: 'off' }));
  });

  it('LED is "motor" when motor on but not executing on active drive', () => {
    emu.spectrum = makeSpectrumWithFDC({ motorOn: true, isExecuting: false, currentUnit: 0 });
    onFrame();
    expect(emu.setDriveAStatus).toHaveBeenCalledWith(expect.objectContaining({ led: 'motor' }));
  });

  it('LED is "read" when motor on and executing a read on active drive', () => {
    emu.spectrum = makeSpectrumWithFDC({ motorOn: true, isExecuting: true, isWriting: false, currentUnit: 0 });
    onFrame();
    expect(emu.setDriveAStatus).toHaveBeenCalledWith(expect.objectContaining({ led: 'read' }));
  });

  it('LED is "write" when motor on and executing a write on active drive', () => {
    emu.spectrum = makeSpectrumWithFDC({ motorOn: true, isExecuting: true, isWriting: true, currentUnit: 0 });
    onFrame();
    expect(emu.setDriveAStatus).toHaveBeenCalledWith(expect.objectContaining({ led: 'write' }));
  });

  it('track is zero-padded to 2 digits', () => {
    emu.spectrum = makeSpectrumWithFDC({ currentTrack: 5, currentUnit: 0 });
    onFrame();
    expect(emu.setDriveAStatus).toHaveBeenCalledWith(expect.objectContaining({ track: '05' }));
  });

  it('sector shown as zero-padded 2 digits when executing on active drive', () => {
    emu.spectrum = makeSpectrumWithFDC({ motorOn: true, isExecuting: true, currentSector: 7, currentUnit: 0 });
    onFrame();
    expect(emu.setDriveAStatus).toHaveBeenCalledWith(expect.objectContaining({ sector: '07' }));
  });

  it('sector is "--" when not executing', () => {
    emu.spectrum = makeSpectrumWithFDC({ motorOn: true, isExecuting: false, currentUnit: 0 });
    onFrame();
    expect(emu.setDriveAStatus).toHaveBeenCalledWith(expect.objectContaining({ sector: '--' }));
  });

  it('sector is "--" for inactive drive even when executing', () => {
    // Drive B (unit=1) is inactive; its sector should be '--'
    emu.spectrum = makeSpectrumWithFDC({ motorOn: true, isExecuting: true, currentSector: 9, currentUnit: 0 });
    onFrame();
    expect(emu.setDriveBStatus).toHaveBeenCalledWith(expect.objectContaining({ sector: '--' }));
  });
});

// ── FDC format completion ─────────────────────────────────────────────────

describe('updateHardwareSignals — FDC format completion', () => {
  it('setCurrentDiskInfo called (not B) when formattedUnit is 0', () => {
    const s = makeSpectrumWithFDC({ formattedUnit: 0 }) as any;
    const fakeImage = { numSides: 1, numTracks: 40, tracks: [], protection: [] };
    s.fdc.getDiskImage.mockReturnValue(fakeImage);
    emu.spectrum = s;
    onFrame();
    expect(emu.setCurrentDiskInfo).toHaveBeenCalledWith(expect.objectContaining({ numSides: 1 }));
    expect(emu.setCurrentDiskInfoB).not.toHaveBeenCalled();
    // formattedUnit is reset so format completion does not re-fire next frame
    expect(s.fdc.formattedUnit).toBe(-1);
  });

  it('setCurrentDiskInfoB called (not A) when formattedUnit is 1', () => {
    const s = makeSpectrumWithFDC({ formattedUnit: 1 }) as any;
    s.fdc.getDiskImage.mockReturnValue({ numSides: 2, numTracks: 80, tracks: [], protection: [] });
    emu.spectrum = s;
    onFrame();
    expect(emu.setCurrentDiskInfoB).toHaveBeenCalled();
    expect(emu.setCurrentDiskInfo).not.toHaveBeenCalled();
  });

  it('neither disk signal set when getDiskImage returns null', () => {
    const s = makeSpectrumWithFDC({ formattedUnit: 0 }) as any;
    s.fdc.getDiskImage.mockReturnValue(null);
    emu.spectrum = s;
    onFrame();
    expect(emu.setCurrentDiskInfo).not.toHaveBeenCalled();
    expect(emu.setCurrentDiskInfoB).not.toHaveBeenCalled();
  });
});

// ── onFrame — trace auto-stop ─────────────────────────────────────────────

describe('onFrame — trace auto-stop', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: vi.fn(() => Promise.resolve()) } },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    emu.tracing.mockReturnValue(false);
  });

  it('stops tracing, clears signal, and copies text when spectrum.tracing flips false', () => {
    const snap = new Uint8Array(0x10000);
    const spec = makeSpectrumWithSnap(snap)!;
    spec.tracing = false;
    spec.stopTrace = vi.fn(() => 'a\nb\nc');
    (spec as any).memory = { ...spec.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false, currentROM: 0, currentBank: 0 };
    emu.spectrum = spec;
    emu.tracing.mockReturnValue(true);
    onFrame();
    expect(spec.stopTrace).toHaveBeenCalled();
    expect(emu.setTracing).toHaveBeenCalledWith(false);
    expect((navigator.clipboard as any).writeText).toHaveBeenCalledWith('a\nb\nc');
    expect(emu.setStatus).toHaveBeenCalledWith(expect.stringMatching(/auto-stopped.*3/i));
  });

  it('does not call stopTrace when tracing() is already false', () => {
    const snap = new Uint8Array(0x10000);
    const spec = makeSpectrumWithSnap(snap)!;
    spec.tracing = false;
    spec.stopTrace = vi.fn(() => '');
    (spec as any).memory = { ...spec.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false, currentROM: 0, currentBank: 0 };
    emu.spectrum = spec;
    emu.tracing.mockReturnValue(false);
    onFrame();
    expect(spec.stopTrace).not.toHaveBeenCalled();
  });
});

// ── onFrame — tape handling ───────────────────────────────────────────────

describe('onFrame — tape handling', () => {
  type TapeState = NonNullable<MockSpectrum>['tape'];
  function makeSpectrumWithTape(tapeOpts: Partial<TapeState> = {}) {
    const snap = new Uint8Array(0x10000);
    const s = makeSpectrumWithSnap(snap)!;
    s.tape = { loaded: false, position: 0, playing: false, paused: false, finished: false, startPlayback: vi.fn(), cpuClock: 3_546_900, ...tapeOpts };
    (s as any).memory = { ...s.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false, currentROM: 0, currentBank: 0 };
    return s;
  }

  it('sets tape position when tape is loaded', () => {
    emu.spectrum = makeSpectrumWithTape({ loaded: true, position: 42 });
    onFrame();
    expect(emu.setTapePosition).toHaveBeenCalledWith(42);
  });

  it('does not set tape position when tape is not loaded', () => {
    emu.spectrum = makeSpectrumWithTape({ loaded: false });
    onFrame();
    expect(emu.setTapePosition).not.toHaveBeenCalled();
  });

  it('calls setTapePlaying(true) when spectrum tape starts playing', () => {
    emu.tapePlaying.mockReturnValue(false);
    emu.spectrum = makeSpectrumWithTape({ loaded: true, playing: true });
    onFrame();
    expect(emu.setTapePlaying).toHaveBeenCalledWith(true);
  });

  it('does not call setTapePlaying when signal already matches', () => {
    emu.tapePlaying.mockReturnValue(true);
    emu.spectrum = makeSpectrumWithTape({ loaded: true, playing: true });
    onFrame();
    expect(emu.setTapePlaying).not.toHaveBeenCalled();
  });

  it('calls setTapePaused(true) when spectrum tape becomes paused', () => {
    emu.tapePaused.mockReturnValue(false);
    emu.spectrum = makeSpectrumWithTape({ loaded: true, paused: true });
    onFrame();
    expect(emu.setTapePaused).toHaveBeenCalledWith(true);
  });

  it('does not call setTapePaused when signal already matches', () => {
    emu.tapePaused.mockReturnValue(true);
    emu.spectrum = makeSpectrumWithTape({ loaded: true, paused: true });
    onFrame();
    expect(emu.setTapePaused).not.toHaveBeenCalled();
  });

  it('auto-rewinds when tape finishes and tapeAutoRewind is on', () => {
    settingsMock.tapeAutoRewind.mockReturnValue(true);
    const startPlayback = vi.fn();
    const s = makeSpectrumWithTape({ loaded: true, playing: false, finished: true, startPlayback });
    emu.spectrum = s;
    onFrame();
    expect(s.tape.position).toBe(0);
    expect(startPlayback).toHaveBeenCalled();
    expect(emu.setTapePosition).toHaveBeenCalledWith(0);
  });

  it('does not auto-rewind when tapeAutoRewind is off', () => {
    settingsMock.tapeAutoRewind.mockReturnValue(false);
    const startPlayback = vi.fn();
    emu.spectrum = makeSpectrumWithTape({ loaded: true, playing: false, finished: true, startPlayback });
    onFrame();
    expect(startPlayback).not.toHaveBeenCalled();
  });

  it('does not auto-rewind when tape is still playing', () => {
    settingsMock.tapeAutoRewind.mockReturnValue(true);
    const startPlayback = vi.fn();
    emu.spectrum = makeSpectrumWithTape({ loaded: true, playing: true, finished: false, startPlayback });
    onFrame();
    expect(startPlayback).not.toHaveBeenCalled();
  });
});

// ── updateClockSpeed — nominal clock / Turbo readout ─────────────────────

describe('updateClockSpeed', () => {
  function makeBasicSpectrum(cpuClock = 3_546_900) {
    const snap = new Uint8Array(0x10000);
    const s = makeSpectrumWithSnap(snap)!;
    s.cpu = { tStates: 0, pc: 0 };
    s.tape.cpuClock = cpuClock;
    (s as any).memory = { ...s.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false, currentROM: 0, currentBank: 0 };
    return s;
  }

  it('shows the nominal clock, truncated to 2dp (128K → 3.54)', () => {
    emu.spectrum = makeBasicSpectrum(3_546_900);
    resetSpeedTracking();
    expect(emu.setClockSpeedText).toHaveBeenLastCalledWith('3.54');
  });

  it('shows 3.50 for the 48K clock', () => {
    emu.spectrum = makeBasicSpectrum(3_500_000);
    resetSpeedTracking();
    expect(emu.setClockSpeedText).toHaveBeenLastCalledWith('3.50');
  });

  it('shows "Turbo" while the machine runs flat-out', () => {
    const s = makeBasicSpectrum(3_546_900);
    s.turbo = true;
    emu.spectrum = s;
    resetSpeedTracking();
    expect(emu.setClockSpeedText).toHaveBeenLastCalledWith('Turbo');
  });

  it('shows "Turbo" during auto tape-turbo even when manual turbo is off', () => {
    const s = makeBasicSpectrum(3_546_900);
    s.turbo = false;
    s.tapeTurboActive = true;
    emu.spectrum = s;
    resetSpeedTracking();
    expect(emu.setClockSpeedText).toHaveBeenLastCalledWith('Turbo');
  });

  it('repaints only when the label changes (steady readout)', () => {
    emu.spectrum = makeBasicSpectrum(3_546_900);
    resetSpeedTracking();
    emu.setClockSpeedText.mockClear();
    for (let i = 0; i < 10; i++) onFrame();
    // Label unchanged across frames → no repaint churn.
    expect(emu.setClockSpeedText).not.toHaveBeenCalled();
  });

  it('flips from a clock reading to "Turbo" when turbo engages mid-run', () => {
    const s = makeBasicSpectrum(3_546_900);
    emu.spectrum = s;
    resetSpeedTracking();
    emu.setClockSpeedText.mockClear();
    s.turbo = true;
    onFrame();
    expect(emu.setClockSpeedText).toHaveBeenCalledWith('Turbo');
  });
});

// ── onFrame — disasm pane open ────────────────────────────────────────────

describe('onFrame — disasm pane open', () => {
  afterEach(() => {
    panesMock.isCollapsed.mockReturnValue(true);
    emu.emulationPaused.mockReturnValue(false);
  });

  function makeDisasmSpectrum() {
    const snap = new Uint8Array(0x10000);
    const s = makeSpectrumWithSnap(snap)!;
    (s as any).memory = { ...s.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false, currentROM: 0, currentBank: 0 };
    return s;
  }

  it('bumps setRegsRev when disasm-panel is open', () => {
    panesMock.isCollapsed.mockImplementation((id: string) => id !== 'disasm-panel');
    emu.spectrum = makeDisasmSpectrum();
    onFrame();
    expect(emu.setRegsRev).toHaveBeenCalled();
  });

  it('does not bump setRegsRev when disasm-panel is collapsed', () => {
    panesMock.isCollapsed.mockReturnValue(true);
    emu.spectrum = makeDisasmSpectrum();
    onFrame();
    expect(emu.setRegsRev).not.toHaveBeenCalled();
  });

  it('calls setDisasmText when disasm-panel is open and emulation is paused', () => {
    panesMock.isCollapsed.mockImplementation((id: string) => id !== 'disasm-panel');
    emu.emulationPaused.mockReturnValue(true);
    emu.spectrum = makeDisasmSpectrum();
    onFrame();
    expect(emu.setDisasmText).toHaveBeenCalled();
  });

  it('does not call setDisasmText when disasm-panel is open but emulation is running', () => {
    panesMock.isCollapsed.mockImplementation((id: string) => id !== 'disasm-panel');
    emu.emulationPaused.mockReturnValue(false);
    emu.spectrum = makeDisasmSpectrum();
    onFrame();
    expect(emu.setDisasmText).not.toHaveBeenCalled();
  });
});

// ── capturedFontData ──────────────────────────────────────────────────────
// capturedFontData is the last captured ROM font slice; it's the same object
// returned as result.data, so verify via the return value (live-binding
// behaviour through esbuild transforms is not guaranteed).

describe('capturedFontData', () => {
  it('return value data is a 768-byte slice of the snapshot at the font address', () => {
    const snap = new Uint8Array(0x10000);
    snap[0x5C36] = 0; snap[0x5C37] = 0;
    for (let i = 8; i < 768; i++) snap[0x3D00 + i] = (i * 7) & 0xFF;
    emu.spectrum = makeSpectrumWithSnap(snap);
    snap[0x3D00 + 500] ^= 0x01; // invalidate hash so capture runs
    const result = updateFontPreview();
    expect(result?.type).toBe('rom');
    expect(result!.data.length).toBe(768);
    // First 8 bytes are the blank space glyph
    for (let i = 0; i < 8; i++) expect(result!.data[i]).toBe(0);
    // Remaining bytes match our pattern (adjusted for the XOR'd byte)
    expect(result!.data[8]).toBe((8 * 7) & 0xFF);
  });
});

// ── onFrame — loader signature transitions ────────────────────────────────

// lastAnnouncedSignature is module-level. Reset it to 'unknown' before each test
// by running one frame with signature='unknown'. If it was already 'unknown' the
// transition check is a no-op; if it was something else, it resets to 'unknown'.
function makeSpectrumWithSig(sig: string) {
  const snap = new Uint8Array(0x10000);
  const s = makeSpectrumWithSnap(snap)!;
  (s as any).loaderDetector = { signature: sig };
  (s as any).memory = { ...s.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false, currentROM: 0, currentBank: 0 };
  return s;
}

describe('onFrame — loader signature transitions', () => {
  beforeEach(() => {
    emu.spectrum = makeSpectrumWithSig('unknown');
    onFrame();
    emu.setStatus.mockClear();
  });

  it('unknown → known: calls setStatus with the loader label', () => {
    emu.spectrum = makeSpectrumWithSig('rom');
    onFrame();
    expect(emu.setStatus).toHaveBeenCalledWith(expect.stringContaining('ROM loader'));
  });

  it('unknown → known: message contains "accelerated"', () => {
    emu.spectrum = makeSpectrumWithSig('speedlock');
    onFrame();
    expect(emu.setStatus).toHaveBeenCalledWith(expect.stringContaining('accelerated'));
  });

  it('known → same known: no setStatus call on subsequent frames', () => {
    emu.spectrum = makeSpectrumWithSig('rom');
    onFrame();              // unknown → 'rom', fires setStatus
    emu.setStatus.mockClear();
    onFrame();              // 'rom' → 'rom', no transition
    expect(emu.setStatus).not.toHaveBeenCalled();
  });

  it('known → unknown: no setStatus call (silent reset)', () => {
    emu.spectrum = makeSpectrumWithSig('rom');
    onFrame();              // unknown → 'rom'
    emu.setStatus.mockClear();
    emu.spectrum = makeSpectrumWithSig('unknown');
    onFrame();              // 'rom' → 'unknown' — no announcement
    expect(emu.setStatus).not.toHaveBeenCalled();
  });

  it('known → different known: fires setStatus with new label', () => {
    emu.spectrum = makeSpectrumWithSig('rom');
    onFrame();              // unknown → 'rom'
    emu.setStatus.mockClear();
    emu.spectrum = makeSpectrumWithSig('speedlock');
    onFrame();              // 'rom' → 'speedlock'
    expect(emu.setStatus).toHaveBeenCalledWith(expect.stringContaining('Speedlock'));
  });
});

// ── onFrame — throttled slow panel updates (_lastSlowUpdate) ─────────────

// _lastSlowUpdate is module-level state. Each "fires" test advances it by ~1001ms beyond
// the priming base. By jumping THROTTLE_STEP (100_000ms) per test we always overshoot,
// so the priming frame reliably fires the throttle regardless of prior test order.
let throttleBase = 10_000_000;

describe('onFrame — throttled slow panel updates (_lastSlowUpdate)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let nowSpy: any;

  function makeThrottleSpectrum() {
    const snap = new Uint8Array(0x10000);
    const s = makeSpectrumWithSnap(snap)!;
    (s as any).memory = { ...s.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false, currentROM: 0, currentBank: 0 };
    return s;
  }

  beforeEach(() => {
    // Advance throttleBase by 100_000ms — always > any accumulated _lastSlowUpdate + 1000.
    // isCollapsed returns true so the priming frame sets _lastSlowUpdate but fires no signals.
    throttleBase += 100_000;
    nowSpy = vi.spyOn(performance, 'now').mockReturnValue(throttleBase);
    panesMock.isCollapsed.mockReturnValue(true);
    emu.spectrum = makeThrottleSpectrum();
    onFrame();
    emu.setSysvarRev.mockClear();
    emu.setBasicHtml.mockClear();
    emu.setBasicVarsHtml.mockClear();
  });

  afterEach(() => {
    nowSpy.mockRestore();
    panesMock.isCollapsed.mockReturnValue(true);
  });

  it('does not call sysvar/basic signals within 1 second even if all panes open', () => {
    nowSpy.mockReturnValue(throttleBase + 500); // 500ms — under threshold
    panesMock.isCollapsed.mockReturnValue(false);
    onFrame();
    expect(emu.setSysvarRev).not.toHaveBeenCalled();
    expect(emu.setBasicHtml).not.toHaveBeenCalled();
    expect(emu.setBasicVarsHtml).not.toHaveBeenCalled();
  });

  it('calls setSysvarRev when sysvar-panel is open and > 1s elapsed', () => {
    nowSpy.mockReturnValue(throttleBase + 1001);
    panesMock.isCollapsed.mockImplementation((id: string) => id !== 'sysvar-panel');
    onFrame();
    expect(emu.setSysvarRev).toHaveBeenCalled();
  });

  it('does not call setSysvarRev when sysvar-panel is collapsed even after > 1s', () => {
    nowSpy.mockReturnValue(throttleBase + 1001);
    panesMock.isCollapsed.mockReturnValue(true);
    onFrame();
    expect(emu.setSysvarRev).not.toHaveBeenCalled();
  });

  it('calls setBasicHtml when basic-panel is open and > 1s elapsed', () => {
    nowSpy.mockReturnValue(throttleBase + 1001);
    panesMock.isCollapsed.mockImplementation((id: string) => id !== 'basic-panel');
    onFrame();
    expect(emu.setBasicHtml).toHaveBeenCalled();
  });

  it('does not call setBasicHtml when basic-panel is collapsed even after > 1s', () => {
    nowSpy.mockReturnValue(throttleBase + 1001);
    panesMock.isCollapsed.mockReturnValue(true);
    onFrame();
    expect(emu.setBasicHtml).not.toHaveBeenCalled();
  });

  it('calls setBasicVarsHtml when basic-vars-panel is open and > 1s elapsed', () => {
    nowSpy.mockReturnValue(throttleBase + 1001);
    panesMock.isCollapsed.mockImplementation((id: string) => id !== 'basic-vars-panel');
    onFrame();
    expect(emu.setBasicVarsHtml).toHaveBeenCalled();
  });

  it('updates only the open pane — basic open but vars closed: no setBasicVarsHtml', () => {
    nowSpy.mockReturnValue(throttleBase + 1001);
    panesMock.isCollapsed.mockImplementation((id: string) => id !== 'basic-panel');
    onFrame();
    expect(emu.setBasicHtml).toHaveBeenCalled();
    expect(emu.setBasicVarsHtml).not.toHaveBeenCalled();
  });
});

// ── onFrame — transcribe mode ─────────────────────────────────────────────

describe('onFrame — transcribe mode', () => {
  function makeTranscribeSpectrum(screenActive: boolean) {
    const snap = new Uint8Array(0x10000);
    const s = makeSpectrumWithSnap(snap)!;
    (s as any).memory = { ...s.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false, currentROM: 0, currentBank: 0 };
    s.screenText = { active: screenActive, activate: vi.fn(), deactivate: vi.fn() };
    return s;
  }

  afterEach(() => {
    emu.transcribeMode.mockReturnValue('off');
  });

  it('calls screenText.activate() when transcribeMode first turns on', () => {
    emu.transcribeMode.mockReturnValue('text' as any);
    const s = makeTranscribeSpectrum(false);
    emu.spectrum = s;
    onFrame();
    expect(s.screenText.activate).toHaveBeenCalledOnce();
  });

  it('does not re-activate when screenText is already active', () => {
    emu.transcribeMode.mockReturnValue('text' as any);
    const s = makeTranscribeSpectrum(true);
    emu.spectrum = s;
    onFrame();
    expect(s.screenText.activate).not.toHaveBeenCalled();
  });

  it('calls screenText.deactivate() when transcribeMode turns off and screenText is active', () => {
    emu.transcribeMode.mockReturnValue('off');
    const s = makeTranscribeSpectrum(true);
    emu.spectrum = s;
    onFrame();
    expect(s.screenText.deactivate).toHaveBeenCalledOnce();
  });

  it('does not call deactivate when transcribeMode is off and screenText is already inactive', () => {
    emu.transcribeMode.mockReturnValue('off');
    const s = makeTranscribeSpectrum(false);
    emu.spectrum = s;
    onFrame();
    expect(s.screenText.deactivate).not.toHaveBeenCalled();
  });

  it('setLedText is true when transcribeMode is "text" (regardless of earReads)', () => {
    emu.transcribeMode.mockReturnValue('text' as any);
    const s = makeTranscribeSpectrum(false);
    s.activity = {
      ulaReads: 0, kempstonReads: 0, earReads: 0, tapeLoads: 0,
      beeperToggled: false, ayWrites: 0, fdcAccesses: 0, attrWrites: 0, mouseReads: 0,
    };
    emu.spectrum = s;
    onFrame();
    expect(emu.setLedText).toHaveBeenCalledWith(true);
  });
});

// ── onFrame — floppy sound reset path ────────────────────────────────────

describe('onFrame — floppy sound reset', () => {
  afterEach(() => {
    emu.floppySound = null;
    settingsMock.diskSoundA.mockReturnValue(false);
  });

  it('calls floppySound.reset() when floppySound is set but variant has no FDC', () => {
    const snap = new Uint8Array(0x10000);
    const s = makeSpectrumWithSnap(snap)!; // hasFDC = false by default
    (s as any).memory = { ...s.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false, currentROM: 0, currentBank: 0 };
    emu.spectrum = s;
    const reset = vi.fn();
    emu.floppySound = { reset } as any;
    onFrame();
    expect(reset).toHaveBeenCalled();
  });

  it('calls floppySound.reset() when drive sound is disabled for the active drive', () => {
    const s = makeSpectrumWithFDC({ currentUnit: 0 }) as any;
    emu.spectrum = s;
    settingsMock.diskSoundA.mockReturnValue(false);
    const reset = vi.fn();
    emu.floppySound = { reset } as any;
    onFrame();
    expect(reset).toHaveBeenCalled();
  });

  it('does not call floppySound.reset() when floppySound is null', () => {
    // Baseline: no floppySound, no crash
    const snap = new Uint8Array(0x10000);
    const s = makeSpectrumWithSnap(snap)!;
    (s as any).memory = { ...s.memory, port7FFD: 0, port1FFD: 0, pagingLocked: false, specialPaging: false, currentROM: 0, currentBank: 0 };
    emu.spectrum = s;
    emu.floppySound = null;
    expect(() => onFrame()).not.toThrow();
  });

  it('calls floppySound.update() when hasFDC is true and drive sound is enabled', () => {
    const s = makeSpectrumWithFDC({ currentUnit: 0, motorOn: true, currentTrack: 5 }) as any;
    s.audio = { ctx: null };  // no audio context — attach() should not be called
    settingsMock.diskSoundA.mockReturnValue(true);
    emu.spectrum = s;
    const update = vi.fn();
    emu.floppySound = { update, reset: vi.fn(), driveType: '' } as any;
    onFrame();
    expect(update).toHaveBeenCalledWith(true, 5);
  });

  it('selects "3inch" driveType for disk capacity ≤ 500 KB', () => {
    const s = makeSpectrumWithFDC({ currentUnit: 0, motorOn: false, currentTrack: 0 }) as any;
    s.audio = { ctx: null };
    settingsMock.diskSoundA.mockReturnValue(true);
    // 1 side × 40 tracks × 9 sectors × 512 bytes = 180 KB < 500 KB
    const sector = { n: 2, data: new Uint8Array(512) }; // n=2 → 128<<2 = 512
    const track = { sectors: Array(9).fill(sector) };
    s.fdc.getDiskImage = vi.fn(() => ({
      numSides: 1, numTracks: 40,
      tracks: [[track], ...Array(39).fill([track])],
    }));
    emu.spectrum = s;
    const sound = { update: vi.fn(), reset: vi.fn(), driveType: '' as string };
    emu.floppySound = sound as any;
    onFrame();
    expect(sound.driveType).toBe('3inch');
  });

  it('selects "3.5inch" driveType for disk capacity > 500 KB', () => {
    const s = makeSpectrumWithFDC({ currentUnit: 0, motorOn: false, currentTrack: 0 }) as any;
    s.audio = { ctx: null };
    settingsMock.diskSoundA.mockReturnValue(true);
    // 2 sides × 80 tracks × 9 sectors × 512 bytes = 720 KB > 500 KB
    const sector = { n: 2, data: new Uint8Array(512) };
    const track = { sectors: Array(9).fill(sector) };
    s.fdc.getDiskImage = vi.fn(() => ({
      numSides: 2, numTracks: 80,
      tracks: [[track], ...Array(79).fill([track])],
    }));
    emu.spectrum = s;
    const sound = { update: vi.fn(), reset: vi.fn(), driveType: '' as string };
    emu.floppySound = sound as any;
    onFrame();
    expect(sound.driveType).toBe('3.5inch');
  });
});
