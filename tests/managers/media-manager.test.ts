/**
 * media-manager — file routing, format dispatch, ROM upgrade gating.
 *
 * All parsers, persistence and the zip picker are mocked: we want to
 * exercise routing/orchestration logic, not re-test the formats themselves
 * (those have their own test files). Each test builds a stub Spectrum
 * with vi.fn() methods so we can assert the sequence of lifecycle calls
 * (stop → reset → load → start) along with persistence + callback firing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks for every module media-manager imports ────────────────────────

const parseTZX = vi.fn();
const parseDSK = vi.fn();
const unzip = vi.fn();
const showFilePicker = vi.fn();
const loadSNA = vi.fn();
const loadZ80 = vi.fn();
const loadSZX = vi.fn();
const loadSP = vi.fn();
const persistLastFile = vi.fn();
const persistTape = vi.fn();
const clearTape = vi.fn();
const persistDisk = vi.fn();
const clearDisk = vi.fn();

vi.mock('@/tape/tzx.ts', () => ({ parseTZX: (...a: any[]) => parseTZX(...a) }));
vi.mock('@/plus3/dsk.ts', () => ({ parseDSK: (...a: any[]) => parseDSK(...a) }));
vi.mock('@/snapshot/zip.ts', () => ({ unzip: (...a: any[]) => unzip(...a) }));
vi.mock('@/ui/zip-picker.ts', () => ({ showFilePicker: (...a: any[]) => showFilePicker(...a) }));
vi.mock('@/snapshot/sna.ts', () => ({ loadSNA: (...a: any[]) => loadSNA(...a) }));
vi.mock('@/snapshot/z80format.ts', () => ({ loadZ80: (...a: any[]) => loadZ80(...a) }));
vi.mock('@/snapshot/szx.ts', () => ({ loadSZX: (...a: any[]) => loadSZX(...a) }));
vi.mock('@/snapshot/sp.ts', () => ({ loadSP: (...a: any[]) => loadSP(...a) }));
vi.mock('@/store/persistence.ts', () => ({
  persistLastFile: (...a: any[]) => persistLastFile(...a),
  persistTape: (...a: any[]) => persistTape(...a),
  clearTape: (...a: any[]) => clearTape(...a),
  persistDisk: (...a: any[]) => persistDisk(...a),
  clearDisk: (...a: any[]) => clearDisk(...a),
}));

import { MediaManager } from '@/managers/media-manager.ts';

// ── Stub builders ───────────────────────────────────────────────────────

function makeSpectrum() {
  return {
    cpu: {} as any,
    memory: {
      port7FFD: 0, port1FFD: 0,
      currentBank: 0, currentROM: 0,
      pagingLocked: false, specialPaging: false,
      applyBanking: vi.fn(),
    } as any,
    tape: {
      blocks: [] as any[],
      position: 0,
      paused: false,
      parseTAP: vi.fn(),
      startPlayback: vi.fn(),
      stopPlayback: vi.fn(),
    } as any,
    ula: { borderColor: 0, flashState: false } as any,
    ay: { setRegisters: vi.fn(), selectedReg: 0 } as any,
    fdc: { ejectDisk: vi.fn() } as any,
    stop: vi.fn(),
    start: vi.fn(),
    reset: vi.fn(),
    loadDisk: vi.fn(),
  };
}

function makeCallbacks() {
  return {
    onStatus: vi.fn(),
    onTapeLoaded: vi.fn(),
    onDiskLoaded: vi.fn(),
    onSnapshotLoaded: vi.fn(),
    unpause: vi.fn(),
    ensure128kROM: vi.fn(async () => true),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── loadFile — extension dispatch ───────────────────────────────────────

describe('loadFile — extension dispatch', () => {
  it('rejects load when no Spectrum instance is present', async () => {
    const mm = new MediaManager();
    const cb = makeCallbacks();
    await mm.loadFile(null, new Uint8Array(), 'x.tap', '48k', cb);
    expect(cb.onStatus).toHaveBeenCalledWith('Load a ROM first');
  });

  it('routes .tap to the tape loader', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    sp.tape.parseTAP.mockReturnValue([{ kind: 'rom' }]);
    await mm.loadFile(sp as any, new Uint8Array([1, 2]), 'game.tap', '48k', cb);
    expect(sp.tape.parseTAP).toHaveBeenCalled();
    expect(cb.onTapeLoaded).toHaveBeenCalled();
  });

  it('routes .tzx to parseTZX (not parseTAP)', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    parseTZX.mockReturnValue([{ kind: 'rom' }]);
    await mm.loadFile(sp as any, new Uint8Array(), 'game.tzx', '48k', cb);
    expect(parseTZX).toHaveBeenCalled();
    expect(sp.tape.parseTAP).not.toHaveBeenCalled();
  });

  it('routes .dsk to parseDSK with the chosen unit', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    parseDSK.mockReturnValue({ tracks: [] });
    await mm.loadFile(sp as any, new Uint8Array(), 'game.dsk', '+3', cb, 1);
    expect(parseDSK).toHaveBeenCalled();
    expect(sp.loadDisk).toHaveBeenCalledWith({ tracks: [] }, 1);
  });

  it('routes snapshot extensions to the right loader', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    loadSNA.mockReturnValue({ is128K: false, borderColor: 0 });
    loadZ80.mockReturnValue({ is128K: false, borderColor: 0 });
    loadSZX.mockResolvedValue({ is128K: false, borderColor: 0, port7FFD: 0, port1FFD: 0 });
    loadSP.mockReturnValue({ is128K: false, borderColor: 0, flashState: false, port7FFD: 0 });

    await mm.loadFile(sp as any, new Uint8Array(48), 'a.sna', '48k', cb);
    await mm.loadFile(sp as any, new Uint8Array(), 'a.z80', '48k', cb);
    await mm.loadFile(sp as any, new Uint8Array(), 'a.szx', '48k', cb);
    await mm.loadFile(sp as any, new Uint8Array(), 'a.sp', '48k', cb);

    expect(loadSNA).toHaveBeenCalledTimes(1);
    expect(loadZ80).toHaveBeenCalledTimes(1);
    expect(loadSZX).toHaveBeenCalledTimes(1);
    expect(loadSP).toHaveBeenCalledTimes(1);
  });

  it('extension matching is case-insensitive', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    sp.tape.parseTAP.mockReturnValue([]);
    await mm.loadFile(sp as any, new Uint8Array(), 'GAME.TAP', '48k', cb);
    expect(sp.tape.parseTAP).toHaveBeenCalled();
  });

  it('reports unknown file types', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    await mm.loadFile(sp as any, new Uint8Array(), 'thing.xyz', '48k', cb);
    expect(cb.onStatus).toHaveBeenCalledWith('Unknown file type: .xyz');
  });
});

// ── applyTape ────────────────────────────────────────────────────────────

describe('applyTape', () => {
  it('stops the machine, swaps blocks, starts it back, and persists', () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    const data = new Uint8Array([1, 2, 3]);
    sp.tape.parseTAP.mockReturnValue([{ kind: 'rom' }]);

    mm.applyTape(sp as any, data, 'game.tap', cb);

    expect(sp.stop).toHaveBeenCalledTimes(1);
    expect(sp.start).toHaveBeenCalledTimes(1);
    expect(sp.tape.startPlayback).toHaveBeenCalled();
    expect(sp.tape.blocks.length).toBe(1);
    expect(sp.tape.position).toBe(0);
    expect(sp.tape.paused).toBe(true);
    expect(cb.onTapeLoaded).toHaveBeenCalledWith([{ kind: 'rom' }], 'game.tap');
    expect(cb.unpause).toHaveBeenCalled();
    expect(persistLastFile).toHaveBeenCalledWith(data, 'game.tap');
    expect(persistTape).toHaveBeenCalledWith(data, 'game.tap');
  });

  it('restarts the machine and does NOT persist on parse error', () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    sp.tape.parseTAP.mockImplementation(() => { throw new Error('bad tape'); });

    mm.applyTape(sp as any, new Uint8Array(), 'game.tap', cb);

    expect(sp.stop).toHaveBeenCalled();
    expect(sp.start).toHaveBeenCalled();
    expect(cb.onStatus).toHaveBeenCalledWith('Error: bad tape');
    expect(cb.onTapeLoaded).not.toHaveBeenCalled();
    expect(persistLastFile).not.toHaveBeenCalled();
    expect(persistTape).not.toHaveBeenCalled();
  });
});

// ── ejectTape / ejectDisk ───────────────────────────────────────────────

describe('eject operations', () => {
  it('ejectTape clears state and notifies', () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    sp.tape.blocks = [{ kind: 'rom' } as any];
    sp.tape.position = 5;
    const onEjected = vi.fn();
    const onStatus = vi.fn();

    mm.ejectTape(sp as any, onEjected, onStatus);

    expect(sp.tape.stopPlayback).toHaveBeenCalled();
    expect(sp.tape.blocks).toEqual([]);
    expect(sp.tape.position).toBe(0);
    expect(sp.tape.paused).toBe(true);
    expect(onEjected).toHaveBeenCalled();
    expect(clearTape).toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith('Tape ejected');
  });

  it('ejectDisk calls fdc.ejectDisk and clears persistence', () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const onEjected = vi.fn();
    const onStatus = vi.fn();

    mm.ejectDisk(sp as any, 0, onEjected, onStatus);

    expect(sp.fdc.ejectDisk).toHaveBeenCalledWith(0);
    expect(clearDisk).toHaveBeenCalledWith(0);
    expect(onEjected).toHaveBeenCalledWith(0);
    expect(onStatus).toHaveBeenCalledWith('Disk A: ejected');
  });

  it('ejectDisk safely no-ops on the FDC when fdc is missing (48K)', () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    sp.fdc = null as any;
    const onEjected = vi.fn();
    const onStatus = vi.fn();

    expect(() => mm.ejectDisk(sp as any, 0, onEjected, onStatus)).not.toThrow();
    expect(clearDisk).toHaveBeenCalled();
    expect(onEjected).toHaveBeenCalled();
  });

  it('ejectDisk B label is "B"', () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const onStatus = vi.fn();
    mm.ejectDisk(sp as any, 1, vi.fn(), onStatus);
    expect(onStatus).toHaveBeenCalledWith('Disk B: ejected');
  });
});

// ── loadDisk ────────────────────────────────────────────────────────────

describe('loadDisk', () => {
  it('parses, hands the image to the spectrum + callback, persists', () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    const data = new Uint8Array([1, 2, 3]);
    parseDSK.mockReturnValue({ tracks: ['x'] });

    mm.loadDisk(sp as any, data, 'game.dsk', 0, cb);

    expect(cb.onDiskLoaded).toHaveBeenCalledWith({ tracks: ['x'] }, 'game.dsk', 0);
    expect(sp.loadDisk).toHaveBeenCalledWith({ tracks: ['x'] }, 0);
    expect(persistLastFile).toHaveBeenCalledWith(data, 'game.dsk');
    expect(persistDisk).toHaveBeenCalledWith(0, data, 'game.dsk');
  });

  it('disk loaded into unit B does NOT update "last file" (only unit A)', () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    parseDSK.mockReturnValue({ tracks: [] });
    mm.loadDisk(sp as any, new Uint8Array(), 'b.dsk', 1, cb);
    expect(persistLastFile).not.toHaveBeenCalled();
    expect(persistDisk).toHaveBeenCalledWith(1, expect.any(Uint8Array), 'b.dsk');
  });

  it('parse error surfaces via onStatus and does NOT touch the spectrum/persistence', () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    parseDSK.mockImplementation(() => { throw new Error('corrupt'); });

    mm.loadDisk(sp as any, new Uint8Array(), 'game.dsk', 0, cb);

    expect(cb.onStatus).toHaveBeenCalledWith('DSK error: corrupt');
    expect(cb.onDiskLoaded).not.toHaveBeenCalled();
    expect(sp.loadDisk).not.toHaveBeenCalled();
    expect(persistLastFile).not.toHaveBeenCalled();
    expect(persistDisk).not.toHaveBeenCalled();
  });

  // Suspect behaviour worth flagging: loadDisk does NOT call spectrum.stop()
  // before swapping the image — unlike applyTape/applySnapshot. If the FDC is
  // mid-operation, the swap could land in a weird state.
  it('does NOT stop the machine before loading (inconsistent with tape/snapshot paths)', () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    parseDSK.mockReturnValue({ tracks: [] });
    mm.loadDisk(sp as any, new Uint8Array(), 'g.dsk', 0, cb);
    expect(sp.stop).not.toHaveBeenCalled();
    expect(sp.start).not.toHaveBeenCalled();
  });

  it('uses "B" label when unit aliases 2/3 — flagged as wrong by spec', () => {
    // On the +3, units 2/3 alias to physical A/B. The label-deriving code
    // (`unit === 0 ? 'A' : 'B'`) silently calls everything not-0 "B", which
    // mislabels unit 2 (should be A). Test pinned to current behaviour.
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    parseDSK.mockReturnValue({});
    mm.loadDisk(sp as any, new Uint8Array(), 'x.dsk', 2, cb);
    expect(cb.onStatus).toHaveBeenCalledWith('Disk B: loaded: x.dsk');
  });
});

// ── applySnapshot — ROM upgrade gating ──────────────────────────────────

describe('applySnapshot — SNA', () => {
  it('48K SNA on a 48K machine: stop → reset → load → start', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    loadSNA.mockReturnValue({ is128K: false, borderColor: 3 });

    const ok = await mm.applySnapshot(sp as any, new Uint8Array(49179), 'g.sna', '48k', cb);

    expect(ok).toBe(true);
    expect(sp.stop).toHaveBeenCalled();
    expect(sp.reset).toHaveBeenCalled();
    expect(loadSNA).toHaveBeenCalledTimes(1);
    expect(sp.start).toHaveBeenCalled();
    expect(sp.ula.borderColor).toBe(3);
    expect(cb.unpause).toHaveBeenCalled();
  });

  it('128K SNA on 48K triggers ensure128kROM and aborts when it declines', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    cb.ensure128kROM = vi.fn(async () => false);

    const ok = await mm.applySnapshot(sp as any, new Uint8Array(49180), 'g.sna', '48k', cb);

    expect(ok).toBe(false);
    expect(cb.ensure128kROM).toHaveBeenCalled();
    expect(loadSNA).not.toHaveBeenCalled();
    expect(cb.onStatus).toHaveBeenCalledWith('128K SNA requires a 128K ROM — load one first');
  });

  it('128K SNA on 128K skips the ensure prompt', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    loadSNA.mockReturnValue({ is128K: true, borderColor: 0 });

    await mm.applySnapshot(sp as any, new Uint8Array(131103), 'g.sna', '128k', cb);

    expect(cb.ensure128kROM).not.toHaveBeenCalled();
    expect(loadSNA).toHaveBeenCalledTimes(1);
  });

  it('SNA uses file SIZE (49179 threshold) as the 128K heuristic — boundary check', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    loadSNA.mockReturnValue({ is128K: false, borderColor: 0 });

    // Exactly 49179 → 48K path (NOT > 49179)
    await mm.applySnapshot(sp as any, new Uint8Array(49179), 'a.sna', '48k', cb);
    expect(cb.ensure128kROM).not.toHaveBeenCalled();

    // 49180 → 128K path
    cb.ensure128kROM = vi.fn(async () => true);
    await mm.applySnapshot(sp as any, new Uint8Array(49180), 'b.sna', '48k', cb);
    expect(cb.ensure128kROM).toHaveBeenCalled();
  });
});

describe('applySnapshot — Z80', () => {
  it('48K Z80 on 48K: one load, no upgrade', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    loadZ80.mockReturnValue({ is128K: false, borderColor: 1 });
    const ok = await mm.applySnapshot(sp as any, new Uint8Array(), 'a.z80', '48k', cb);
    expect(ok).toBe(true);
    expect(loadZ80).toHaveBeenCalledTimes(1);
    expect(cb.ensure128kROM).not.toHaveBeenCalled();
  });

  it('128K Z80 on 48K: double-load after ROM upgrade', async () => {
    // The parser is called once to read the header, then again after
    // reset() wipes state. Pin that contract — if someone collapses to a
    // single call, the post-reset memory will silently retain reset defaults.
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    loadZ80.mockReturnValue({ is128K: true, borderColor: 0 });

    const ok = await mm.applySnapshot(sp as any, new Uint8Array(), 'a.z80', '48k', cb);

    expect(ok).toBe(true);
    expect(cb.ensure128kROM).toHaveBeenCalled();
    expect(loadZ80).toHaveBeenCalledTimes(2);
    expect(sp.reset).toHaveBeenCalledTimes(2);
  });

  it('128K Z80 on 48K with declined ROM: aborts without second load', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    cb.ensure128kROM = vi.fn(async () => false);
    loadZ80.mockReturnValue({ is128K: true, borderColor: 0 });

    const ok = await mm.applySnapshot(sp as any, new Uint8Array(), 'a.z80', '48k', cb);

    expect(ok).toBe(false);
    expect(loadZ80).toHaveBeenCalledTimes(1);
    expect(cb.unpause).not.toHaveBeenCalled();
  });
});

describe('applySnapshot — SZX paging restoration', () => {
  it('128K SZX on 128K applies port7FFD paging + ROM bit', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    loadSZX.mockResolvedValue({
      is128K: true, borderColor: 0,
      port7FFD: 0x37, // bank 7, ROM 1, paging locked
      port1FFD: 0,
    });

    await mm.applySnapshot(sp as any, new Uint8Array(), 'a.szx', '128k', cb);

    expect(sp.memory.port7FFD).toBe(0x37);
    expect(sp.memory.currentBank).toBe(7);
    expect(sp.memory.pagingLocked).toBe(true);
    expect(sp.memory.currentROM).toBe(1);
    expect(sp.memory.applyBanking).toHaveBeenCalled();
  });

  it('128K SZX on +2A applies 4-ROM math: (1FFD bit 2 << 1) | (7FFD bit 4)', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    loadSZX.mockResolvedValue({
      is128K: true, borderColor: 0,
      port7FFD: 0x10, // bit 4 set → low ROM bit = 1
      port1FFD: 0x05, // bit 2 set + bit 0 set (special paging)
    });

    await mm.applySnapshot(sp as any, new Uint8Array(), 'a.szx', '+2A', cb);

    expect(sp.memory.port1FFD).toBe(0x05);
    expect(sp.memory.specialPaging).toBe(true);
    expect(sp.memory.currentROM).toBe(3); // (1<<1) | 1
  });

  it('restores AY state when SZX result includes it', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    const regs = new Uint8Array(16);
    loadSZX.mockResolvedValue({
      is128K: true, borderColor: 0, port7FFD: 0, port1FFD: 0,
      ayRegs: regs, ayCurrentReg: 7,
    });

    await mm.applySnapshot(sp as any, new Uint8Array(), 'a.szx', '128k', cb);

    expect(sp.ay.setRegisters).toHaveBeenCalledWith(regs);
    expect(sp.ay.selectedReg).toBe(7);
  });

  it('does NOT restore AY paging when SZX has no AY data (48K snapshot)', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    loadSZX.mockResolvedValue({
      is128K: false, borderColor: 0, port7FFD: 0, port1FFD: 0,
    });

    await mm.applySnapshot(sp as any, new Uint8Array(), 'a.szx', '48k', cb);

    expect(sp.ay.setRegisters).not.toHaveBeenCalled();
    expect(sp.memory.applyBanking).not.toHaveBeenCalled();
  });
});

describe('applySnapshot — SP paging', () => {
  it('128K SP on 128K applies port7FFD + flashState', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    loadSP.mockReturnValue({
      is128K: true, borderColor: 2, flashState: true, port7FFD: 0x23,
    });

    await mm.applySnapshot(sp as any, new Uint8Array(), 'a.sp', '128k', cb);

    expect(sp.memory.port7FFD).toBe(0x23);
    expect(sp.memory.currentBank).toBe(3);
    expect(sp.memory.currentROM).toBe(0);
    expect(sp.ula.flashState).toBe(true);
  });
});

describe('applySnapshot — error handling', () => {
  it('parser throw → onStatus + return false, no unpause', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    loadSNA.mockImplementation(() => { throw new Error('bad header'); });

    const ok = await mm.applySnapshot(sp as any, new Uint8Array(49179), 'g.sna', '48k', cb);

    expect(ok).toBe(false);
    expect(cb.onStatus).toHaveBeenCalledWith('Error: bad header');
    expect(cb.unpause).not.toHaveBeenCalled();
  });

  it('truly unknown extension routed via applySnapshot is reported', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    const ok = await mm.applySnapshot(sp as any, new Uint8Array(), 'a.bin', '48k', cb);
    expect(ok).toBe(false);
    expect(cb.onStatus).toHaveBeenCalledWith('Unknown format: .bin');
  });

  it('loadFile only persists last-file when applySnapshot succeeds', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    loadSNA.mockImplementation(() => { throw new Error('x'); });
    await mm.loadFile(sp as any, new Uint8Array(49179), 'a.sna', '48k', cb);
    expect(persistLastFile).not.toHaveBeenCalled();
  });
});

// ── ZIP handling ────────────────────────────────────────────────────────

describe('loadFile — ZIP', () => {
  it('reports an empty ZIP cleanly', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    unzip.mockResolvedValue([]);

    await mm.loadFile(sp as any, new Uint8Array(), 'pkg.zip', '48k', cb);

    expect(cb.onStatus).toHaveBeenCalledWith('ZIP is empty');
  });

  it('single-entry ZIP auto-loads without showing the picker', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    unzip.mockResolvedValue([{ name: 'g.tap', data: new Uint8Array([1]) }]);
    sp.tape.parseTAP.mockReturnValue([]);

    await mm.loadFile(sp as any, new Uint8Array(), 'pkg.zip', '48k', cb);

    expect(showFilePicker).not.toHaveBeenCalled();
    expect(sp.tape.parseTAP).toHaveBeenCalled();
  });

  it('multi-entry ZIP shows picker and loads the chosen file', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    unzip.mockResolvedValue([
      { name: 'a.tap', data: new Uint8Array([1]) },
      { name: 'b.tap', data: new Uint8Array([2]) },
    ]);
    showFilePicker.mockResolvedValue('b.tap');
    sp.tape.parseTAP.mockReturnValue([]);

    await mm.loadFile(sp as any, new Uint8Array(), 'pkg.zip', '48k', cb);

    expect(showFilePicker).toHaveBeenCalledWith(['a.tap', 'b.tap']);
    expect(sp.tape.parseTAP).toHaveBeenCalledWith(new Uint8Array([2]));
  });

  it('multi-entry ZIP: picker cancelled → status, nothing loaded', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    unzip.mockResolvedValue([
      { name: 'a.tap', data: new Uint8Array() },
      { name: 'b.tap', data: new Uint8Array() },
    ]);
    showFilePicker.mockResolvedValue(null);

    await mm.loadFile(sp as any, new Uint8Array(), 'pkg.zip', '48k', cb);

    expect(cb.onStatus).toHaveBeenCalledWith('No file selected');
    expect(sp.tape.parseTAP).not.toHaveBeenCalled();
  });

  it('reports unzip errors via onStatus', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    unzip.mockRejectedValue(new Error('CRC failed'));

    await mm.loadFile(sp as any, new Uint8Array(), 'pkg.zip', '48k', cb);

    expect(cb.onStatus).toHaveBeenCalledWith('ZIP error: CRC failed');
  });

  it('routes ZIP-of-DSK into the disk path with the original unit', async () => {
    const mm = new MediaManager();
    const sp = makeSpectrum();
    const cb = makeCallbacks();
    unzip.mockResolvedValue([{ name: 'disk.dsk', data: new Uint8Array() }]);
    parseDSK.mockReturnValue({ tracks: [] });

    await mm.loadFile(sp as any, new Uint8Array(), 'pkg.zip', '+3', cb, 1);

    expect(parseDSK).toHaveBeenCalled();
    expect(sp.loadDisk).toHaveBeenCalledWith({ tracks: [] }, 1);
  });
});
