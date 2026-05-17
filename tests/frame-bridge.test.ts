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
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock @/emulator.ts (must be defined BEFORE importing frame-bridge) ────

type MockSpectrum = {
  memory: { snapshot: () => Uint8Array };
  cpu: { tStates: number; pc: number };
  variant: { hasBanking: boolean; hasFDC: boolean; hasAY: boolean };
  fdc: { currentUnit: number };
  breakpointHit: number;
  breakpoints: Set<number>;
  stop: ReturnType<typeof vi.fn>;
  stopTrace: ReturnType<typeof vi.fn>;
  tracing: boolean;
  tapeTurboActive: boolean;
  tape: { loaded: boolean; position: number; playing: boolean; paused: boolean; finished: boolean; startPlayback: () => void };
  activity: Record<string, number | boolean>;
  screenText: { active: boolean; activate: () => void; deactivate: () => void };
} | null;

const { emu, settingsMock } = vi.hoisted(() => ({
  emu: {
    spectrum: null as any,
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
  },
}));

vi.mock('@/emulator.ts', () => emu);
vi.mock('@/store/settings.ts', () => settingsMock);

// Mock @/ui/panes.ts so isCollapsed is deterministic.
vi.mock('@/ui/panes.ts', () => ({ isCollapsed: vi.fn(() => true) }));

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
  resetSpeedTracking,
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
    breakpointHit: -1,
    breakpoints: new Set(),
    stop: vi.fn(),
    stopTrace: vi.fn(() => ''),
    tracing: false,
    tapeTurboActive: false,
    tape: { loaded: false, position: 0, playing: false, paused: false, finished: false, startPlayback: vi.fn() },
    activity: {},
    screenText: { active: false, activate: vi.fn(), deactivate: vi.fn() },
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
  it('resetSpeedTracking writes "MHz" placeholder to the clock-speed signal', () => {
    resetSpeedTracking();
    expect(emu.setClockSpeedText).toHaveBeenCalledWith('MHz');
  });

  it('forceSpeedUpdate does NOT immediately set the clock-speed signal', () => {
    // Documented as "force immediate MHz update on next frame" — but the
    // implementation just re-baselines and sets frameCount=0, so the next
    // actual update is still 50 frames away. Lock that in to flag if/when
    // the implementation is changed.
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
});
