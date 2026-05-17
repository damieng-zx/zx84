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

import { describe, it, expect, beforeEach } from 'vitest';
import { AmxMouse } from '@/peripherals/amx-mouse.ts';

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

  it('interrupt-control word with bit 4 set consumes next byte as int-mask', () => {
    // 0x17 = ...10111 → int-ctrl + bit 4 set → expect mask byte to follow
    m.pioControlWrite('B', 0x17);
    m.pioControlWrite('B', 0xFF);     // mask byte — must be absorbed
    expect(m.pioVectorB).toBe(0);
    // State returns to normal — vector write lands again.
    m.pioControlWrite('B', 0x22);
    expect(m.pioVectorB).toBe(0x22);
  });

  it('interrupt-control word without bit 4 set does NOT consume the next byte', () => {
    m.pioControlWrite('A', 0x07);   // int-ctrl, no mask follow
    m.pioControlWrite('A', 0x80);   // treated as vector
    expect(m.pioVectorA).toBe(0x80);
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
