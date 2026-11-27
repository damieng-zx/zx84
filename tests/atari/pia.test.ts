/**
 * MC6821 PIA tests, through the machine's PIA.
 *
 * Expectations come from the 6821 register model: CR2 selects the DDR or the
 * peripheral register, data reads clear both C1/C2 flags, C1 flags are set on
 * the selected transition, and an enabled flag pulls /IRQ low. The Atari's PIA
 * is a 6821; the core is `M6820`, the same part with a different output stage.
 */

import { describe, it, expect } from 'vitest';
import { M6820 } from '@/cores/m6820.ts';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';

describe('mc6821 data registers', () => {
  it('selects the DDR while CR2 is clear, and the port when it is set', () => {
    const pia = new M6820();
    pia.write(1, 0x00);              // DDR access
    pia.write(0, 0x0f);              // low nibble outputs
    expect(pia.ddr[0]).toBe(0x0f);
    expect(pia.read(0)).toBe(0x0f);  // still reading the DDR

    pia.write(1, 0x04);              // peripheral register
    pia.write(0, 0xaa);
    pia.portAInput = 0x55;           // inputs are high nibble + bits 4-7
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

describe('mc6821 interrupts', () => {
  it('sets CA1 on the selected edge and clears it when the data register is read', () => {
    const pia = new M6820();
    pia.write(1, 0x04);              // peripheral register, C1 disabled
    pia.setCA1(true);                // line starts high: no transition
    expect(pia.cra & 0x80).toBe(0);
    pia.setCA1(true);                // still high: no edge either
    expect(pia.cra & 0x80).toBe(0);
    expect(pia.irq).toBe(false);

    pia.setCA1(false);               // falling edge sets the flag
    expect(pia.cra & 0x80).toBe(0x80);
    expect(pia.irq).toBe(false);    // still disabled

    pia.write(1, 0x05);              // enable C1
    expect(pia.irq).toBe(true);
    pia.read(0);                     // reading the port clears the flag
    expect(pia.cra & 0x80).toBe(0);
    expect(pia.irq).toBe(false);
  });

  it('honours the C1 rising-edge select', () => {
    const pia = new M6820();
    pia.write(1, 0x07);              // peripheral register + enable + rising
    pia.setCA1(false);               // falling: not the selected edge
    expect(pia.cra & 0x80).toBe(0);
    pia.setCA1(true);
    expect(pia.cra & 0x80).toBe(0x80);
    expect(pia.irq).toBe(true);
  });

  it('sets the C2 flag only while C2 is configured as an input', () => {
    const pia = new M6820();
    // CRA: bit 5 selects the C2 direction, bit 4 the active transition, bit 3
    // the C2 interrupt enable, bit 2 the data register. An input with the
    // rising edge selected and C2's interrupt enabled is $1C: bit 5 clear
    // (input), bit 4 set (rising), bit 3 set (enable), bit 2 set (register).
    pia.write(1, 0x1c);
    pia.setCA2(false);               // falling: not selected
    expect(pia.cra & 0x40, 'the falling edge is not the active one').toBe(0);
    pia.setCA2(true);                // rising: the active edge
    expect(pia.cra & 0x40, 'the rising edge sets the flag').toBe(0x40);
    expect(pia.irq, 'the flag is enabled').toBe(true);
    pia.read(0);                     // clear the flags
    expect(pia.irq).toBe(false);
    pia.setCA2(false);

    // Bit 5 set makes C2 an output, and then the C2 input is ignored.
    pia.write(1, 0x24);              // C2 output (bit 5), bit 4 clear
    pia.setCA2(false);
    pia.setCA2(true);
    expect(pia.cra & 0x40, 'an output C2 raises no flag').toBe(0);
  });

  it('reads bit 5 as the C2 direction and bit 4 as its edge select', () => {
    // This pair is the one that is easy to get backwards, so it is pinned
    // directly: the datasheet numbers bit 5 "C2 direction" and bit 4 "C2
    // transition".
    const pia = new M6820();
    pia.write(1, 0x20);                        // bit 5: C2 output
    pia.setCA2(false);                         // an output ignores its input
    pia.setCA2(true);
    expect(pia.cra & 0x40, 'an output C2 raises no flag').toBe(0);

    // Bit 5 clear makes C2 an input; bit 4 then selects its active edge.
    pia.write(1, 0x10);                        // input, rising selected
    pia.setCA2(false);                         // falling: not the active edge
    expect(pia.cra & 0x40, 'bit 4 set: only the rising edge').toBe(0);
    pia.setCA2(true);                          // rising: the active edge
    expect(pia.cra & 0x40, 'bit 4 set selects the rising edge').toBe(0x40);

    pia.write(1, 0x00);                        // bit 4 clear: falling selected
    pia.read(0);                               // clear the flag
    pia.setCA2(false);
    expect(pia.cra & 0x40, 'bit 4 clear selects the falling edge').toBe(0x40);
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

describe('atari SIO PROCEED and INTERRUPT lines', () => {
  const PORTA = 0xd300;
  const PACTL = 0xd302;
  const PBCTL = 0xd303;
  const PORTB = 0xd301;

  it('idle released: no flag and no IRQ until a device pulls a line low', () => {
    const m = new AtariMachine('atari800', null);
    try {
      m.memory.writeByte(PACTL, 0x05);
      m.memory.writeByte(PBCTL, 0x05);
      expect(m.pia.irq).toBe(false);
      expect(m.memory.readByte(PACTL) & 0x80).toBe(0);
      expect(m.memory.readByte(PBCTL) & 0x80).toBe(0);
    } finally {
      m.destroy();
    }
  });

  it('raises the IRQ from PROCEED through CA1 and clears it when PORTA is read', () => {
    const m = new AtariMachine('atari800', null);
    try {
      m.memory.writeByte(PACTL, 0x05);   // C1 IRQ enabled, high-to-low, port register
      m.sioBus.setProceed(true);
      expect(m.pia.irq).toBe(true);
      expect(m.memory.readByte(PACTL) & 0x80).toBe(0x80);
      m.memory.readByte(PORTA);
      expect(m.pia.irq).toBe(false);
      m.sioBus.setProceed(false);        // releasing is the other edge: no flag
      expect(m.pia.irq).toBe(false);
      m.sioBus.setProceed(true);         // and the next assertion fires again
      expect(m.pia.irq).toBe(true);
    } finally {
      m.destroy();
    }
  });

  it('raises the IRQ from INTERRUPT through CB1, independently of CA1', () => {
    const m = new AtariMachine('atari800', null);
    try {
      m.memory.writeByte(PACTL, 0x05);
      m.memory.writeByte(PBCTL, 0x05);
      m.sioBus.setInterrupt(true);
      expect(m.pia.irq).toBe(true);
      expect(m.memory.readByte(PACTL) & 0x80).toBe(0);
      expect(m.memory.readByte(PBCTL) & 0x80).toBe(0x80);
      m.memory.readByte(PORTB);
      expect(m.pia.irq).toBe(false);
    } finally {
      m.destroy();
    }
  });

  it('does not interrupt while the CA1/CB1 interrupt is not enabled, and follows the edge select', () => {
    const m = new AtariMachine('atari800', null);
    try {
      m.memory.writeByte(PACTL, 0x04);   // enable bit clear
      m.sioBus.setProceed(true);
      expect(m.pia.irq).toBe(false);
      expect(m.memory.readByte(PACTL) & 0x80).toBe(0x80); // the flag is still set
      m.memory.readByte(PORTA);
      m.sioBus.setProceed(false);
      m.memory.writeByte(PACTL, 0x07);   // low-to-high this time
      m.sioBus.setProceed(true);         // pulling low: not the selected edge
      expect(m.pia.irq).toBe(false);
      m.sioBus.setProceed(false);        // releasing: low-to-high
      expect(m.pia.irq).toBe(true);
    } finally {
      m.destroy();
    }
  });

  it('releases both lines on reset', () => {
    const m = new AtariMachine('atari800', null);
    try {
      m.sioBus.setProceed(true);
      m.sioBus.setInterrupt(true);
      m.reset();
      m.memory.writeByte(PACTL, 0x05);
      m.memory.writeByte(PBCTL, 0x05);
      expect(m.pia.irq).toBe(false);
      m.sioBus.setProceed(true);          // a fresh assertion still reaches the PIA
      expect(m.pia.irq).toBe(true);
    } finally {
      m.destroy();
    }
  });
});
