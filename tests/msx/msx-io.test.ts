/**
 * MsxPpi — the 8255 as wired on the MSX (Toshiba HX-10).
 *
 * Port A drives the memory pager; port C's low nibble selects the keyboard row;
 * the control port does 8255 bit-set-reset (BSR) on port C. BSR encoding is the
 * datasheet's: bit7=0, bits[3:1]=port-C bit number, bit0=set(1)/reset(0).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MsxMemory } from '@/machines/msx/msx-memory.ts';
import { MsxKeyboard } from '@/machines/msx/msx-keyboard.ts';
import { MsxPpi } from '@/machines/msx/msx-io.ts';

describe('MsxPpi', () => {
  let mem: MsxMemory;
  let kbd: MsxKeyboard;
  let ppi: MsxPpi;
  beforeEach(() => {
    mem = new MsxMemory();
    const rom = new Uint8Array(0x8000);
    rom[0x0000] = 0x42;
    mem.loadROM(rom);
    mem.reset();
    kbd = new MsxKeyboard();
    ppi = new MsxPpi(mem, kbd);
  });

  it('port A write selects primary slots and reads back', () => {
    ppi.writeA(0xF0);
    expect(ppi.readA()).toBe(0xF0);
    expect(mem.getPrimarySlot()).toBe(0xF0);
  });

  it('port A actually repages memory', () => {
    ppi.writeA(0xFF);                 // all RAM
    mem.writeByte(0x0000, 0x5A);
    expect(mem.readByte(0x0000)).toBe(0x5A);
    ppi.writeA(0x00);                 // page 0 back to ROM
    expect(mem.readByte(0x0000)).toBe(0x42);
  });

  it('port C low nibble selects the keyboard row read on port B', () => {
    kbd.handleKeyEvent('KeyS', true); // S = row 5, bit 0
    ppi.writeC(0x05);                 // select row 5 (high nibble irrelevant)
    expect(ppi.readB()).toBe((0xFF & ~0x01) & 0xFF); // 0xFE
    ppi.writeC(0xF5);                 // high nibble set, row still 5
    expect(ppi.readB()).toBe(0xFE);
    expect(ppi.readC()).toBe(0xF5);
  });

  it('control-port BSR sets/resets a port-C bit and re-derives the row', () => {
    kbd.handleKeyEvent('Space', true); // SPACE = row 8, bit 0
    ppi.writeC(0x00);                  // row 0
    ppi.writeControl(0x07);            // BSR: set bit 3 → portC=0x08 → row 8
    expect(ppi.readC()).toBe(0x08);
    expect(ppi.readB()).toBe(0xFE);    // SPACE visible on row 8
    ppi.writeControl(0x06);            // BSR: reset bit 3 → portC=0x00 → row 0
    expect(ppi.readC()).toBe(0x00);
    expect(ppi.readB()).toBe(0xFF);    // nothing on row 0
  });

  it('reset returns slots and row select to 0', () => {
    ppi.writeA(0xFF);
    ppi.writeC(0x0A);
    ppi.reset();
    expect(ppi.readA()).toBe(0x00);
    expect(ppi.readC()).toBe(0x00);
    expect(mem.getPrimarySlot()).toBe(0x00);
  });
});
