/**
 * The 8563 VDC's ports, from the C128 Programmer's Reference Guide: the
 * address/data register pair, the update address and its auto-increment, the
 * data port (register 31), block fill and copy (registers 24 and 30), the
 * status register, and the 16K and 64K RAM sizes.
 */

import { describe, it, expect } from 'vitest';
import { Vdc, VDC_RAM_64K } from '@/machines/c128/vdc.ts';

/** Write a register through the address and data ports. */
function setReg(v: Vdc, reg: number, value: number): void {
  v.write(0, reg);
  v.write(1, value);
}
function getReg(v: Vdc, reg: number): number {
  v.write(0, reg);
  return v.read(1);
}
function setUpdate(v: Vdc, addr: number): void {
  setReg(v, 18, addr >> 8);
  setReg(v, 19, addr & 0xFF);
}
/** The data port: write bytes at the update address. */
function put(v: Vdc, ...bytes: number[]): void {
  v.write(0, 31);
  for (const b of bytes) v.write(1, b);
}

describe('VDC register ports', () => {
  it('reads back a register written through the data port', () => {
    const v = new Vdc();
    setReg(v, 7, 0x20);
    expect(getReg(v, 7)).toBe(0x20);
  });

  it('selects a register from the low six bits of what is written to the address port', () => {
    const v = new Vdc();
    setReg(v, 1, 80);
    v.write(0, 0xC1);
    expect(v.read(1)).toBe(80);
  });

  it('reads $FF from a register that does not exist', () => {
    const v = new Vdc();
    v.write(0, 45);
    expect(v.read(1)).toBe(0xFF);
  });
});

describe('VDC update address and data port', () => {
  it('writes the byte at the update address (registers 18 and 19) and moves on by one', () => {
    const v = new Vdc();
    setUpdate(v, 0x0123);
    put(v, 0xAB, 0xCD);
    expect(v.ram[0x0123]).toBe(0xAB);
    expect(v.ram[0x0124]).toBe(0xCD);
    expect(getReg(v, 18)).toBe(0x01);
    expect(getReg(v, 19)).toBe(0x25);
  });

  it('carries from the low byte into the high byte of the update address', () => {
    const v = new Vdc();
    setUpdate(v, 0x00FF);
    put(v, 1, 2);
    expect(v.ram[0x00FF]).toBe(1);
    expect(v.ram[0x0100]).toBe(2);
    expect(getReg(v, 18)).toBe(0x01);
    expect(getReg(v, 19)).toBe(0x01);
  });

  it('reads RAM through the data port, moving on by one as a write does', () => {
    const v = new Vdc();
    v.ram[0x0200] = 0x11;
    v.ram[0x0201] = 0x22;
    setUpdate(v, 0x0200);
    v.write(0, 31);
    expect(v.read(1)).toBe(0x11);
    expect(v.read(1)).toBe(0x22);
    expect(getReg(v, 19)).toBe(0x02);
  });

  it('does not move the update address when asked what a read would give', () => {
    const v = new Vdc();
    v.ram[0x0300] = 0x5A;
    setUpdate(v, 0x0300);
    v.write(0, 31);
    expect(v.peek(1)).toBe(0x5A);
    expect(v.peek(1)).toBe(0x5A);
    expect(v.read(1)).toBe(0x5A);
  });

  it('wraps the 16K RAM: address $4000 is address $0000', () => {
    const v = new Vdc();
    setUpdate(v, 0x4000);
    put(v, 0x77);
    expect(v.ram[0]).toBe(0x77);
    expect(v.ram.length).toBe(0x4000);
  });

  it('keeps all 64K of a 64K VDC apart', () => {
    const v = new Vdc(VDC_RAM_64K);
    setReg(v, 28, 0x10);                       // addressed as 64K (the chip is)
    setUpdate(v, 0x4000);
    put(v, 0x77);
    expect(v.ram[0x4000]).toBe(0x77);
    expect(v.ram[0]).toBe(0);
    setUpdate(v, 0xFFFF);
    put(v, 0x88);
    expect(v.ram[0xFFFF]).toBe(0x88);
  });
});

describe('VDC block fill', () => {
  it('fills the word count (register 30) of bytes after the first with the byte last written', () => {
    const v = new Vdc();
    setUpdate(v, 0x0020);
    put(v, 0x55);                              // the first byte, at $20
    setReg(v, 30, 3);                          // three more: $21, $22, $23
    expect(Array.from(v.ram.subarray(0x1F, 0x25))).toEqual([0, 0x55, 0x55, 0x55, 0x55, 0]);
    expect(getReg(v, 19), 'the update address ended after the block').toBe(0x24);
  });

  it('takes a count of 0 as 256', () => {
    const v = new Vdc();
    setUpdate(v, 0x0400);
    put(v, 0x99);
    setReg(v, 30, 0);
    expect(v.ram[0x0400]).toBe(0x99);
    expect(v.ram[0x0500]).toBe(0x99);          // 1 + 256 bytes from $0400: through $0500
    expect(v.ram[0x0501]).toBe(0);
  });

  it('fills with the byte last read through the data port, as well as the last written', () => {
    const v = new Vdc();
    v.ram[0x0600] = 0x3C;
    setUpdate(v, 0x0600);
    v.write(0, 31);
    v.read(1);                                 // $3C, update address now $0601
    setReg(v, 30, 2);
    expect(Array.from(v.ram.subarray(0x600, 0x604))).toEqual([0x3C, 0x3C, 0x3C, 0]);
  });
});

describe('VDC block copy', () => {
  /** Set the VDC up to copy: register 24 bit 7, the source, the destination, and go. */
  function copy(v: Vdc, from: number, to: number, count: number): void {
    setReg(v, 24, 0x80);
    setReg(v, 32, from >> 8); setReg(v, 33, from & 0xFF);
    setUpdate(v, to);
    setReg(v, 30, count);
  }

  it('copies the source block to the destination', () => {
    const v = new Vdc();
    v.ram.set([1, 2, 3, 4], 0x0100);
    copy(v, 0x0100, 0x0200, 4);
    expect(Array.from(v.ram.subarray(0x200, 0x205))).toEqual([1, 2, 3, 4, 0]);
    expect(getReg(v, 33), 'the source address moved on').toBe(0x04);
  });

  it('copies a byte at a time, so a destination below an overlapping source is a clean move', () => {
    const v = new Vdc();
    v.ram.set([1, 2, 3, 4, 5], 0x0011);
    copy(v, 0x0011, 0x0010, 5);
    expect(Array.from(v.ram.subarray(0x10, 0x16))).toEqual([1, 2, 3, 4, 5, 5]);
  });

  it('copies a byte at a time, so a destination one above the source repeats the first byte', () => {
    const v = new Vdc();
    v.ram.set([7, 8, 9, 10], 0x0010);
    copy(v, 0x0010, 0x0011, 4);
    expect(Array.from(v.ram.subarray(0x10, 0x15))).toEqual([7, 7, 7, 7, 7]);
  });

  it('copies rather than fills only while register 24 bit 7 is set', () => {
    const v = new Vdc();
    v.ram[0x0100] = 0x42;
    setReg(v, 24, 0x00);
    setUpdate(v, 0x0200);
    put(v, 0x11);
    setReg(v, 30, 2);
    expect(Array.from(v.ram.subarray(0x200, 0x204))).toEqual([0x11, 0x11, 0x11, 0]);
  });
});

describe('VDC status register', () => {
  it('reads ready (bit 7) with no light pen, and the chip version in the low bits: 1 (8563 R8/R9) unless told', () => {
    const v = new Vdc();
    expect(v.read(0)).toBe(0x81);
    expect(v.peek(0)).toBe(0x81);
    v.version = 0;
    expect(v.read(0)).toBe(0x80);
    v.version = 2;
    expect(v.read(0)).toBe(0x82);
  });

  it('sets bit 5 while the beam is below the displayed rows: 200 of 312 lines of a frame', () => {
    const v = new Vdc();
    setReg(v, 4, 38);                          // 39 character rows in all
    setReg(v, 5, 0);                           // no extra lines
    setReg(v, 6, 25);                          // 25 displayed
    setReg(v, 9, 7);                           // of 8 lines: 312 lines, 200 displayed
    v.setBeam(0.5);
    expect(v.read(0) & 0x20).toBe(0);
    v.setBeam(200 / 312 + 0.01);
    expect(v.read(0) & 0x20).toBe(0x20);
    v.setBeam(0.99);
    expect(v.read(0) & 0x20).toBe(0x20);
    v.setBeam(0);
    expect(v.read(0) & 0x20).toBe(0);
  });
});

describe('VDC reset', () => {
  it('clears the registers and the RAM', () => {
    const v = new Vdc();
    setReg(v, 1, 80);
    setUpdate(v, 0x0010);
    put(v, 0xEE);
    v.reset();
    expect(v.regs.every((r) => r === 0)).toBe(true);
    expect(v.ram.every((b) => b === 0)).toBe(true);
  });
});
