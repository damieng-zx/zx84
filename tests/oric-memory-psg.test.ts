/**
 * Oric memory map and the PSG's bus protocol, tested directly.
 *
 * The boot test exercises both incidentally, but a wrong overlay window or a
 * mis-decoded BDIR/BC1 pair can still let BASIC start and only show up later,
 * so each is pinned here against the hardware reference rather than against the
 * other.
 */

import { describe, expect, it } from 'vitest';
import { M6522 } from '@/cores/m6522.ts';
import { OricMemory } from '@/machines/oric/oric-memory.ts';
import { OricPsg } from '@/machines/oric/oric-psg.ts';

describe('oric memory map', () => {
  it('shows the ROM at $C000 and drops writes to it', () => {
    const m = new OricMemory();
    m.rom.fill(0x00);
    m.rom[0x0000] = 0x11;
    expect(m.readByte(0xC000)).toBe(0x11);
    m.writeByte(0xC000, 0x22);
    expect(m.readByte(0xC000), 'a write to ROM is dropped').toBe(0x11);
    expect(m.readByte(0x0400), 'RAM below the ROM is writable').toBe(0x00);
  });

  it('swaps in the overlay RAM when ROMDIS is asserted', () => {
    const m = new OricMemory();
    m.rom[0x0000] = 0x11;
    m.setOverlay(true);
    expect(m.basicRomOn).toBe(false);
    expect(m.overlayOn).toBe(true);
    // The overlay *is* the top of the address space, so a write lands there.
    m.writeByte(0xC000, 0x99);
    expect(m.readByte(0xC000)).toBe(0x99);
    expect(m.ram[0xC000]).toBe(0x99);
    // And going back shows the ROM again, with the overlay's byte intact.
    m.setOverlay(false);
    expect(m.readByte(0xC000)).toBe(0x11);
    m.setOverlay(true);
    expect(m.readByte(0xC000)).toBe(0x99);
  });

  it('maps the boot EPROM at $E000 only alongside the overlay', () => {
    const m = new OricMemory();
    m.rom[0x2000] = 0x11;
    m.eprom[0x0000] = 0x77;
    m.setOverlay(false);
    m.epromOn = false;
    expect(m.readByte(0xE000), 'overlay off: the BASIC ROM').toBe(0x11);
    m.setOverlay(true);
    m.epromOn = true;
    expect(m.readByte(0xE000), 'overlay on: the card EPROM').toBe(0x77);
    // Below $E000 the overlay RAM is still RAM, not the EPROM.
    m.writeByte(0xC000, 0x55);
    expect(m.readByte(0xC000)).toBe(0x55);
    // The EPROM itself is read-only.
    m.writeByte(0xE000, 0xAB);
    expect(m.readByte(0xE000)).toBe(0x77);
  });

  it('never routes page 3 to RAM, whatever is mapped in', () => {
    const m = new OricMemory();
    m.ioWrite = (addr, value) => { m.ram[0x1000 + (addr & 0xFF)] = value; };
    m.ioRead = (addr) => m.ram[0x1000 + (addr & 0xFF)];
    m.writeByte(0x0302, 0x5A);
    // The write went to the hook, not to the address space's own byte.
    expect(m.ram[0x0302], 'page 3 is I/O, never RAM').toBe(0x00);
    expect(m.readByte(0x0302)).toBe(0x5A);
  });

  it('reports the four 16K banks and the 64K snapshot', () => {
    const m = new OricMemory();
    expect(m.ramBankCount).toBe(4);
    m.ram[0x0000] = 0x11;
    m.ram[0xFFFF] = 0x22;
    expect(m.getRamBank(0)[0]).toBe(0x11);
    expect(m.getRamBank(3)[0x3FFF]).toBe(0x22);
    // The snapshot is the CPU's view: the ROM appears where it is mapped.
    m.rom[0x0000] = 0x99;
    m.setOverlay(false);
    expect(m.snapshot()[0xC000]).toBe(0x99);
  });

  it('refuses a ROM of the wrong size', () => {
    const m = new OricMemory();
    expect(m.loadRom(new Uint8Array(0x2000))).toBe(false);
    expect(m.loadEprom(new Uint8Array(0x4000))).toBe(false);
    expect(m.loadRom(new Uint8Array(0x4000))).toBe(true);
    expect(m.loadEprom(new Uint8Array(0x2000))).toBe(true);
  });
});

/**
 * The PSG hangs off VIA port A and is selected by the two handshake lines the
 * PCR holds. The reference gives the four combinations, and they are the whole
 * contract: latch an index, write a register, read one back, or nothing.
 */
describe('oric PSG bus protocol', () => {
  /** Wire a VIA and PSG together the way the machine does. */
  function pair(): { via: M6522; psg: OricPsg } {
    const via = new M6522();
    const psg = new OricPsg();
    via.onPcrWrite = (pcr) => psg.onPcrWrite(via, pcr);
    via.onPortAWrite = (value) => psg.onPortAWrite(via, value & 0xFF);
    return { via, psg };
  }

  // PCR values: CA2 is bits 1-3, CB2 is bits 5-7; mode 7 holds a line high and
  // mode 6 holds it low, which is how the ROM spells BDIR and BC1. The machine's
  // own traffic uses $DD/$FF/$FD for deselect/index/write, so those are the
  // ground truth; *read* needs CA2 high and CB2 low, i.e. $CE.
  const BOTH_LOW = 0xDD;      // BC1 0, BDIR 0: not selected
  const INDEX = 0xFF;         // BC1 1, BDIR 1: latch the register index
  const WRITE = 0xFD;         // BC1 0, BDIR 1: write the register
  const READ = 0xCE;          // BC1 1, BDIR 0: read the register

  it('latches an index, then writes that register', () => {
    const { via, psg } = pair();
    via.write(12, BOTH_LOW);
    via.write(1, 0x0E);       // the index on port A, not selected yet
    via.write(12, INDEX);     // latch it
    expect(psg.ay.selectedReg).toBe(0x0E);
    via.write(12, WRITE);
    via.write(1, 0xC0);       // the data byte commits on the transition
    expect(psg.ay.readRegister(0x0E)).toBe(0xC0);
  });

  it('leaves the chip alone while both lines are low', () => {
    const { via, psg } = pair();
    via.write(12, INDEX);
    via.write(12, BOTH_LOW);
    via.write(1, 0xC0);       // port A changes, but nothing is selected
    const before = Array.from(psg.ay.getRegisters());
    via.write(1, 0x55);
    expect(Array.from(psg.ay.getRegisters())).toEqual(before);
  });

  it('reads a register back onto port A', () => {
    const { via, psg } = pair();
    psg.ay.writeRegister(0x0E, 0xF3);
    via.write(12, BOTH_LOW);
    via.write(1, 0x0E);
    via.write(12, INDEX);
    via.write(12, READ);
    // The chip now drives port A, which the machine exposes as its input.
    expect(via.portAInput).toBe(0xF3);
  });

  it('keeps the keyboard columns it was last given', () => {
    const { via, psg } = pair();
    via.write(12, INDEX);
    via.write(1, 0x0E);
    via.write(12, WRITE);
    // One bit clear selects a column: $FE is column 0.
    via.write(1, 0xFE);
    expect(psg.columns).toBe(0xFE);
    // Register 14 is the chip's own I/O port, which is the keyboard's.
    expect(psg.ay.readRegister(0x0E)).toBe(0xFE);
  });

  it('reports whether the chip is making a sound', () => {
    const { via, psg } = pair();
    expect(psg.sounding).toBe(false);
    // Channel A volume 15 with the envelope off is an audible level.
    via.write(12, INDEX);
    via.write(1, 0x08);
    via.write(12, WRITE);
    via.write(1, 0x0F);
    expect(psg.sounding).toBe(true);
  });
});
