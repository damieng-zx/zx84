/**
 * Intel 8255 PPI — mode 0 data paths, direction control and port-C bit
 * set/reset, against the datasheet's control-word table.
 */

import { describe, expect, it, vi } from 'vitest';
import { I8255 } from '@/cores/i8255.ts';

describe('i8255', () => {
  it('resets with every port an input and reads the external pins', () => {
    const ppi = new I8255();
    expect(ppi.control).toBe(0x9B);
    ppi.portAInput = 0x12;
    ppi.portBInput = 0x34;
    ppi.portCInput = 0x56;
    expect(ppi.read(0)).toBe(0x12);
    expect(ppi.read(1)).toBe(0x34);
    expect(ppi.read(2)).toBe(0x56);
    expect(ppi.read(3)).toBe(0x9B);
  });

  it('mode 0 all-output: writes read back and the external pins are ignored', () => {
    const ppi = new I8255();
    ppi.write(3, 0x80);
    ppi.write(0, 0xAA);
    ppi.write(1, 0x55);
    ppi.write(2, 0xC3);
    ppi.portAInput = 0x00;
    ppi.portBInput = 0xFF;
    ppi.portCInput = 0x00;
    expect(ppi.read(0)).toBe(0xAA);
    expect(ppi.read(1)).toBe(0x55);
    expect(ppi.read(2)).toBe(0xC3);
  });

  it('mode 0 split directions: A out, B in, C upper in / lower out', () => {
    const ppi = new I8255();
    ppi.write(3, 0x8A);               // the Atom's control word
    ppi.write(0, 0x1A);
    ppi.write(2, 0x0B);               // only the low nibble is driven
    ppi.portBInput = 0x5C;
    ppi.portCInput = 0xA0;
    expect(ppi.read(0)).toBe(0x1A);
    expect(ppi.read(1)).toBe(0x5C);
    // Upper nibble from the pins, lower from the latch.
    expect(ppi.read(2)).toBe(0xAB);
    expect(ppi.driven(0)).toBe(0x1A);
    expect(ppi.driven(2)).toBe(0x0B);
  });

  it('port C bit set/reset changes the output latch, not the direction', () => {
    const ppi = new I8255();
    ppi.write(3, 0x80);               // all output
    ppi.write(2, 0x00);
    ppi.write(3, 0x0F);               // set bit 7
    expect(ppi.read(2)).toBe(0x80);
    ppi.write(3, 0x0E);               // reset bit 7
    expect(ppi.read(2)).toBe(0x00);
    ppi.write(3, 0x05);               // set bit 2
    expect(ppi.read(2)).toBe(0x04);
  });

  it('notifies the machine when a driven pin level changes', () => {
    const ppi = new I8255();
    const a = vi.fn();
    const c = vi.fn();
    ppi.onPortAWrite = a;
    ppi.onPortCWrite = c;
    ppi.write(3, 0x80);               // direction change: A/C now driven
    expect(a).toHaveBeenCalledWith(0, 0xFF);
    expect(c).toHaveBeenLastCalledWith(0, 0xFF);
    ppi.write(0, 0x40);
    expect(a).toHaveBeenLastCalledWith(0x40, 0xFF);
    ppi.write(3, 0x03);               // set C bit 1
    expect(c).toHaveBeenLastCalledWith(0x02, 0xFF);
  });

  it('saves and restores its registers', () => {
    const ppi = new I8255();
    ppi.write(3, 0x8A);
    ppi.write(0, 0x77);
    ppi.write(2, 0x05);
    ppi.portCInput = 0x00;             // upper nibble pins quiet
    const sink: number[] = [];
    ppi.saveState({ u8: (v: number) => sink.push(v) } as never);
    const restored = new I8255();
    restored.portCInput = 0x00;
    let at = 0;
    restored.loadState({ u8: () => sink[at++] } as never);
    expect(restored.control).toBe(0x8A);
    expect(restored.read(0)).toBe(0x77);
    expect(restored.read(2)).toBe(0x05);
  });
});
