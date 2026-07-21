import { describe, expect, it } from 'vitest';
import { Zx8xMemory } from '@/machines/zx8x/memory.ts';

describe('ZX80/ZX81 memory decoding', () => {
  it('mirrors the model-sized ROM through the lower 16K and across A15', () => {
    const memory = new Zx8xMemory('zx80');
    const rom = new Uint8Array(0x1000);
    rom[0x234] = 0xa5;
    memory.loadROM(rom);
    expect(memory.readByte(0x0234)).toBe(0xa5);
    expect(memory.readByte(0x1234)).toBe(0xa5);
    expect(memory.readByte(0x8234)).toBe(0xa5);
  });

  it('repeats internal 1K RAM but makes a fitted 16K pack contiguous', () => {
    const memory = new Zx8xMemory('zx81');
    memory.writeByte(0x4000, 0x11);
    expect(memory.readByte(0x4400)).toBe(0x11);
    expect(memory.readByte(0xc000)).toBe(0x11);

    memory.set16kExpansion(true);
    memory.writeByte(0x4400, 0x22);
    expect(memory.readByte(0x4000)).toBe(0x11);
    expect(memory.readByte(0x4400)).toBe(0x22);
    expect(memory.readByte(0xc400)).toBe(0x22);
  });

  it('keeps ROM read-only and clears only RAM on reset', () => {
    const memory = new Zx8xMemory('zx81');
    memory.loadROM(new Uint8Array([0x7e]));
    memory.writeByte(0, 0);
    memory.writeByte(0x4000, 0x55);
    memory.reset();
    expect(memory.readByte(0)).toBe(0x7e);
    expect(memory.readByte(0x4000)).toBe(0);
  });
});
