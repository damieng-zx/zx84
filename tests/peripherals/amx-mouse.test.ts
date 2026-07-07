/**
 * AMX Mouse — Z80-PIO state machine and movement queueing.
 *
 * The PIO control protocol (Z80-PIO datasheet, Zilog UM008011):
 *   • Bit 0 = 0  → interrupt vector load (top 7 bits, bit 0 forced to 0).
 *   • Bits 3:0 = 1111 → mode-select. If mode 3 (bits 7:6 = 11), the next
 *     byte written is the I/O direction mask.
 *   • Bits 3:0 = 0111 → interrupt-control word. If bit 4 set, the next
 *     byte written is the interrupt mask.
 *
 * Movement injection (drainMovement) is integration-tested via the
 * Spectrum frame loop; here we cover state and pure logic.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AmxMouse } from '@/peripherals/amx-mouse.ts';
import { Z80 } from '@/cores/z80.ts';
import { IOActivity } from '@/spectrum.ts';

/**
 * Build a minimal Z80 ready to service IM 2 interrupts:
 *   • IM 2, IFF1 enabled
 *   • I=0x40 so the vector table lives at 0x4000-0x40FF
 *   • SP=0xFF00 so push16 has room
 *   • Backing 64K RAM with a vector-table entry pointing every vector at 0x8000
 *   • halted=true so drainMovement's CPU loop never tries to decode instructions
 */
function makeCpu(): { cpu: Z80; mem: Uint8Array } {
  const cpu = new Z80();
  const mem = new Uint8Array(0x10000);
  cpu.read8 = (a: number) => mem[a & 0xFFFF];
  cpu.write8 = (a: number, v: number) => { mem[a & 0xFFFF] = v & 0xFF; };
  cpu.iff1 = true;
  cpu.im = 2;
  cpu.i = 0x40;
  cpu.sp = 0xFF00;
  cpu.pc = 0x8000;
  // Vector table entry at 0x4000-0x40FF all points to 0x8000 — interrupt() will
  // read 2 bytes from i:vector regardless of which vector AMX picks.
  for (let v = 0; v < 256; v += 2) {
    mem[0x4000 + v] = 0x00;
    mem[0x4001 + v] = 0x80;
  }
  cpu.halted = true; // critical: drainMovement won't call step() while halted
  return { cpu, mem };
}

describe('AmxMouse — initial state', () => {
  it('defaults: disabled, buttons released, no pending movement, no vectors', () => {
    const m = new AmxMouse();
    expect(m.enabled).toBe(false);
    expect(m.buttons).toBe(0xFF);
    expect(m.dirX).toBe(0);
    expect(m.dirY).toBe(0);
    expect(m.pioVectorA).toBe(0);
    expect(m.pioVectorB).toBe(0);
    expect(m.pendingX).toBe(0);
    expect(m.pendingY).toBe(0);
  });
});

describe('AmxMouse — buttons (active-low: LMB=bit6, MMB=bit5, RMB=bit7)', () => {
  let m: AmxMouse;
  beforeEach(() => { m = new AmxMouse(); });

  it('LMB press clears bit 6', () => {
    m.setButton(0, true);
    expect(m.buttons).toBe(0xFF & ~0x40);
  });
  it('MMB press clears bit 5', () => {
    m.setButton(1, true);
    expect(m.buttons).toBe(0xFF & ~0x20);
  });
  it('RMB press clears bit 7', () => {
    m.setButton(2, true);
    expect(m.buttons).toBe(0xFF & ~0x80);
  });
  it('release restores the bit; unknown buttons ignored', () => {
    m.setButton(0, true);
    m.setButton(2, true);
    expect(m.buttons).toBe(0xFF & ~0xC0);
    m.setButton(0, false);
    expect(m.buttons).toBe(0xFF & ~0x80);
    m.setButton(7, true); // unknown
    expect(m.buttons).toBe(0xFF & ~0x80);
  });
});

describe('AmxMouse — queueMovement', () => {
  it('accumulates signed dx/dy', () => {
    const m = new AmxMouse();
    m.queueMovement(5, -3);
    m.queueMovement(2, 4);
    expect(m.pendingX).toBe(7);
    expect(m.pendingY).toBe(1);
  });
});

describe('AmxMouse — PIO control state machine', () => {
  let m: AmxMouse;
  beforeEach(() => { m = new AmxMouse(); });

  it('interrupt-vector load: bit 0 clear → top 7 bits stored, bit 0 forced 0', () => {
    m.pioControlWrite('A', 0x42); // even — bit 0 clear
    expect(m.pioVectorA).toBe(0x42);
    m.pioControlWrite('A', 0xFE);
    expect(m.pioVectorA).toBe(0xFE);
    // Should not affect port B
    expect(m.pioVectorB).toBe(0);
  });

  it('separate vectors for A and B', () => {
    m.pioControlWrite('A', 0x20);
    m.pioControlWrite('B', 0x40);
    expect(m.pioVectorA).toBe(0x20);
    expect(m.pioVectorB).toBe(0x40);
  });

  it('mode-3 select consumes next write as I/O direction mask', () => {
    // 0xCF = 11_00_1111 → mode-select word, mode 3 (bits 7:6=11)
    m.pioControlWrite('A', 0xCF);
    // The next write is the I/O mask — must NOT be treated as a vector.
    m.pioControlWrite('A', 0xAA);
    expect(m.pioVectorA).toBe(0); // unchanged
    // And state should have returned to normal — next vector write lands.
    m.pioControlWrite('A', 0x10);
    expect(m.pioVectorA).toBe(0x10);
  });

  it('mode-0/1/2 select does NOT consume a follow-up byte', () => {
    // 0x0F = 00_00_1111 → mode 0 select
    m.pioControlWrite('A', 0x0F);
    // Next byte is a fresh vector, not an I/O mask
    m.pioControlWrite('A', 0x80);
    expect(m.pioVectorA).toBe(0x80);
  });

  it('mode-3 select for port B consumes next write as I/O direction mask', () => {
    m.pioControlWrite('B', 0xCF); // mode 3 select for B
    m.pioControlWrite('B', 0xAA); // I/O mask — must NOT be a vector
    expect(m.pioVectorB).toBe(0);
    m.pioControlWrite('B', 0x10);
    expect(m.pioVectorB).toBe(0x10);
  });

  it('other control word (odd bit-0, not mode/int-ctrl nibble) is silently ignored', () => {
    m.pioControlWrite('A', 0x03); // bits 3:0 = 0011 — neither 0x0F nor 0x07
    expect(m.pioVectorA).toBe(0);
    // State remains normal — a vector write lands immediately after.
    m.pioControlWrite('A', 0x20);
    expect(m.pioVectorA).toBe(0x20);
  });

  it('interrupt-control word with bit 4 set consumes next byte as int-mask', () => {
    // 0x17 = ...10111 → int-ctrl + bit 4 set → expect mask byte to follow
    m.pioControlWrite('B', 0x17);
    m.pioControlWrite('B', 0xFF);     // mask byte — must be absorbed
    expect(m.pioVectorB).toBe(0);
    // State returns to normal — vector write lands again.
    m.pioControlWrite('B', 0x22);
    expect(m.pioVectorB).toBe(0x22);
  });

  it('interrupt-control word with bit 4 set for port A consumes next byte as int-mask', () => {
    m.pioControlWrite('A', 0x17); // int-ctrl + bit 4 → expect mask byte on A
    m.pioControlWrite('A', 0xFF); // mask byte — must be absorbed
    expect(m.pioVectorA).toBe(0);
    m.pioControlWrite('A', 0x22);
    expect(m.pioVectorA).toBe(0x22);
  });

  it('interrupt-control word without bit 4 set does NOT consume the next byte', () => {
    m.pioControlWrite('A', 0x07);   // int-ctrl, no mask follow
    m.pioControlWrite('A', 0x80);   // treated as vector
    expect(m.pioVectorA).toBe(0x80);
  });
});

describe('AmxMouse — drainMovement', () => {
  let m: AmxMouse;
  let cpu: Z80;
  let activity: IOActivity;
  const FRAME_LEN = 69888;

  beforeEach(() => {
    m = new AmxMouse();
    cpu = makeCpu().cpu;
    activity = new IOActivity();
    m.pioVectorA = 0x40;
    m.pioVectorB = 0x42;
    // A real Z80 PIO powers up with interrupts disabled; arm both ports via
    // an interrupt control word (D7=1 enable, D3:0=0111, no mask follow).
    m.pioControlWrite('A', 0x87);
    m.pioControlWrite('B', 0x87);
    // iff1 must be re-armed between interrupts — drainMovement relies on the
    // guest's ISR to EI before RETI. In test we just keep it true.
    const realInterrupt = cpu.interruptWithVector.bind(cpu);
    cpu.interruptWithVector = (v: number) => {
      const r = realInterrupt(v);
      cpu.iff1 = true;
      return r;
    };
  });

  it('returns immediately when nothing is queued (no interrupts, no activity)', () => {
    const spy = vi.spyOn(cpu, 'interruptWithVector');
    m.drainMovement(cpu, FRAME_LEN, activity);
    expect(spy).not.toHaveBeenCalled();
    expect(activity.mouseReads).toBe(0);
  });

  it('fires one interrupt per queued X step using the port-A vector', () => {
    m.queueMovement(5, 0);
    const spy = vi.spyOn(cpu, 'interruptWithVector');
    m.drainMovement(cpu, FRAME_LEN, activity);
    expect(spy).toHaveBeenCalledTimes(5);
    for (const call of spy.mock.calls) expect(call[0]).toBe(0x40);
    expect(activity.mouseReads).toBe(5);
  });

  it('fires one interrupt per queued Y step using the port-B vector', () => {
    m.queueMovement(0, -4);
    const spy = vi.spyOn(cpu, 'interruptWithVector');
    m.drainMovement(cpu, FRAME_LEN, activity);
    expect(spy).toHaveBeenCalledTimes(4);
    for (const call of spy.mock.calls) expect(call[0]).toBe(0x42);
    expect(activity.mouseReads).toBe(4);
  });

  it('sets dirX = 0 for positive X (right) and dirX = 1 for negative X (left)', () => {
    m.queueMovement(3, 0);
    m.drainMovement(cpu, FRAME_LEN, activity);
    expect(m.dirX).toBe(0);

    const cpu2 = makeCpu().cpu;
    cpu2.interruptWithVector = (v: number) => { const r = Z80.prototype.interruptWithVector.call(cpu2, v); cpu2.iff1 = true; return r; };
    const m2 = new AmxMouse();
    m2.pioVectorA = 0x40;
    m2.queueMovement(-3, 0);
    m2.drainMovement(cpu2, FRAME_LEN, new IOActivity());
    expect(m2.dirX).toBe(1);
  });

  it('sets dirY = 1 for positive Y (down) and dirY = 0 for negative Y (up)', () => {
    m.queueMovement(0, 3);
    m.drainMovement(cpu, FRAME_LEN, activity);
    expect(m.dirY).toBe(1);

    const cpu2 = makeCpu().cpu;
    cpu2.interruptWithVector = (v: number) => { const r = Z80.prototype.interruptWithVector.call(cpu2, v); cpu2.iff1 = true; return r; };
    const m2 = new AmxMouse();
    m2.pioVectorB = 0x42;
    m2.queueMovement(0, -3);
    m2.drainMovement(cpu2, FRAME_LEN, new IOActivity());
    expect(m2.dirY).toBe(0);
  });

  it('clears pending counters after draining', () => {
    m.queueMovement(7, 3);
    m.drainMovement(cpu, FRAME_LEN, activity);
    expect(m.pendingX).toBe(0);
    expect(m.pendingY).toBe(0);
  });

  it('caps each axis at 200 steps per frame (real mouse upper bound)', () => {
    m.queueMovement(5000, 0);
    const spy = vi.spyOn(cpu, 'interruptWithVector');
    m.drainMovement(cpu, FRAME_LEN, activity);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(200);
    expect(spy.mock.calls.length).toBeGreaterThan(100);
  });

  it('caps Y axis at 200 steps per frame', () => {
    m.queueMovement(0, -5000);
    const spy = vi.spyOn(cpu, 'interruptWithVector');
    m.drainMovement(cpu, FRAME_LEN, activity);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(200);
    expect(spy.mock.calls.length).toBeGreaterThan(100);
    expect(m.dirY).toBe(0); // negative Y → up
  });

  it('interleaves X and Y so both axes drain within one frame', () => {
    m.queueMovement(4, 4);
    const spy = vi.spyOn(cpu, 'interruptWithVector');
    m.drainMovement(cpu, FRAME_LEN, activity);
    const aCount = spy.mock.calls.filter(c => c[0] === 0x40).length;
    const bCount = spy.mock.calls.filter(c => c[0] === 0x42).length;
    expect(aCount).toBe(4);
    expect(bCount).toBe(4);
  });

  it('with interrupts never enabled (real PIO power-up state), movement updates direction but never vectors an interrupt', () => {
    // A fresh AmxMouse (no pioControlWrite arming at all) mirrors a real Z80
    // PIO that has just been reset: INT E/D flip-flops both clear.
    const fresh = new AmxMouse();
    fresh.pioVectorA = 0x40;
    fresh.pioVectorB = 0x42;
    const spy = vi.spyOn(cpu, 'interruptWithVector');
    fresh.queueMovement(3, -2);
    fresh.drainMovement(cpu, FRAME_LEN, activity);
    expect(spy).not.toHaveBeenCalled();
    expect(fresh.dirX).toBe(0); // still updated: positive X → right
    expect(fresh.dirY).toBe(0); // still updated: negative Y → up
    expect(fresh.pendingX).toBe(0);
    expect(fresh.pendingY).toBe(0);
  });

  it('an interrupt control word with D7=0 disables interrupts again', () => {
    m.pioControlWrite('A', 0x07); // D7=0 → disable, no mask follow
    m.queueMovement(3, 0);
    const spy = vi.spyOn(cpu, 'interruptWithVector');
    m.drainMovement(cpu, FRAME_LEN, activity);
    expect(spy).not.toHaveBeenCalled();
    expect(m.dirX).toBe(0);
  });
});

describe('AmxMouse — reset', () => {
  it('clears mutable hardware state, leaves enabled untouched', () => {
    const m = new AmxMouse();
    m.enabled = true;
    m.buttons = 0;
    m.dirX = 1; m.dirY = 1;
    m.pioVectorA = 0x42; m.pioVectorB = 0x22;
    m.queueMovement(50, -50);
    m.pioControlWrite('A', 0xCF); // park in await_io

    m.reset();
    expect(m.enabled).toBe(true);
    expect(m.buttons).toBe(0xFF);
    expect(m.dirX).toBe(0);
    expect(m.dirY).toBe(0);
    expect(m.pioVectorA).toBe(0);
    expect(m.pioVectorB).toBe(0);
    expect(m.pendingX).toBe(0);
    expect(m.pendingY).toBe(0);

    // Post-reset the state machine is back to 'normal' — a vector write lands.
    m.pioControlWrite('A', 0x40);
    expect(m.pioVectorA).toBe(0x40);
  });
});
