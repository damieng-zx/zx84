/**
 * MC6820 PIA: register selection, DDR/data switching, the interrupt flags and
 * the C2 handshake modes.
 */

import { describe, it, expect } from 'vitest';
import { M6820, PIA_CR_IRQ1, PIA_CR_IRQ2 } from '@/cores/m6820.ts';

describe('M6820 registers', () => {
  it('reads zero after reset and ignores writes to the read-only flag bits', () => {
    const pia = new M6820();
    for (let rs = 0; rs < 4; rs++) expect(pia.read(rs)).toBe(0);
    pia.write(1, 0xFF);
    expect(pia.read(1)).toBe(0x3F);
  });

  it('addresses the DDR while CR bit 2 is clear and the data register once set', () => {
    const pia = new M6820();
    pia.write(2, 0x7F);               // CRB bit 2 clear: this is DDRB
    expect(pia.ddrb).toBe(0x7F);
    expect(pia.orb).toBe(0);
    pia.write(3, 0x04);
    pia.write(2, 0x55);               // now the output register
    expect(pia.orb).toBe(0x55);
    expect(pia.ddrb).toBe(0x7F);
    pia.write(3, 0x00);
    expect(pia.read(2)).toBe(0x7F);   // the DDR reads back
  });

  it('mixes output bits with the pins on a data read', () => {
    const pia = new M6820();
    pia.write(0, 0x0F);               // DDRA: low nibble out
    pia.write(1, 0x04);
    pia.write(0, 0x05);
    pia.portAInput = 0xA0;
    expect(pia.read(0)).toBe(0xA5);
  });

  it('reports the output register write through the callback', () => {
    const pia = new M6820();
    const seen: Array<[number, number]> = [];
    pia.onPortBWrite = (v, ddr) => seen.push([v, ddr]);
    pia.write(2, 0x7F);               // DDR write: not an output
    pia.write(3, 0x04);
    pia.write(2, 0x41);
    expect(seen).toEqual([[0x41, 0x7F]]);
  });

  it('peek has no side effects', () => {
    const pia = new M6820();
    pia.write(1, 0x07);               // rising C1, IRQ enabled, data selected
    pia.setCA1(true);
    expect(pia.cra & PIA_CR_IRQ1).toBe(PIA_CR_IRQ1);
    pia.peek(0);
    expect(pia.cra & PIA_CR_IRQ1).toBe(PIA_CR_IRQ1);
    pia.read(0);
    expect(pia.cra & PIA_CR_IRQ1).toBe(0);
  });
});

describe('M6820 interrupt flags', () => {
  it('sets IRQ1 on the selected C1 edge only', () => {
    const rising = new M6820();
    rising.write(1, 0x06);            // rising edge, data selected, IRQ off
    rising.setCA1(true);
    expect(rising.cra & PIA_CR_IRQ1).toBe(PIA_CR_IRQ1);

    const falling = new M6820();
    falling.write(1, 0x04);           // falling edge
    falling.setCA1(true);
    expect(falling.cra & PIA_CR_IRQ1).toBe(0);
    falling.setCA1(false);
    expect(falling.cra & PIA_CR_IRQ1).toBe(PIA_CR_IRQ1);
  });

  it('raises the interrupt line only while enabled', () => {
    const pia = new M6820();
    pia.write(1, 0x06);
    pia.setCA1(true);
    expect(pia.irqA).toBe(false);
    pia.write(1, 0x07);
    expect(pia.irqA).toBe(true);
    pia.read(0);
    expect(pia.irqA).toBe(false);
  });

  it('sets IRQ2 from a C2 input edge when C2 is an input', () => {
    const pia = new M6820();
    pia.write(3, 0x1C);               // C2 input, rising edge, IRQ enabled, data selected
    pia.setCB2(true);
    expect(pia.crb & PIA_CR_IRQ2).toBe(PIA_CR_IRQ2);
    expect(pia.irqB).toBe(true);
  });

  it('clears both flags when either port data register is read', () => {
    const pia = new M6820();
    pia.write(3, 0x1E);
    pia.setCB1(true);
    pia.setCB2(true);
    expect(pia.crb & 0xC0).toBe(0xC0);
    pia.read(2);
    expect(pia.crb & 0xC0).toBe(0);
  });
});

describe('M6820 C2 output', () => {
  it('holds C2 at the level of CR bit 3 in manual mode', () => {
    const pia = new M6820();
    const levels: boolean[] = [];
    pia.onCa2Change = l => levels.push(l);
    pia.write(1, 0x30);               // manual, low
    expect(pia.ca2).toBe(false);
    pia.write(1, 0x38);               // manual, high
    expect(pia.ca2).toBe(true);
    expect(levels).toEqual([false, true]);
  });

  it('drops CB2 on an output register write and restores it on the next C1 edge (handshake)', () => {
    const pia = new M6820();
    pia.write(3, 0x26);               // C2 handshake, rising C1, data selected
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
    pia.write(3, 0x2C);               // C2 pulse, data selected
    pia.write(2, 0x01);
    expect(levels).toEqual([false, true]);
    expect(pia.cb2).toBe(true);
  });
});
