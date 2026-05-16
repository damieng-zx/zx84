import { describe, it, expect } from 'vitest';
import { hex8, hex16, HEX8, HEX16 } from '@/utils/hex.ts';

describe('HEX8 lookup table', () => {
  it('has 256 entries', () => {
    expect(HEX8).toHaveLength(256);
  });

  it('contains correct values for boundaries', () => {
    expect(HEX8[0]).toBe('00');
    expect(HEX8[127]).toBe('7F');
    expect(HEX8[255]).toBe('FF');
  });

  it('produces uppercase hex', () => {
    expect(HEX8[0xAB]).toBe('AB');
    expect(HEX8[10]).toBe('0A');
  });
});

describe('HEX16 lookup table', () => {
  it('has 65536 entries', () => {
    expect(HEX16).toHaveLength(65536);
  });

  it('contains correct values for boundaries', () => {
    expect(HEX16[0]).toBe('0000');
    expect(HEX16[0xFFFF]).toBe('FFFF');
    expect(HEX16[0x1234]).toBe('1234');
  });
});

describe('hex8', () => {
  it('formats a byte as 2-char uppercase hex', () => {
    expect(hex8(0)).toBe('00');
    expect(hex8(255)).toBe('FF');
    expect(hex8(0x0A)).toBe('0A');
  });

  it('masks to 8 bits', () => {
    expect(hex8(0x1FF)).toBe('FF');
    expect(hex8(0x100)).toBe('00');
  });
});

describe('hex16', () => {
  it('formats a word as 4-char uppercase hex', () => {
    expect(hex16(0)).toBe('0000');
    expect(hex16(0xFFFF)).toBe('FFFF');
    expect(hex16(0x1234)).toBe('1234');
  });

  it('masks to 16 bits', () => {
    expect(hex16(0x10000)).toBe('0000');
    expect(hex16(0x1FFFF)).toBe('FFFF');
  });
});
