import { describe, it, expect } from 'vitest';
import { saveZ80, loadZ80 } from '@/snapshot/z80format.ts';
import { Z80 } from '@/cores/z80.ts';
import { SpectrumMemory } from '@/memory.ts';

function roundTrip(originalBank: Uint8Array, bankIndex: number, is128K: boolean): Uint8Array {
  const cpu = new Z80();
  const memory = new SpectrumMemory(is128K ? '128k' : '48k');
  memory.loadROM(new Uint8Array(16384));

  const target = memory.getRamBank(bankIndex);
  target.set(originalBank);

  const saved = saveZ80(cpu, memory, 0, is128K);

  const cpu2 = new Z80();
  const memory2 = new SpectrumMemory(is128K ? '128k' : '48k');
  memory2.loadROM(new Uint8Array(16384));
  loadZ80(saved, cpu2, memory2);

  return memory2.getRamBank(bankIndex);
}

describe('Z80 compression — ED byte handling', () => {
  it('round-trips a solitary 0xED followed by an RLE-run of 5 bytes', () => {
    const bank = new Uint8Array(16384);
    bank[0] = 0xED;
    for (let i = 1; i <= 5; i++) bank[i] = 0x00;

    const result = roundTrip(bank, 5, false);

    expect(result[0]).toBe(0xED);
    for (let i = 1; i <= 5; i++) expect(result[i]).toBe(0x00);
  });

  it('round-trips a solitary 0xED not followed by an RLE-run', () => {
    const bank = new Uint8Array(16384);
    bank[0] = 0xED;
    bank[1] = 0x42;

    const result = roundTrip(bank, 5, false);

    expect(result[0]).toBe(0xED);
    expect(result[1]).toBe(0x42);
  });

  it('round-trips consecutive 0xED 0xED pairs', () => {
    const bank = new Uint8Array(16384);
    bank[0] = 0xED;
    bank[1] = 0xED;
    bank[2] = 0xED;
    bank[3] = 0x55;

    const result = roundTrip(bank, 5, false);

    expect(result[0]).toBe(0xED);
    expect(result[1]).toBe(0xED);
    expect(result[2]).toBe(0xED);
    expect(result[3]).toBe(0x55);
  });

  it('round-trips a single trailing 0xED at end of bank', () => {
    const bank = new Uint8Array(16384);
    bank[16383] = 0xED;

    const result = roundTrip(bank, 5, false);

    expect(result[16383]).toBe(0xED);
  });

  it('round-trips 0xED at the boundary before a long run of identical bytes', () => {
    const bank = new Uint8Array(16384);
    bank[100] = 0xED;
    for (let i = 101; i < 200; i++) bank[i] = 0xAA;

    const result = roundTrip(bank, 0, true);

    expect(result[100]).toBe(0xED);
    for (let i = 101; i < 200; i++) expect(result[i]).toBe(0xAA);
  });
});
