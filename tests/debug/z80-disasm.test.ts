import { describe, it, expect } from 'vitest';
import { disasmOne, disassemble, stripMarkers } from '@/debug/z80-disasm.ts';

function disasm(bytes: number[], addr = 0): string {
  const mem = new Uint8Array(65536);
  mem.set(bytes, addr);
  const line = disasmOne(mem, addr);
  return stripMarkers(line.text);
}

describe('disasmOne — basic opcodes', () => {
  it('decodes NOP', () => {
    expect(disasm([0x00])).toBe('NOP');
  });

  it('decodes LD BC,nn', () => {
    expect(disasm([0x01, 0x34, 0x12])).toBe('LD BC,1234');
  });

  it('decodes INC BC', () => {
    expect(disasm([0x03])).toBe('INC BC');
  });

  it('decodes INC B', () => {
    expect(disasm([0x04])).toBe('INC B');
  });

  it('decodes DEC B', () => {
    expect(disasm([0x05])).toBe('DEC B');
  });

  it('decodes LD B,n', () => {
    expect(disasm([0x06, 0x42])).toBe('LD B,42');
  });

  it('decodes RLCA', () => {
    expect(disasm([0x07])).toBe('RLCA');
  });

  it('decodes EX AF,AF\'', () => {
    expect(disasm([0x08])).toBe("EX AF,AF'");
  });

  it('decodes LD (nn),HL', () => {
    expect(disasm([0x22, 0x00, 0x80])).toBe('LD (8000),HL');
  });

  it('decodes LD (nn),A', () => {
    expect(disasm([0x32, 0x00, 0xC0])).toBe('LD (C000),A');
  });

  it('decodes HALT', () => {
    const mem = new Uint8Array(65536);
    mem[0] = 0x76;
    const line = disasmOne(mem, 0);
    expect(stripMarkers(line.text)).toBe('HALT');
    expect(line.isTerminal).toBe(true);
  });
});

describe('disasmOne — LD r,r\'', () => {
  it('decodes LD A,B', () => {
    expect(disasm([0x78])).toBe('LD A,B');
  });

  it('decodes LD B,C', () => {
    expect(disasm([0x41])).toBe('LD B,C');
  });

  it('decodes LD H,L', () => {
    expect(disasm([0x65])).toBe('LD H,L');
  });

  it('decodes LD (HL),A', () => {
    expect(disasm([0x77])).toBe('LD (HL),A');
  });
});

describe('disasmOne — ALU ops', () => {
  it('decodes ADD A,B', () => {
    expect(disasm([0x80])).toBe('ADD A,B');
  });

  it('decodes XOR A', () => {
    expect(disasm([0xAF])).toBe('XOR A');
  });

  it('decodes CP (HL)', () => {
    expect(disasm([0xBE])).toBe('CP (HL)');
  });
});

describe('disasmOne — CB prefix', () => {
  it('decodes RLC B', () => {
    expect(disasm([0xCB, 0x00])).toBe('RLC B');
  });

  it('decodes BIT 7,A', () => {
    expect(disasm([0xCB, 0x7F])).toBe('BIT 7,A');
  });

  it('decodes SET 2,(HL)', () => {
    expect(disasm([0xCB, 0xD6])).toBe('SET 2,(HL)');
  });

  it('decodes RES 0,B', () => {
    expect(disasm([0xCB, 0x80])).toBe('RES 0,B');
  });
});

describe('disasmOne — ED prefix', () => {
  it('decodes LDI', () => {
    expect(disasm([0xED, 0xA0])).toBe('LDI');
  });

  it('decodes LDIR', () => {
    expect(disasm([0xED, 0xB0])).toBe('LDIR');
  });

  it('decodes IM 2', () => {
    expect(disasm([0xED, 0x5E])).toBe('IM 2');
  });

  it('decodes RETI', () => {
    const mem = new Uint8Array(65536);
    mem[0] = 0xED; mem[1] = 0x4D;
    const line = disasmOne(mem, 0);
    expect(stripMarkers(line.text)).toBe('RETI');
    expect(line.isTerminal).toBe(true);
  });

  it('decodes OUT (C),A', () => {
    expect(disasm([0xED, 0x79])).toBe('OUT (C),A');
  });

  it('decodes IN A,(C)', () => {
    expect(disasm([0xED, 0x78])).toBe('IN A,(C)');
  });

  it('decodes NEG', () => {
    expect(disasm([0xED, 0x44])).toBe('NEG');
  });

  it('decodes RRD', () => {
    expect(disasm([0xED, 0x67])).toBe('RRD');
  });
});

describe('disasmOne — DD/FD prefix (IX/IY)', () => {
  it('decodes LD IX,nn', () => {
    expect(disasm([0xDD, 0x21, 0x00, 0x40])).toBe('LD IX,4000');
  });

  it('decodes LD IY,nn', () => {
    expect(disasm([0xFD, 0x21, 0x00, 0x80])).toBe('LD IY,8000');
  });

  it('decodes LD (IX+d),n', () => {
    expect(disasm([0xDD, 0x36, 0x05, 0x42])).toBe('LD (IX+05),42');
  });

  it('decodes ADD IX,BC', () => {
    expect(disasm([0xDD, 0x09])).toBe('ADD IX,BC');
  });

  it('treats DD DD as NOP*', () => {
    expect(disasm([0xDD, 0xDD])).toBe('NOP*');
  });

  it('treats DD ED as NOP*', () => {
    expect(disasm([0xDD, 0xED])).toBe('NOP*');
  });
});

describe('disasmOne — jumps and calls', () => {
  it('decodes JP nn', () => {
    const mem = new Uint8Array(65536);
    mem[0] = 0xC3; mem[1] = 0x00; mem[2] = 0x10;
    const line = disasmOne(mem, 0);
    expect(stripMarkers(line.text)).toBe('JP 1000');
    expect(line.isTerminal).toBe(true);
  });

  it('decodes JR e', () => {
    const mem = new Uint8Array(65536);
    mem[0] = 0x18; mem[1] = 0x05;
    const line = disasmOne(mem, 0);
    expect(stripMarkers(line.text)).toBe('JR 0007');
    expect(line.isTerminal).toBe(true);
  });

  it('decodes CALL nn', () => {
    const mem = new Uint8Array(65536);
    mem[0] = 0xCD; mem[1] = 0x34; mem[2] = 0x12;
    const line = disasmOne(mem, 0);
    expect(stripMarkers(line.text)).toBe('CALL 1234');
  });

  it('decodes RET', () => {
    const mem = new Uint8Array(65536);
    mem[0] = 0xC9;
    const line = disasmOne(mem, 0);
    expect(stripMarkers(line.text)).toBe('RET');
    expect(line.isTerminal).toBe(true);
  });

  it('decodes RST 08', () => {
    expect(disasm([0xCF])).toBe('RST 0008');
  });

  it('decodes DI / EI', () => {
    expect(disasm([0xF3])).toBe('DI');
    expect(disasm([0xFB])).toBe('EI');
  });
});

describe('disasmOne — instruction length', () => {
  it('1-byte instruction', () => {
    const mem = new Uint8Array(65536);
    mem[0] = 0x00;
    expect(disasmOne(mem, 0).length).toBe(1);
  });

  it('2-byte instruction (LD B,n)', () => {
    const mem = new Uint8Array(65536);
    mem[0] = 0x06; mem[1] = 0x42;
    expect(disasmOne(mem, 0).length).toBe(2);
  });

  it('3-byte instruction (LD BC,nn)', () => {
    const mem = new Uint8Array(65536);
    mem[0] = 0x01; mem[1] = 0x34; mem[2] = 0x12;
    expect(disasmOne(mem, 0).length).toBe(3);
  });

  it('4-byte DD CB instruction', () => {
    const mem = new Uint8Array(65536);
    mem[0] = 0xDD; mem[1] = 0xCB; mem[2] = 0x05; mem[3] = 0x06;
    expect(disasmOne(mem, 0).length).toBe(4);
  });
});

describe('disassemble — multi-line', () => {
  it('disassembles a sequence of instructions', () => {
    const mem = new Uint8Array(65536);
    mem[0] = 0x3E; mem[1] = 0x0A;
    mem[2] = 0xD3; mem[3] = 0xFE;
    mem[4] = 0x76;
    const lines = disassemble(mem, 0, 10);
    expect(lines).toHaveLength(3);
    expect(stripMarkers(lines[0].text)).toBe('LD A,0A');
    expect(stripMarkers(lines[1].text)).toBe('OUT (FE),A');
    expect(stripMarkers(lines[2].text)).toBe('HALT');
  });

  it('stops at terminal instructions', () => {
    const mem = new Uint8Array(65536);
    mem[0] = 0xC3; mem[1] = 0x00; mem[2] = 0x00;
    mem[3] = 0x00;
    const lines = disassemble(mem, 0, 10);
    expect(lines).toHaveLength(1);
    expect(stripMarkers(lines[0].text)).toBe('JP 0000');
  });
});
