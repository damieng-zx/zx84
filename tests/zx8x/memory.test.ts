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

  it('maps the Memotech overlay RAM and expansion ROM', () => {
    const memory = new Zx8xMemory('zx81');
    memory.setMemotechHrg(true);
    memory.loadHrgROM(new Uint8Array([0xa5]));
    memory.writeByte(0x0012, 0x3c);
    expect(memory.readMemotechOverlay(0x12)).toBe(0x3c);
    expect(memory.readByte(0x2000)).toBe(0xa5);
    expect(memory.hasUdgRam).toBe(false);
    expect(memory.hasWrxRam).toBe(false);
  });

  it('maps QuickSilva ROM and its non-mirrored framebuffer', () => {
    const memory = new Zx8xMemory('zx81');
    memory.setQuickSilvaHrg(true);
    memory.loadHrgROM(new Uint8Array([0x5a]));
    memory.writeByte(0xa000, 0xc3);
    expect(memory.readByte(0x2800)).toBe(0x5a);
    expect(memory.readByte(0xa000)).toBe(0xc3);
    expect(memory.readByte(0x2000)).not.toBe(0xc3);
  });

  it('keeps all five ZX81 graphics boards mutually exclusive', () => {
    const memory = new Zx8xMemory('zx81');
    memory.setUdgRam(true);
    memory.setUdg128Ram(true);
    expect(memory.hasUdgRam).toBe(false);
    expect(memory.hasUdg128Ram).toBe(true);
    memory.setQuickSilvaHrg(true);
    expect(memory.hasUdg128Ram).toBe(false);
    expect(memory.hasQuickSilvaHrg).toBe(true);
  });
});
