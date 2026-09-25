/**
 * The Lynx's Z80 clock. MAME camplynx.cpp derives both from the 24MHz
 * crystal: 24MHz / 6 = 4MHz on the 48K and 96K, 24MHz / 4 = 6MHz on the 128K.
 */

import { describe, it, expect } from 'vitest';
import { LynxMachine } from '@/machines/lynx/lynx-machine.ts';
import { TAPE_REF_HZ } from '@/media/tape/tap.ts';
import type { LynxModel } from '@/machines/lynx/models.ts';

function machine(model: LynxModel): LynxMachine {
  const m = new LynxMachine(model, null);
  m.loadROM(new Uint8Array(0x8000));
  m.reset();
  return m;
}

describe('Lynx CPU clock', () => {
  it.each([
    ['lynx48', 4_000_000, 80_000],
    ['lynx96', 4_000_000, 80_000],
    ['lynx128', 6_000_000, 120_000],
  ] as const)('%s runs at %i Hz, %i T-states per 50Hz frame', (model, hz, perFrame) => {
    const m = machine(model);
    expect(m.cpuClockHz).toBe(hz);
    expect(m.tStatesPerFrame).toBe(perFrame);
    // Tape pulses stay in real time: scaled from the 3.5MHz reference.
    expect(m.tape.pulseScale).toBeCloseTo(hz / TAPE_REF_HZ, 12);
  });

  it('executes a whole 6MHz frame per tick on the 128K', () => {
    const m = machine('lynx128');   // ROM of NOPs
    const start = m.cpu.tStates;
    m.tick();
    const ran = m.cpu.tStates - start;
    expect(ran).toBeGreaterThanOrEqual(120_000);
    expect(ran).toBeLessThan(120_000 + 32);
  });
});
