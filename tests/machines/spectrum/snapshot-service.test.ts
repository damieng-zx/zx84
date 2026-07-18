/**
 * SpectrumSnapshotService — format apply + the 128K-upgrade gating that used to
 * live in the (now-deleted) MediaManager.applySnapshot. Retargeted at the
 * machine service, keeping the same behavioural expectations, with the loaders
 * mocked so we exercise the service's orchestration (upgrade gating, AY restore,
 * paging) rather than re-test the codecs (those have their own tests).
 *
 * The 128K-upgrade seam changed from an in-place ensure128kROM() rebind to
 * host.requestModel() + a `needsReplay` result: the shell re-dispatches the file
 * to the machine the rebuild produced. So a granted upgrade returns
 * { ok, needsReplay } WITHOUT a second load here (the replay does that).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const loadSNA = vi.fn();
const loadZ80 = vi.fn();
const loadSZX = vi.fn();
const loadSP = vi.fn();

vi.mock('@/machines/spectrum/snapshots/sna.ts', () => ({ loadSNA: (...a: any[]) => loadSNA(...a) }));
vi.mock('@/machines/spectrum/snapshots/z80format.ts', () => ({
  loadZ80: (...a: any[]) => loadZ80(...a), saveZ80: vi.fn(),
}));
vi.mock('@/machines/spectrum/snapshots/szx.ts', async (importOriginal) => ({
  // Keep the real applySZXPaging (the paging-restore logic under test); stub loadSZX/saveSZX.
  ...(await importOriginal<typeof import('@/machines/spectrum/snapshots/szx.ts')>()),
  loadSZX: (...a: any[]) => loadSZX(...a), saveSZX: vi.fn(),
}));
vi.mock('@/machines/spectrum/snapshots/sp.ts', () => ({ loadSP: (...a: any[]) => loadSP(...a) }));

import { Spectrum } from '@/machines/spectrum/spectrum.ts';
import { SpectrumSnapshotService } from '@/machines/spectrum/services/snapshots.ts';
import type { MachineHost } from '@/machines/machine.ts';

function machine(model: '48k' | '128k' | '+2A' = '48k'): Spectrum {
  const s = new Spectrum(model, null);
  s.start = async () => {};   // headless: no AudioContext / rAF
  return s;
}

function svcOf(s: Spectrum, grant: boolean) {
  const calls: { model: string; reason: string }[] = [];
  const host: MachineHost = {
    setStatus: () => {},
    requestModel: async (model, reason) => { calls.push({ model, reason }); return grant; },
    persistMedia: () => {},
  };
  return { svc: new SpectrumSnapshotService(s, () => host), calls };
}

beforeEach(() => vi.clearAllMocks());

describe('SpectrumSnapshotService — SNA', () => {
  it('48K SNA applies directly, sets the border, no host upgrade', async () => {
    const s = machine('48k');
    loadSNA.mockReturnValue({ is128K: false, borderColor: 3 });
    const { svc, calls } = svcOf(s, true);
    const r = await svc.apply(new Uint8Array(49179), 'g.sna');
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(loadSNA).toHaveBeenCalledTimes(1);
    expect(s.ula.borderColor).toBe(3);
    expect(r.message).toMatch(/48K SNA/);
  });

  it('128K SNA (> 49179) on a 48K asks the host and flags needsReplay (no load yet)', async () => {
    const s = machine('48k');
    const { svc, calls } = svcOf(s, true);
    const r = await svc.apply(new Uint8Array(49180), 'g.sna');
    expect(calls).toEqual([{ model: '128k', reason: expect.stringContaining('g.sna') }]);
    expect(r.ok).toBe(true);
    expect(r.needsReplay).toBe(true);
    expect(loadSNA).not.toHaveBeenCalled();   // the replay loads into the new machine
  });

  it('the 49179-byte boundary is the 48K path (NOT > 49179)', async () => {
    const s = machine('48k');
    loadSNA.mockReturnValue({ is128K: false, borderColor: 0 });
    const { svc, calls } = svcOf(s, true);
    await svc.apply(new Uint8Array(49179), 'a.sna');
    expect(calls).toHaveLength(0);
  });

  it('128K SNA on a 48K reports cleanly when the host declines', async () => {
    const s = machine('48k');
    const { svc } = svcOf(s, false);
    const r = await svc.apply(new Uint8Array(49180), 'g.sna');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/128K SNA requires a 128K ROM/);
  });
});

describe('SpectrumSnapshotService — Z80', () => {
  it('48K Z80 on a 48K: one load, no upgrade', async () => {
    const s = machine('48k');
    loadZ80.mockReturnValue({ is128K: false, borderColor: 1 });
    const { svc, calls } = svcOf(s, true);
    const r = await svc.apply(new Uint8Array(), 'a.z80');
    expect(r.ok).toBe(true);
    expect(loadZ80).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0);
  });

  it('128K Z80 on a 48K upgrades → needsReplay (host granted)', async () => {
    const s = machine('48k');
    loadZ80.mockReturnValue({ is128K: true, borderColor: 0 });
    const { svc, calls } = svcOf(s, true);
    const r = await svc.apply(new Uint8Array(), 'a.z80');
    expect(calls).toEqual([{ model: '128k', reason: expect.stringContaining('a.z80') }]);
    expect(r.needsReplay).toBe(true);
  });

  it('128K Z80 on a 48K with a declined upgrade aborts and restarts the machine', async () => {
    const s = machine('48k');
    const startSpy = vi.spyOn(s, 'start');
    loadZ80.mockReturnValue({ is128K: true, borderColor: 0 });
    const { svc } = svcOf(s, false);
    const r = await svc.apply(new Uint8Array(), 'a.z80');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/128K \.z80 snapshot requires a 128K ROM/);
    expect(startSpy).toHaveBeenCalled();   // must be running again after decline
  });

  it('restores AY state (registers + selected reg) when present', async () => {
    const s = machine('48k');
    const regs = new Uint8Array(16).fill(9);
    loadZ80.mockReturnValue({ is128K: false, borderColor: 0, ayRegs: regs, ayCurrentReg: 7 });
    const setRegs = vi.spyOn(s.ay, 'setRegisters');
    const { svc } = svcOf(s, true);
    await svc.apply(new Uint8Array(), 'a.z80');
    expect(setRegs).toHaveBeenCalledWith(regs);
    expect(s.ay.selectedReg).toBe(7);
  });
});

describe('SpectrumSnapshotService — SZX paging', () => {
  it('128K SZX on a 128K applies port7FFD paging + ROM bit', async () => {
    const s = machine('128k');
    loadSZX.mockResolvedValue({ is128K: true, borderColor: 0, port7FFD: 0x37, port1FFD: 0 });
    const { svc } = svcOf(s, true);
    await svc.apply(new Uint8Array(), 'a.szx');
    expect(s.memory.port7FFD).toBe(0x37);
    expect(s.memory.currentBank).toBe(7);
    expect(s.memory.pagingLocked).toBe(true);
    expect(s.memory.currentROM).toBe(1);
  });

  it('128K SZX on a +2A applies the 4-ROM math: (1FFD bit2 << 1) | (7FFD bit4)', async () => {
    const s = machine('+2A');
    loadSZX.mockResolvedValue({ is128K: true, borderColor: 0, port7FFD: 0x10, port1FFD: 0x05 });
    const { svc } = svcOf(s, true);
    await svc.apply(new Uint8Array(), 'a.szx');
    expect(s.memory.port1FFD).toBe(0x05);
    expect(s.memory.specialPaging).toBe(true);
    expect(s.memory.currentROM).toBe(3);   // (1 << 1) | 1
  });
});

describe('SpectrumSnapshotService — SP paging', () => {
  it('128K SP on a 128K applies port7FFD + flashState', async () => {
    const s = machine('128k');
    loadSP.mockReturnValue({ is128K: true, borderColor: 2, flashState: true, port7FFD: 0x23 });
    const { svc } = svcOf(s, true);
    await svc.apply(new Uint8Array(), 'a.sp');
    expect(s.memory.port7FFD).toBe(0x23);
    expect(s.memory.currentBank).toBe(3);
    expect(s.ula.flashState).toBe(true);
  });
});

describe('SpectrumSnapshotService — errors', () => {
  it('a parser throw surfaces as ok:false + an error message', async () => {
    const s = machine('48k');
    loadSNA.mockImplementation(() => { throw new Error('bad header'); });
    const { svc } = svcOf(s, true);
    const r = await svc.apply(new Uint8Array(49179), 'g.sna');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/bad header/);
  });

  it('an unknown extension is rejected', async () => {
    const s = machine('48k');
    const { svc } = svcOf(s, true);
    const r = await svc.apply(new Uint8Array(), 'a.bin');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unknown format/);
  });
});
