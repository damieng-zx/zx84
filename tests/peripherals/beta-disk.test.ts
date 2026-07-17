import { describe, it, expect } from 'vitest';
import { BetaDisk } from '@/machines/spectrum/peripherals/beta-disk.ts';
import type { SpectrumMemory } from '@/machines/spectrum/memory.ts';

/** Minimal memory stub exercising only what BetaDisk.checkPage/pageIn touch. */
function fakeMemory(basicActive: boolean) {
  return {
    basicActive,
    setSlot0Calls: 0,
    restoreSlot0Calls: 0,
    isBasicRomActive() { return this.basicActive; },
    setSlot0() { this.setSlot0Calls++; },
    restoreSlot0() { this.restoreSlot0Calls++; },
  };
}

function armedBeta(): BetaDisk {
  const beta = new BetaDisk();
  beta.enabled = true;
  beta.loadROM(new Uint8Array(16384).fill(0xC9)); // romLoaded = true
  return beta;
}

describe('BetaDisk automatic paging', () => {
  it('pages IN on an M1 fetch in 0x3Dxx while the 48K BASIC ROM is active', () => {
    const beta = armedBeta();
    const mem = fakeMemory(true);
    beta.checkPage(0x3D00, mem as unknown as SpectrumMemory);
    expect(beta.pagedIn).toBe(true);
    expect(mem.setSlot0Calls).toBe(1);
  });

  it('does NOT page in at 0x3Dxx when the BASIC ROM is not active', () => {
    const beta = armedBeta();
    const mem = fakeMemory(false);
    beta.checkPage(0x3D80, mem as unknown as SpectrumMemory);
    expect(beta.pagedIn).toBe(false);
    expect(mem.setSlot0Calls).toBe(0);
  });

  it('stays paged in while execution is below 0x4000', () => {
    const beta = armedBeta();
    const mem = fakeMemory(true);
    beta.checkPage(0x3D00, mem as unknown as SpectrumMemory);
    beta.checkPage(0x3D50, mem as unknown as SpectrumMemory);
    beta.checkPage(0x1234, mem as unknown as SpectrumMemory);
    expect(beta.pagedIn).toBe(true);
    expect(mem.restoreSlot0Calls).toBe(0);
  });

  it('pages OUT on an M1 fetch at >= 0x4000', () => {
    const beta = armedBeta();
    const mem = fakeMemory(true);
    beta.checkPage(0x3D00, mem as unknown as SpectrumMemory);
    beta.checkPage(0x4000, mem as unknown as SpectrumMemory);
    expect(beta.pagedIn).toBe(false);
    expect(mem.restoreSlot0Calls).toBe(1);
  });

  it('does nothing until the ROM is loaded', () => {
    const beta = new BetaDisk();
    beta.enabled = true; // but no ROM
    const mem = fakeMemory(true);
    beta.checkPage(0x3D00, mem as unknown as SpectrumMemory);
    expect(beta.pagedIn).toBe(false);
  });
});

describe('BetaDisk port decode', () => {
  it('matches no port until paged in, then the five TR-DOS ports', () => {
    const beta = armedBeta();
    const ports = [0x1F, 0x3F, 0x5F, 0x7F, 0xFF];
    for (const p of ports) expect(beta.matchPort(p)).toBe(false); // not paged in
    beta.pageIn(fakeMemory(true) as unknown as SpectrumMemory);
    for (const p of ports) expect(beta.matchPort(p)).toBe(true);
    // High byte is ignored; a non-TR-DOS low byte is rejected.
    expect(beta.matchPort(0x12FF)).toBe(true);  // low byte 0xFF
    expect(beta.matchPort(0xFE)).toBe(false);   // keyboard/ULA — not ours
    expect(beta.matchPort(0x2F)).toBe(false);
  });
});

describe('BetaDisk system register (port 0xFF)', () => {
  // Bit semantics verified against Fuse beta.c: b0-1 drive, b4 side (INVERTED —
  // bit set = side 0), b5 density, b3 HLT; there is no reset bit.
  it('selects the drive (b0-1) and side (b4 inverted)', () => {
    const beta = armedBeta();
    beta.pageIn(fakeMemory(true) as unknown as SpectrumMemory);
    // Bit 4 set → side 0.
    beta.writePort(0xFF, 0x01 | 0x10);
    expect(beta.fdc.currentDrive).toBe(1);
    expect(beta.fdc.side).toBe(0);
    // Bit 4 clear → side 1.
    beta.writePort(0xFF, 0x00);
    expect(beta.fdc.currentDrive).toBe(0);
    expect(beta.fdc.side).toBe(1);
  });

  it('decodes 0x3C the way TR-DOS reads its catalog: drive 0, side 0', () => {
    // 0x3C = TR-DOS's "select drive 0, side 0" for the track-0 catalog read.
    // Getting the inverted side bit wrong here made CAT fail with "disk error".
    const beta = armedBeta();
    beta.pageIn(fakeMemory(true) as unknown as SpectrumMemory);
    beta.writePort(0xFF, 0x3C);
    expect(beta.fdc.currentDrive).toBe(0);
    expect(beta.fdc.side).toBe(0);
  });

  it('does not reset the controller on a system-port write (no reset bit)', () => {
    const beta = armedBeta();
    beta.pageIn(fakeMemory(true) as unknown as SpectrumMemory);
    beta.fdc.writeData(20);
    beta.fdc.writeCommand(0x10); // SEEK to 20
    expect(beta.fdc.getUnitTrack(0)).toBe(20);
    beta.writePort(0xFF, 0x00);  // must NOT reset the head position
    expect(beta.fdc.getUnitTrack(0)).toBe(20);
  });

  it('read reflects INTRQ (bit 7) and DRQ (bit 6)', () => {
    const beta = armedBeta();
    beta.pageIn(fakeMemory(true) as unknown as SpectrumMemory);
    // No command issued: not busy → INTRQ set, DRQ clear.
    expect(beta.readPort(0xFF) & 0x80).toBe(0x80);
    expect(beta.readPort(0xFF) & 0x40).toBe(0);
  });
});
