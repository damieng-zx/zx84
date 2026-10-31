import { describe, it, expect } from 'vitest';
import { NewBrainMemory } from '@/machines/newbrain/newbrain-memory.ts';
import { NB_COP_ROM_SIZE, NB_CHAR_ROM_SIZE, NB_ROM_SIZE } from '@/machines/newbrain/constants.ts';

/** A 24K ROM whose three 8K banks are filled with 0xA0, 0xC0 and 0xE0, then
 *  1K of COP firmware (0x11) and the 4K character ROM (0x22). */
function image(): Uint8Array {
  const d = new Uint8Array(NB_ROM_SIZE + NB_COP_ROM_SIZE + NB_CHAR_ROM_SIZE);
  d.fill(0xA0, 0, 0x2000);
  d.fill(0xC0, 0x2000, 0x4000);
  d.fill(0xE0, 0x4000, 0x6000);
  d.fill(0x11, NB_ROM_SIZE, NB_ROM_SIZE + NB_COP_ROM_SIZE);
  d.fill(0x22, NB_ROM_SIZE + NB_COP_ROM_SIZE);
  return d;
}

describe('NewBrain memory map', () => {
  it('shadows every address with the E000 bank, and drops writes, until the power-up timer expires', () => {
    const m = new NewBrainMemory();
    m.loadROM(image());
    expect(m.poweredUp).toBe(false);
    for (const addr of [0x0000, 0x1234, 0x7FFF, 0x8000, 0xA000, 0xC000, 0xFFFF]) {
      expect(m.readByte(addr), `read ${addr.toString(16)}`).toBe(0xE0);
    }
    m.writeByte(0x0100, 0x55);
    m.poweredUp = true;
    expect(m.readByte(0x0100)).toBe(0);
  });

  it('maps 32K of RAM below 8000 and the three 8K banks from A000', () => {
    const m = new NewBrainMemory();
    m.loadROM(image());
    m.poweredUp = true;
    m.writeByte(0x0000, 0x12);
    m.writeByte(0x7FFF, 0x34);
    expect(m.readByte(0x0000)).toBe(0x12);
    expect(m.readByte(0x7FFF)).toBe(0x34);
    expect(m.readByte(0xA000)).toBe(0xA0);
    expect(m.readByte(0xBFFF)).toBe(0xA0);
    expect(m.readByte(0xC000)).toBe(0xC0);
    expect(m.readByte(0xDFFF)).toBe(0xC0);
    expect(m.readByte(0xE000)).toBe(0xE0);
    expect(m.readByte(0xFFFF)).toBe(0xE0);
  });

  it('floats 8000-9FFF high and ignores writes to ROM and to the gap', () => {
    const m = new NewBrainMemory();
    m.loadROM(image());
    m.poweredUp = true;
    expect(m.readByte(0x8000)).toBe(0xFF);
    expect(m.readByte(0x9FFF)).toBe(0xFF);
    m.writeByte(0x8000, 0x00);
    m.writeByte(0xA000, 0x00);
    m.writeByte(0xFFFF, 0x00);
    expect(m.readByte(0x8000)).toBe(0xFF);
    expect(m.readByte(0xA000)).toBe(0xA0);
    expect(m.readByte(0xFFFF)).toBe(0xE0);
  });

  it('splits the combined image into Z80 ROM, COP firmware and character ROM', () => {
    const m = new NewBrainMemory();
    m.loadROM(image());
    expect(m.getRom().length).toBe(NB_ROM_SIZE);
    expect(m.getCopRom().length).toBe(NB_COP_ROM_SIZE);
    expect(m.getCopRom()[0]).toBe(0x11);
    expect(m.getCharRom().length).toBe(NB_CHAR_ROM_SIZE);
    expect(m.getCharRom()[0xFFF]).toBe(0x22);
  });

  it('keeps a bare 24K ROM set from wiping the COP firmware and character ROM already loaded', () => {
    const m = new NewBrainMemory();
    m.loadROM(image());
    m.loadROM(new Uint8Array(NB_ROM_SIZE).fill(0x77));
    expect(m.getRom()[0]).toBe(0x77);
    expect(m.getCopRom()[0]).toBe(0x11);
    expect(m.getCharRom()[0]).toBe(0x22);
  });
});
