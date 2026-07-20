/**
 * Asic — Phase 1 skeleton (locked mode).
 *
 * In locked mode the ASIC must be indistinguishable from a discrete 40010 gate
 * array: every GA command byte (pen select, colour set, RMR mode/rom, RAM
 * config) and every HSYNC-driven raster-interrupt tick must produce identical
 * observable state. These tests assert that equivalence directly, by feeding
 * the same byte sequence to a `GateArray` and an `Asic` and comparing state —
 * so a future override that accidentally breaks locked-mode parity fails here.
 *
 * Reset must re-lock the ASIC (Phase 2's unlock sequence must be reversible).
 */

import { describe, it, expect } from 'vitest';
import { GateArray } from '@/machines/cpc/gate-array.ts';
import { Asic } from '@/machines/cpc/asic.ts';
import { CpcMachine } from '@/machines/cpc/cpc-machine.ts';

describe('Asic Phase 1 skeleton (locked-mode GA parity)', () => {
  it('constructs locked', () => {
    const a = new Asic();
    expect(a.locked).toBe(true);
  });

  it('reset re-locks the ASIC', () => {
    const a = new Asic();
    a.locked = false;       // simulate a future unlock
    a.reset();
    expect(a.locked).toBe(true);
  });

  it('matches GateArray state after a representative command stream', () => {
    // Drive both chips through the same sequence: pick pens, set colours,
    // toggle ROM enables, change mode, reset the raster counter, and step
    // a few HSYNCs. After every step the observable state must match exactly.
    const ga = new GateArray();
    const asic = new Asic();

    const sequence = [
      0x10,        // select pen 16 (border)
      0x54,        // set colour 0x14 (hardware value)
      0x00,        // select pen 0
      0x4F,        // set colour 0x0F
      0x05,        // select pen 5
      0x47,        // set colour 0x07
      0x8C,        // RMR: mode 0, lower ROM off, upper ROM on, clear raster IRQ
      0x89,        // RMR: mode 1, lower ROM on, upper ROM on
      0xC2,        // RAM config 2 (expansion banks)
      0xC7,        // RAM config 7
    ];

    const snapshot = (c: GateArray) => ({
      pens: Array.from(c.pens),
      mode: c.mode,
      selectedPen: c.selectedPenIndex,
      interruptRequested: c.interruptRequested,
    });

    for (const b of sequence) {
      ga.write(b);
      asic.write(b);
      expect(snapshot(asic)).toEqual(snapshot(ga));
    }
  });

  it('matches GateArray raster-interrupt cadence (52-HSYNC flyback)', () => {
    // The GA raises INT every 52 HSYNCs; the locked ASIC must do the same
    // at the same count, otherwise a CPC boot would mistime its vsync poll.
    const ga = new GateArray();
    const asic = new Asic();

    // Run 51 HSYNCs — no interrupt yet.
    for (let i = 0; i < 51; i++) { ga.onHSync(); asic.onHSync(); }
    expect(ga.interruptRequested).toBe(false);
    expect(asic.interruptRequested).toBe(false);

    // 52nd HSYNC raises the interrupt on both.
    ga.onHSync(); asic.onHSync();
    expect(ga.interruptRequested).toBe(true);
    expect(asic.interruptRequested).toBe(true);

    // Ack clears it on both.
    ga.acknowledgeInterrupt(); asic.acknowledgeInterrupt();
    expect(ga.interruptRequested).toBe(false);
    expect(asic.interruptRequested).toBe(false);
  });
});

describe('CpcMachine Plus integration (Phase 1 smoke)', () => {
  // The CpcMachine constructor must pick the ASIC subclass for Plus models
  // and the discrete GA for non-Plus. Phase 1's contract is "a Plus machine
  // boots identically to a 6128" — the ASIC arrives locked, so a single
  // tick must complete without touching any Plus-specific code path.
  it('instantiates an Asic for cpc6128plus', () => {
    const m = new CpcMachine('cpc6128plus', null);
    expect(m.gateArray).toBeInstanceOf(Asic);
    expect(m.config.isPlus).toBe(true);
    expect(m.config.crtcType).toBe(4);
  });

  it('instantiates an Asic for gx4000', () => {
    const m = new CpcMachine('gx4000', null);
    expect(m.gateArray).toBeInstanceOf(Asic);
  });

  it('keeps the discrete GateArray on a non-Plus model', () => {
    const m = new CpcMachine('cpc6128', null);
    expect(m.gateArray).toBeInstanceOf(GateArray);
    expect(m.gateArray).not.toBeInstanceOf(Asic);
  });

  it('ticks one frame without throwing on a Plus model (locked ASIC path)', () => {
    const m = new CpcMachine('cpc6128plus', null);
    // No ROM loaded — the CPU executes 0xFF (RST 38h) bytes into the interrupt
    // vector. The point of this test is just that the per-scanline loop and the
    // Asic's locked-mode render path complete a frame without crashing.
    expect(() => m.tick()).not.toThrow();
  });
});
