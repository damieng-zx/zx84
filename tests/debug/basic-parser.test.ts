import { describe, it, expect } from 'vitest';
import { parseBasicProgram } from '@/debug/basic-parser.ts';

function buildBasicMemory(lines: { num: number; text: number[] }[]): Uint8Array {
  const mem = new Uint8Array(65536);

  const progAddr = 0x8000;
  mem[0x5C53] = progAddr & 0xFF;
  mem[0x5C54] = (progAddr >> 8) & 0xFF;

  let offset = progAddr;
  for (const line of lines) {
    mem[offset] = (line.num >> 8) & 0xFF;
    mem[offset + 1] = line.num & 0xFF;
    const lineLen = line.text.length + 1;
    mem[offset + 2] = lineLen & 0xFF;
    mem[offset + 3] = (lineLen >> 8) & 0xFF;
    for (let i = 0; i < line.text.length; i++) {
      mem[offset + 4 + i] = line.text[i];
    }
    mem[offset + 4 + line.text.length] = 0x0D;
    offset += 4 + lineLen;
  }

  const varsAddr = offset;
  mem[0x5C4B] = varsAddr & 0xFF;
  mem[0x5C4C] = (varsAddr >> 8) & 0xFF;

  return mem;
}

describe('parseBasicProgram — empty/invalid', () => {
  it('returns no-program message when PROG is 0', () => {
    const mem = new Uint8Array(65536);
    const result = parseBasicProgram(mem);
    expect(result).toContain('no BASIC program');
  });

  it('returns no-program when PROG >= VARS', () => {
    const mem = new Uint8Array(65536);
    mem[0x5C53] = 0x00; mem[0x5C54] = 0x80;
    mem[0x5C4B] = 0x00; mem[0x5C4C] = 0x70;
    const result = parseBasicProgram(mem);
    expect(result).toContain('no BASIC program');
  });

  it('returns empty-program when there are no lines', () => {
    const mem = new Uint8Array(65536);
    const progAddr = 0x8000;
    mem[0x5C53] = progAddr & 0xFF; mem[0x5C54] = (progAddr >> 8) & 0xFF;
    const varsAddr = progAddr + 2;
    mem[0x5C4B] = varsAddr & 0xFF; mem[0x5C4C] = (varsAddr >> 8) & 0xFF;
    mem[progAddr] = 0x80;
    const result = parseBasicProgram(mem);
    expect(result).toContain('empty program');
  });
});

describe('parseBasicProgram — simple lines', () => {
  it('parses a simple PRINT line', () => {
    const mem = buildBasicMemory([
      { num: 10, text: [0xF5, 0x22, 0x48, 0x49, 0x22] },
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('10');
    expect(result).toContain('PRINT');
    expect(result).toContain('"HI"');
  });

  it('parses a LET assignment', () => {
    const mem = buildBasicMemory([
      { num: 10, text: [0xF1, 0x61, 0x3D, 0x31, 0x32, 0x33, 0x0E, 0x00, 0x00, 0x7B, 0x00, 0x00] },
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('10');
    expect(result).toContain('LET');
    expect(result).toContain('a');
    expect(result).toContain('123');
  });

  it('parses multiple lines', () => {
    const mem = buildBasicMemory([
      { num: 10, text: [0xF5, 0x22, 0x48, 0x49, 0x22] },
      { num: 20, text: [0xF7] },
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('10');
    expect(result).toContain('20');
    expect(result).toContain('PRINT');
    expect(result).toContain('RUN');
  });

  it('detokenizes 128K-only tokens', () => {
    const mem = buildBasicMemory([
      { num: 1, text: [0xA3] },
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('SPECTRUM');
  });
});

describe('parseBasicProgram — line numbers', () => {
  it('pads line numbers', () => {
    const mem = buildBasicMemory([
      { num: 1, text: [0xF7] },
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toMatch(/\b\s*1\b/);
  });

  it('handles high line numbers', () => {
    const mem = buildBasicMemory([
      { num: 9999, text: [0xF7] },
    ]);
    const result = parseBasicProgram(mem);
    expect(result).toContain('9999');
  });
});
