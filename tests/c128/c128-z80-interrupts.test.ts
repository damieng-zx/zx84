/**
 * The Z80's interrupts in the interrupt log, beside the 8502's: the one IRQ
 * line it has (the VIC-IIe's and CIA 1's), entered at $0038 in mode 1 and paired
 * with its RETI by the stack depth.
 */

import { describe, it, expect } from 'vitest';
import { C128Machine } from '@/machines/c128/c128-machine.ts';
import { BeamLog, BEAM_IRQ, type BeamEntry } from '@/debug/beam-log.ts';

function entries(log: BeamLog): BeamEntry[] {
  const out: BeamEntry[] = [];
  for (let i = 0; i < log.length; i++) if (log.get(i).kind === BEAM_IRQ) out.push(log.get(i));
  return out;
}

/** A machine whose Z80 BIOS sets IM 1, enables interrupts and idles; its handler at $0038 is `INC HL; EI; RETI`. */
function z80Idle(): C128Machine {
  const kernal = new Uint8Array(0x4000);
  const at = 0x1000;
  kernal.set([0x31, 0x00, 0x30, 0xED, 0x56, 0xFB, 0x18, 0xFE], at);               // LD SP,$3000 : IM 1 : EI : JR $
  kernal.set([0x23, 0xFB, 0xED, 0x4D], at + 0x38);                                 // INC HL : EI : RETI
  const m = new C128Machine(null);
  m.loadRoms(null, null, kernal, null);
  m.reset();
  return m;
}

describe('the Z80 in the interrupt log', () => {
  it('logs an interrupt at $0038 with the address it returns to, and where it ends', () => {
    const m = z80Idle();
    m.beamLog = new BeamLog();
    m.interruptLogging = true;
    // A raster interrupt on line 100.
    m.vic.write(0xD012, 100, 0);
    m.vic.write(0xD01A, 1, 0);
    for (let i = 0; i < 3; i++) m.tick();
    expect(m.cpuIs8502, 'still the Z80').toBe(false);
    const irq = entries(m.beamLog);
    expect(irq.length).toBeGreaterThanOrEqual(2);
    const [enter, end] = irq;
    expect(enter.flags & 1, 'not an NMI').toBe(0);
    expect(enter.flags & 2, 'an entry').toBe(0);
    expect(enter.addr).toBe(0x0038);
    expect(enter.pc, 'it came from the idle loop').toBe(0x0006);
    expect(end.flags & 2, 'an end').toBe(2);
    m.destroy();
  });
});
