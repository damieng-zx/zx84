/**
 * MC6821 PIA tests.
 *
 * Expectations come from the 6821 register model: CR2 selects the DDR or the
 * peripheral register, data reads clear both C1/C2 flags, C1 flags are set on
 * the selected transition, and an enabled flag pulls /IRQ low.
 */

import { describe, it, expect } from 'vitest';
import { M6821 } from '@/cores/m6821.ts';
import { AtariMachine } from '@/machines/atari/atari-machine.ts';

describe('m6821 data registers', () => {
  it('selects the DDR while CR2 is clear, and the port when it is set', () => {
    const pia = new M6821();
    pia.writeControl(0, 0x00);       // DDR access
    pia.writeData(0, 0x0f);          // low nibble outputs
    expect(pia.ddr[0]).toBe(0x0f);
    expect(pia.readData(0)).toBe(0x0f); // still reading the DDR

    pia.writeControl(0, 0x04);       // peripheral register
    pia.writeData(0, 0xaa);
    pia.inputA = 0x55;               // inputs are high nibble + bits 4-7
    // Driven bits come from the latch, the rest from the pins.
    expect(pia.readData(0)).toBe((0xaa & 0x0f) | (0x55 & 0xf0));
  });

  it('fires the output callback when a peripheral register is written', () => {
    const pia = new M6821();
    const seen: number[] = [];
    pia.onOutput = (port) => seen.push(port);
    pia.writeControl(0, 0x04);
    pia.writeData(0, 0x12);
    pia.writeControl(1, 0x04);
    pia.writeData(1, 0x34);
    expect(seen).toEqual([0, 1]);
  });
});

describe('m6821 interrupts', () => {
  it('sets CA1 on the selected edge and clears it when the data register is read', () => {
    const pia = new M6821();
    pia.writeControl(0, 0x04);       // peripheral register, C1 disabled
    pia.setC1(0, true);              // line starts high: no transition
    expect(pia.readControl(0) & 0x80).toBe(0);
    pia.setC1(0, true);              // still high: no edge either
    expect(pia.readControl(0) & 0x80).toBe(0);
    expect(pia.irq).toBe(false);

    pia.setC1(0, false);             // falling edge sets the flag
    expect(pia.readControl(0) & 0x80).toBe(0x80);
    expect(pia.irq).toBe(false);     // still disabled

    pia.writeControl(0, 0x05);       // enable C1
    expect(pia.irq).toBe(true);
    pia.readData(0);                 // reading the port clears the flag
    expect(pia.readControl(0) & 0x80).toBe(0);
    expect(pia.irq).toBe(false);
  });

  it('honours the C1 rising-edge select', () => {
    const pia = new M6821();
    pia.writeControl(0, 0x07);       // peripheral register + enable + rising
    pia.setC1(0, false);             // falling: not the selected edge
    expect(pia.readControl(0) & 0x80).toBe(0);
    pia.setC1(0, true);
    expect(pia.readControl(0) & 0x80).toBe(0x80);
    expect(pia.irq).toBe(true);
  });

  it('sets the C2 flag only while C2 is configured as an input', () => {
    const pia = new M6821();
    pia.writeControl(0, 0x2d);       // C2 input, rising, enable
    pia.setC2(0, false);             // falling: not selected
    pia.setC2(0, true);
    expect(pia.readControl(0) & 0x40).toBe(0x40);
    expect(pia.irq).toBe(true);

    pia.writeControl(0, 0x15);       // C2 becomes an output
    pia.readData(0);                 // clear flags
    pia.setC2(0, false);
    pia.setC2(0, true);
    expect(pia.readControl(0) & 0x40).toBe(0);
  });

  it('reset clears registers, direction and flags', () => {
    const pia = new M6821();
    pia.writeControl(0, 0x07);
    pia.writeData(0, 0xaa);
    pia.setC1(0, true);
    pia.reset();
    expect(pia.ddr[0]).toBe(0);
    expect(pia.out[0]).toBe(0);
    expect(pia.cr[0]).toBe(0);
    expect(pia.readControl(0)).toBe(0);
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
