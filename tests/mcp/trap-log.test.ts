/**
 * mcp/traps.ts — trap-log ring buffer cap.
 *
 * A 'log'-mode trap fires on every instruction that passes its PC, so a
 * long run under a log trap appends without bound. The log must cap at
 * 2000 retained lines (dropping the OLDEST), matching the FDC log ring.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { installTrapHook, traps, trapLog, type Trap } from '../../mcp/traps.ts';
import type { Machine } from '../../src/machines/machine.ts';
import { Z80DebugService, type Z80DebugTarget } from '../../src/debug/z80/service.ts';
import { Z80 } from '../../src/cores/z80/core.ts';

/** The trap hook reads CPU state only through the machine's DebugService, so
 *  the fixture is a real Z80 service over a bare CPU — no machine needed. */
function makeSpec(): { spec: Machine; cpu: Z80 } {
  const cpu = new Z80();
  const target = { cpu, memory: { readByte: () => 0 } } as unknown as Z80DebugTarget;
  const spec = {
    descriptor: { cpuFamily: 'z80' },
    cpu,
    services: { debug: new Z80DebugService(target) },
  } as unknown as Machine;
  installTrapHook(spec);
  return { spec, cpu };
}

function logTrap(address: number): Trap {
  const trap: Trap = { address, action: 'log', label: 'test', responses: [] };
  traps.set(address, [trap]);
  return trap;
}

describe('trapLog ring buffer', () => {
  beforeEach(() => {
    traps.clear();
    trapLog.length = 0;
  });

  it('caps at 2000 entries, dropping the oldest lines', () => {
    const { spec, cpu } = makeSpec();
    logTrap(0x8000);

    for (let i = 0; i < 2500; i++) {
      cpu.tStates = i + 1; // each hit's log line carries a distinct T= marker
      spec.onTrap!(0x8000);
    }

    expect(trapLog.length).toBe(2000);
    // The first 500 entries were dropped; the survivors start at hit 501.
    expect(trapLog[0]).toContain('T=501');
    expect(trapLog[1999]).toContain('T=2500');
  });

  it('logs without a cap under 2000 entries', () => {
    const { spec } = makeSpec();
    logTrap(0x8000);

    for (let i = 0; i < 10; i++) spec.onTrap!(0x8000);

    expect(trapLog.length).toBe(10);
  });
});
