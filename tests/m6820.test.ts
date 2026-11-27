/**
 * MC6820/6821 PIA: register selection, DDR/data switching, the interrupt
 * flags and the C2 handshake modes.
 *
 * Expectations come from the 6820/6821 register model (the two parts differ
 * only in their output stage): CR2 selects the DDR or the peripheral register,
 * a data read clears both C1/C2 flags, a C1/C2 flag is set on the selected
 * transition, and an enabled flag pulls /IRQ low. The Atari 8-bit runs the
 * machine-level cases through this same core; see `tests/atari/pia.test.ts`.
 */

import { describe, it, expect } from 'vitest';
import { M6820, PIA_CR_IRQ1, PIA_CR_IRQ2 } from '@/cores/m6820.ts';

describe('M6820 data registers', () => {
  it('selects the DDR while CR2 is clear, and the port when it is set', () => {
    const pia = new M6820();
    pia.write(1, 0x00);              // DDR access
    pia.write(0, 0x0f);              // low nibble outputs
    expect(pia.ddr[0]).toBe(0x0f);
    expect(pia.read(0)).toBe(0x0f);  // still reading the DDR

    pia.write(1, 0x04);              // peripheral register
    pia.write(0, 0xaa);
    pia.portAInput = 0x55;
    // Driven bits come from the latch, the rest from the pins.
    expect(pia.read(0)).toBe((0xaa & 0x0f) | (0x55 & 0xf0));
  });

  it('fires the output callback when a peripheral register is written', () => {
    const pia = new M6820();
    const seen: number[] = [];
    pia.onPortAWrite = () => seen.push(0);
    pia.onPortBWrite = () => seen.push(1);
    pia.write(1, 0x04);
    pia.write(0, 0x12);
    pia.write(3, 0x04);
    pia.write(2, 0x34);
    expect(seen).toEqual([0, 1]);
  });
});

describe('M6820 interrupts', () => {
  it('sets CA1 on the selected edge and clears it when the data register is read', () => {
    const pia = new M6820();
    pia.write(1, 0x04);              // peripheral register, C1 disabled
    pia.setCA1(true);                // line starts high: no transition
    expect(pia.cra & PIA_CR_IRQ1).toBe(0);
    pia.setCA1(true);                // still high: no edge either
    expect(pia.cra & PIA_CR_IRQ1).toBe(0);
    expect(pia.irq).toBe(false);

    pia.setCA1(false);               // falling edge sets the flag
    expect(pia.cra & PIA_CR_IRQ1).toBe(PIA_CR_IRQ1);
    expect(pia.irq).toBe(false);    // still disabled

    pia.write(1, 0x05);              // enable C1
    expect(pia.irq).toBe(true);
    pia.read(0);                     // reading the port clears the flag
    expect(pia.cra & PIA_CR_IRQ1).toBe(0);
    expect(pia.irq).toBe(false);
  });

  it('honours the C1 rising-edge select', () => {
    const pia = new M6820();
    pia.write(1, 0x07);              // peripheral register + enable + rising
    pia.setCA1(false);               // falling: not the selected edge
    expect(pia.cra & PIA_CR_IRQ1).toBe(0);
    pia.setCA1(true);
    expect(pia.cra & PIA_CR_IRQ1).toBe(PIA_CR_IRQ1);
    expect(pia.irq).toBe(true);
  });

  it('sets the C2 flag only while C2 is configured as an input', () => {
    const pia = new M6820();
    // CRA: bit 5 selects the C2 direction, bit 4 the input transition, bit 3
    // the C2 interrupt enable, bit 2 the data register. An input with the
    // rising edge selected and C2's interrupt enabled is $1C.
    pia.write(1, 0x1c);
    pia.setCA2(false);               // falling: not selected
    expect(pia.cra & PIA_CR_IRQ2, 'the falling edge is not the active one').toBe(0);
    pia.setCA2(true);                // rising: the active edge
    expect(pia.cra & PIA_CR_IRQ2, 'the rising edge sets the flag').toBe(PIA_CR_IRQ2);
    expect(pia.irq, 'the flag is enabled').toBe(true);
    pia.read(0);                     // clear the flags
    expect(pia.irq).toBe(false);
    pia.setCA2(false);

    // Bit 5 set makes C2 an output, and then the C2 input is ignored.
    pia.write(1, 0x24);              // C2 output (bit 5), bit 4 clear
    pia.setCA2(false);
    pia.setCA2(true);
    expect(pia.cra & PIA_CR_IRQ2, 'an output C2 raises no flag').toBe(0);
  });

  it('reads bit 5 as the C2 direction and bit 4 as its edge select', () => {
    // This pair is the one that is easy to get backwards, so it is pinned
    // directly: the datasheet numbers bit 5 "C2 direction" and bit 4 "C2
    // transition".
    const pia = new M6820();
    pia.write(1, 0x20);                        // bit 5: C2 output
    pia.setCA2(false);                         // an output ignores its input
    pia.setCA2(true);
    expect(pia.cra & PIA_CR_IRQ2, 'an output C2 raises no flag').toBe(0);

    // Bit 5 clear makes C2 an input; bit 4 then selects its active edge.
    pia.write(1, 0x10);                        // input, rising selected
    pia.setCA2(false);                         // falling: not the active edge
    expect(pia.cra & PIA_CR_IRQ2, 'bit 4 set: only the rising edge').toBe(0);
    pia.setCA2(true);                          // rising: the active edge
    expect(pia.cra & PIA_CR_IRQ2, 'bit 4 set selects the rising edge').toBe(PIA_CR_IRQ2);

    pia.write(1, 0x00);                        // bit 4 clear: falling selected
    pia.read(0);                               // clear the flag
    pia.setCA2(false);
    expect(pia.cra & PIA_CR_IRQ2, 'bit 4 clear selects the falling edge').toBe(PIA_CR_IRQ2);
  });

  it('reset clears registers, direction and flags', () => {
    const pia = new M6820();
    pia.write(1, 0x07);
    pia.write(0, 0xaa);
    pia.setCA1(true);
    pia.reset();
    expect(pia.ddr[0]).toBe(0);
    expect(pia.out[0]).toBe(0);
    expect(pia.cr[0]).toBe(0);
    expect(pia.read(1)).toBe(0);
    expect(pia.irq).toBe(false);
  });
});

describe('M6820 C2 output', () => {
  it('holds C2 at the level of CR bit 3 in manual mode', () => {
    const pia = new M6820();
    const levels: boolean[] = [];
    pia.onCa2Change = l => levels.push(l);
    pia.write(1, 0x30);                        // manual, low
    expect(pia.ca2).toBe(false);
    pia.write(1, 0x38);                        // manual, high
    expect(pia.ca2).toBe(true);
    expect(levels).toEqual([false, true]);
  });

  it('drops CB2 on an output register write and restores it on the next C1 edge (handshake)', () => {
    const pia = new M6820();
    pia.write(3, 0x26);                        // C2 handshake, rising C1, data selected
    expect(pia.cb2).toBe(true);
    pia.write(2, 0x41);
    expect(pia.cb2).toBe(false);
    pia.setCB1(true);
    expect(pia.cb2).toBe(true);
  });

  it('drops CA2 on a port A data read (handshake)', () => {
    const pia = new M6820();
    pia.write(1, 0x26);
    pia.read(0);
    expect(pia.ca2).toBe(false);
    pia.setCA1(true);
    expect(pia.ca2).toBe(true);
  });

  it('pulses C2 low and back in pulse mode', () => {
    const pia = new M6820();
    const levels: boolean[] = [];
    pia.onCb2Change = l => levels.push(l);
    pia.write(3, 0x2C);                        // C2 pulse, data selected
    pia.write(2, 0x01);
    expect(levels).toEqual([false, true]);
    expect(pia.cb2).toBe(true);
  });
});
