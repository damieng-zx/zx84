/**
 * MOS 6522 VIA tests. Expectations come from the 6522 datasheet (port masking,
 * timer underflow behaviour, IFR/IER semantics).
 */

import { describe, it, expect } from 'vitest';
import {
  M6522, VIA_IFR_T1, VIA_IFR_T2, VIA_IFR_CA1, VIA_IFR_ANY,
} from '@/cores/m6522.ts';

describe('m6522 — ports', () => {
  it('masks input bits by the data-direction register', () => {
    const via = new M6522();
    via.write(3, 0xF0);        // DDRA: high nibble outputs
    via.write(1, 0x5A);        // ORA output register
    via.portAInput = 0x3C;     // external pins
    // Outputs come from ORA, inputs from the pins.
    expect(via.read(1)).toBe((0x5A & 0xF0) | (0x3C & 0x0F));
  });

  it('reports the output register via the write callback', () => {
    const via = new M6522();
    let seen = -1;
    via.onPortBWrite = (v) => { seen = v; };
    via.write(0, 0xA5);
    expect(seen).toBe(0xA5);
    expect(via.orb).toBe(0xA5);
  });
});

describe('m6522 — T1 timer', () => {
  it('one-shot sets the flag on underflow', () => {
    const via = new M6522();
    via.write(4, 0x05);        // latch low = 5
    via.write(5, 0x00);        // start; counter = 5
    via.addCycles(5);
    expect(via.ifr & VIA_IFR_T1).toBe(0); // 5 cycles: counter reaches 0
    via.addCycles(1);
    expect(via.ifr & VIA_IFR_T1).toBe(VIA_IFR_T1);
  });

  it('reading T1C-L clears the T1 flag', () => {
    const via = new M6522();
    via.write(4, 0x02);
    via.write(5, 0x00);
    via.addCycles(3);
    expect(via.ifr & VIA_IFR_T1).toBe(VIA_IFR_T1);
    via.read(4);
    expect(via.ifr & VIA_IFR_T1).toBe(0);
  });

  it('free-run reloads from the latch each period', () => {
    const via = new M6522();
    via.write(11, 0x40);       // ACR: T1 free-run
    via.write(4, 0x05);        // period = latch + 1 = 6 cycles
    via.write(5, 0x00);
    via.addCycles(12);         // exactly two periods
    expect(via.ifr & VIA_IFR_T1).toBe(VIA_IFR_T1);
    expect(via.t1Counter).toBe(5);
    via.addCycles(4);
    expect(via.t1Counter).toBe(1);
  });
});

describe('m6522 — T2 timer', () => {
  it('sets the flag on underflow and does not reload', () => {
    const via = new M6522();
    via.write(8, 0x04);        // latch low = 4
    via.write(9, 0x00);        // start; counter = 4
    via.addCycles(4);
    expect(via.ifr & VIA_IFR_T2).toBe(0);
    via.addCycles(1);
    expect(via.ifr & VIA_IFR_T2).toBe(VIA_IFR_T2);
    expect(via.t2Counter).toBe(0xFFFF);
  });
});

describe('m6522 — interrupts', () => {
  it('masks IFR by IER to produce IRQ', () => {
    const via = new M6522();
    via.write(14, VIA_IFR_ANY | VIA_IFR_T1); // enable T1
    expect(via.ier).toBe(VIA_IFR_T1);
    expect(via.irq).toBe(false);

    via.write(4, 0x01);
    via.write(5, 0x00);
    via.addCycles(2);
    expect(via.ifr & VIA_IFR_T1).toBe(VIA_IFR_T1);
    expect(via.irq).toBe(true);
  });

  it('writing IER with bit 7 clear disables the bits', () => {
    const via = new M6522();
    via.write(14, VIA_IFR_ANY | VIA_IFR_T1);
    via.write(14, 0x00 | VIA_IFR_T1); // bit 7 clear => clear T1 enable
    expect(via.ier & VIA_IFR_T1).toBe(0);
    expect(via.read(14) & VIA_IFR_ANY).toBe(0);
  });

  it('CA1 negative edge sets the flag by default', () => {
    const via = new M6522();
    via.setCA1(true);          // PCR=0 selects negative edge: no flag
    expect(via.ifr & VIA_IFR_CA1).toBe(0);
    via.setCA1(false);         // negative edge
    expect(via.ifr & VIA_IFR_CA1).toBe(VIA_IFR_CA1);
  });

  it('writing port A preserves the CA1/CA2 flags (only a read clears them)', () => {
    const via = new M6522();
    via.setCA1(true);
    via.setCA1(false);         // set the CA1 flag
    expect(via.ifr & VIA_IFR_CA1).toBe(VIA_IFR_CA1);
    via.write(15, 0x00);       // write ORA no-handshake
    expect(via.ifr & VIA_IFR_CA1).toBe(VIA_IFR_CA1);
    via.read(1);               // read ORA clears the flags
    expect(via.ifr & VIA_IFR_CA1).toBe(0);
  });
});
