import { describe, it, expect } from 'vitest';
import {
  disasmOne, disassemble, disassembleAroundPC,
  stripMarkers, formatDisasmHtml,
} from '@/debug/z80-disasm.ts';

function disasm(bytes: number[], addr = 0): string {
  const mem = new Uint8Array(65536);
  mem.set(bytes, addr);
  const line = disasmOne(mem, addr);
  return stripMarkers(line.text);
}

/** Place bytes at `addr` and disasm there (wraps around end-of-memory). */
function disasmAt(bytes: number[], addr: number) {
  const mem = new Uint8Array(65536);
  for (let i = 0; i < bytes.length; i++) mem[(addr + i) & 0xFFFF] = bytes[i];
  return disasmOne(mem, addr);
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

// ── Coverage gaps ────────────────────────────────────────────────────────

describe('disasmOne — JR conditional', () => {
  // y=4..7 → NZ, Z, NC, C. Target = (PC + 2 + signed disp) & 0xFFFF.
  const cases: [number, string, string][] = [
    [0x20, 'NZ', '0007'],
    [0x28, 'Z', '0007'],
    [0x30, 'NC', '0007'],
    [0x38, 'C', '0007'],
  ];
  for (const [op, cc, target] of cases) {
    it(`JR ${cc},disp`, () => {
      expect(disasm([op, 0x05])).toBe(`JR ${cc},${target}`);
    });
  }

  it('JR backward (negative displacement)', () => {
    // PC=0x100, byte 0x18 + (-2): target = 0x100+2-2 = 0x100
    const mem = new Uint8Array(65536);
    mem[0x100] = 0x18; mem[0x101] = 0xFE;
    expect(stripMarkers(disasmOne(mem, 0x100).text)).toBe('JR 0100');
  });

  it('DJNZ disp', () => {
    expect(disasm([0x10, 0x10])).toBe('DJNZ 0012');
  });
});

describe('disasmOne — JP conditional', () => {
  const cases: [number, string][] = [
    [0xC2, 'NZ'], [0xCA, 'Z'], [0xD2, 'NC'], [0xDA, 'C'],
    [0xE2, 'PO'], [0xEA, 'PE'], [0xF2, 'P'],  [0xFA, 'M'],
  ];
  for (const [op, cc] of cases) {
    it(`JP ${cc},nn`, () => {
      // Conditional JP is NOT terminal (control may fall through).
      const mem = new Uint8Array(65536);
      mem[0] = op; mem[1] = 0x34; mem[2] = 0x12;
      const line = disasmOne(mem, 0);
      expect(stripMarkers(line.text)).toBe(`JP ${cc},1234`);
      expect(line.isTerminal).toBe(false);
    });
  }
});

describe('disasmOne — RET conditional + CALL conditional', () => {
  it('RET NZ is non-terminal', () => {
    const line = disasmAt([0xC0], 0);
    expect(stripMarkers(line.text)).toBe('RET NZ');
    expect(line.isTerminal).toBe(false);
  });
  it('CALL NZ,nn non-terminal', () => {
    const line = disasmAt([0xC4, 0x34, 0x12], 0);
    expect(stripMarkers(line.text)).toBe('CALL NZ,1234');
    expect(line.isTerminal).toBe(false);
  });
  it('all eight RET cc forms decode with the right condition', () => {
    const ccs = ['NZ', 'Z', 'NC', 'C', 'PO', 'PE', 'P', 'M'];
    for (let i = 0; i < 8; i++) {
      expect(disasm([0xC0 | (i << 3)])).toBe(`RET ${ccs[i]}`);
    }
  });
});

describe('disasmOne — PUSH/POP', () => {
  it('POP BC / DE / HL / AF', () => {
    expect(disasm([0xC1])).toBe('POP BC');
    expect(disasm([0xD1])).toBe('POP DE');
    expect(disasm([0xE1])).toBe('POP HL');
    expect(disasm([0xF1])).toBe('POP AF');
  });
  it('PUSH BC / DE / HL / AF', () => {
    expect(disasm([0xC5])).toBe('PUSH BC');
    expect(disasm([0xD5])).toBe('PUSH DE');
    expect(disasm([0xE5])).toBe('PUSH HL');
    expect(disasm([0xF5])).toBe('PUSH AF');
  });
  it('POP IX / PUSH IY', () => {
    expect(disasm([0xDD, 0xE1])).toBe('POP IX');
    expect(disasm([0xFD, 0xE5])).toBe('PUSH IY');
  });
});

describe('disasmOne — immediate ALU (n)', () => {
  const cases: [number, string][] = [
    [0xC6, 'ADD A,'], [0xCE, 'ADC A,'], [0xD6, 'SUB '], [0xDE, 'SBC A,'],
    [0xE6, 'AND '], [0xEE, 'XOR '], [0xF6, 'OR '],   [0xFE, 'CP '],
  ];
  for (const [op, mnem] of cases) {
    it(`${mnem.trim()}n`, () => {
      expect(disasm([op, 0x55])).toBe(`${mnem}55`);
    });
  }
});

describe('disasmOne — ADD HL,rp / ADD IX,rp', () => {
  it('ADD HL,BC / DE / HL / SP', () => {
    expect(disasm([0x09])).toBe('ADD HL,BC');
    expect(disasm([0x19])).toBe('ADD HL,DE');
    expect(disasm([0x29])).toBe('ADD HL,HL');
    expect(disasm([0x39])).toBe('ADD HL,SP');
  });
  it('ADD IX,IX (DD 29) uses IX in both positions', () => {
    expect(disasm([0xDD, 0x29])).toBe('ADD IX,IX');
  });
});

describe('disasmOne — single-byte accumulator/flag ops', () => {
  const cases: [number, string][] = [
    [0x07, 'RLCA'], [0x0F, 'RRCA'], [0x17, 'RLA'], [0x1F, 'RRA'],
    [0x27, 'DAA'],  [0x2F, 'CPL'],  [0x37, 'SCF'], [0x3F, 'CCF'],
  ];
  for (const [op, mnem] of cases) {
    it(mnem, () => { expect(disasm([op])).toBe(mnem); });
  }
});

describe('disasmOne — control & misc', () => {
  it('EXX', () => { expect(disasm([0xD9])).toBe('EXX'); });
  it('EX DE,HL', () => { expect(disasm([0xEB])).toBe('EX DE,HL'); });
  it('EX (SP),HL', () => { expect(disasm([0xE3])).toBe('EX (SP),HL'); });
  it('EX (SP),IX', () => { expect(disasm([0xDD, 0xE3])).toBe('EX (SP),IX'); });
  it('LD SP,HL', () => { expect(disasm([0xF9])).toBe('LD SP,HL'); });
  it('LD SP,IY', () => { expect(disasm([0xFD, 0xF9])).toBe('LD SP,IY'); });
  it('JP (HL) is terminal', () => {
    const line = disasmAt([0xE9], 0);
    expect(stripMarkers(line.text)).toBe('JP (HL)');
    expect(line.isTerminal).toBe(true);
  });
  it('JP (IX) is terminal', () => {
    const line = disasmAt([0xDD, 0xE9], 0);
    expect(stripMarkers(line.text)).toBe('JP (IX)');
    expect(line.isTerminal).toBe(true);
  });
  it('IN A,(n) / OUT (n),A', () => {
    expect(disasm([0xDB, 0xFE])).toBe('IN A,(FE)');
    expect(disasm([0xD3, 0x7F])).toBe('OUT (7F),A');
  });
  it('LD A,(BC) / LD A,(DE) / LD (BC),A / LD (DE),A', () => {
    expect(disasm([0x0A])).toBe('LD A,(BC)');
    expect(disasm([0x1A])).toBe('LD A,(DE)');
    expect(disasm([0x02])).toBe('LD (BC),A');
    expect(disasm([0x12])).toBe('LD (DE),A');
  });
  it('LD HL,(nn) / LD (nn),HL', () => {
    expect(disasm([0x2A, 0x00, 0x40])).toBe('LD HL,(4000)');
    expect(disasm([0x22, 0x00, 0x80])).toBe('LD (8000),HL');
  });
  it('LD A,(nn) / LD (nn),A', () => {
    expect(disasm([0x3A, 0x00, 0x40])).toBe('LD A,(4000)');
    expect(disasm([0x32, 0x00, 0x40])).toBe('LD (4000),A');
  });
});

describe('disasmOne — CB rotates exhaustive', () => {
  // All 8 rotates × 8 register targets.
  const rotates = ['RLC', 'RRC', 'RL', 'RR', 'SLA', 'SRA', 'SLL', 'SRL'];
  const regs = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'];
  it('SLL B (undocumented)', () => {
    expect(disasm([0xCB, 0x30])).toBe('SLL B');
  });
  it('every CB rotate × reg pair', () => {
    for (let y = 0; y < 8; y++) {
      for (let z = 0; z < 8; z++) {
        const op = (y << 3) | z;
        expect(disasm([0xCB, op])).toBe(`${rotates[y]} ${regs[z]}`);
      }
    }
  });
  it('every CB BIT/RES/SET form', () => {
    for (let bit = 0; bit < 8; bit++) {
      for (let z = 0; z < 8; z++) {
        expect(disasm([0xCB, 0x40 | (bit << 3) | z])).toBe(`BIT ${bit},${regs[z]}`);
        expect(disasm([0xCB, 0x80 | (bit << 3) | z])).toBe(`RES ${bit},${regs[z]}`);
        expect(disasm([0xCB, 0xC0 | (bit << 3) | z])).toBe(`SET ${bit},${regs[z]}`);
      }
    }
  });
});

describe('disasmOne — DDCB / FDCB', () => {
  it('RLC (IX+5)', () => {
    expect(disasm([0xDD, 0xCB, 0x05, 0x06])).toBe('RLC (IX+05)');
  });
  it('BIT 3,(IY-1) decodes regardless of z bits (undocumented)', () => {
    // FD CB FF 59 — y=3 bit, z=1 (would be C). Per Z80, ANY z value with
    // BIT still acts as BIT y,(IY+d). Disassembler should match.
    expect(disasm([0xFD, 0xCB, 0xFF, 0x59])).toBe('BIT 3,(IY-01)');
  });
  it('RES 0,(IX+0),B is the undocumented store-back form', () => {
    // DD CB 00 80: y=0, z=0 → RES 0,(IX+0),B
    expect(disasm([0xDD, 0xCB, 0x00, 0x80])).toBe('RES 0,(IX+00),B');
  });
  it('SET 7,(IY+10) without store-back', () => {
    expect(disasm([0xFD, 0xCB, 0x0A, 0xFE])).toBe('SET 7,(IY+0A)');
  });
  it('RLC (IX-1),C — rotate + store-back', () => {
    expect(disasm([0xDD, 0xCB, 0xFF, 0x01])).toBe('RLC (IX-01),C');
  });
});

describe('disasmOne — IX/IY half-register access (undocumented)', () => {
  it('LD A,IXH', () => { expect(disasm([0xDD, 0x7C])).toBe('LD A,IXH'); });
  it('LD A,IXL', () => { expect(disasm([0xDD, 0x7D])).toBe('LD A,IXL'); });
  it('LD A,IYH', () => { expect(disasm([0xFD, 0x7C])).toBe('LD A,IYH'); });
  it('INC IXH', () => { expect(disasm([0xDD, 0x24])).toBe('INC IXH'); });
  it('ADD A,IXL', () => { expect(disasm([0xDD, 0x85])).toBe('ADD A,IXL'); });
  it('LD (IX+d),H uses real H, NOT IXH (per the usesHL rule)', () => {
    // 0x74 = LD (HL),H ; with DD prefix and a +d disp, IXH would clash with
    // the memory operand. Sinclair/Z80 docs: H stays as H here.
    expect(disasm([0xDD, 0x74, 0x05])).toBe('LD (IX+05),H');
  });
});

describe('disasmOne — ED block instructions exhaustive', () => {
  const cases: [number, string][] = [
    [0xA0, 'LDI'], [0xA1, 'CPI'], [0xA2, 'INI'], [0xA3, 'OUTI'],
    [0xA8, 'LDD'], [0xA9, 'CPD'], [0xAA, 'IND'], [0xAB, 'OUTD'],
    [0xB0, 'LDIR'], [0xB1, 'CPIR'], [0xB2, 'INIR'], [0xB3, 'OTIR'],
    [0xB8, 'LDDR'], [0xB9, 'CPDR'], [0xBA, 'INDR'], [0xBB, 'OTDR'],
  ];
  for (const [op, mnem] of cases) {
    it(mnem, () => { expect(disasm([0xED, op])).toBe(mnem); });
  }
});

describe('disasmOne — ED LD I,A family', () => {
  const cases: [number, string][] = [
    [0x47, 'LD I,A'], [0x4F, 'LD R,A'],
    [0x57, 'LD A,I'], [0x5F, 'LD A,R'],
    [0x67, 'RRD'],    [0x6F, 'RLD'],
    [0x77, 'NOP*'],   [0x7F, 'NOP*'],
  ];
  for (const [op, mnem] of cases) {
    it(mnem, () => { expect(disasm([0xED, op])).toBe(mnem); });
  }
});

describe('disasmOne — ED IM modes', () => {
  // ED 46, 4E, 56, 5E, 66, 6E, 76, 7E. Mode table: 0,0,1,2,0,0,1,2.
  const cases: [number, string][] = [
    [0x46, 'IM 0'], [0x4E, 'IM 0'], [0x56, 'IM 1'], [0x5E, 'IM 2'],
    [0x66, 'IM 0'], [0x6E, 'IM 0'], [0x76, 'IM 1'], [0x7E, 'IM 2'],
  ];
  for (const [op, mnem] of cases) {
    it(mnem, () => { expect(disasm([0xED, op])).toBe(mnem); });
  }
});

describe('disasmOne — ED RETN / SBC HL,rp / ADC HL,rp / LD (nn),rp', () => {
  it('RETN is terminal', () => {
    const line = disasmAt([0xED, 0x45], 0);
    expect(stripMarkers(line.text)).toBe('RETN');
    expect(line.isTerminal).toBe(true);
  });
  it('SBC HL,BC', () => { expect(disasm([0xED, 0x42])).toBe('SBC HL,BC'); });
  it('ADC HL,SP', () => { expect(disasm([0xED, 0x7A])).toBe('ADC HL,SP'); });
  it('LD (nn),BC', () => {
    expect(disasm([0xED, 0x43, 0x00, 0x40])).toBe('LD (4000),BC');
  });
  it('LD DE,(nn)', () => {
    expect(disasm([0xED, 0x5B, 0x00, 0x40])).toBe('LD DE,(4000)');
  });
  it('OUT (C),0 (undocumented)', () => {
    // ED 71 — y=6, z=1
    expect(disasm([0xED, 0x71])).toBe('OUT (C),00');
  });
  it('IN (C) (undocumented y=6 in z=0)', () => {
    expect(disasm([0xED, 0x70])).toBe('IN (C)');
  });
  it('unknown ED becomes NOP* but still consumes 2 bytes', () => {
    const mem = new Uint8Array(65536);
    mem[0] = 0xED; mem[1] = 0x00;
    const line = disasmOne(mem, 0);
    expect(stripMarkers(line.text)).toBe('NOP*');
    expect(line.length).toBe(2);
  });
});

describe('disasmOne — instruction lengths exhaustive', () => {
  // Sanity-check that decoded length matches actual byte consumption.
  const cases: { bytes: number[]; expected: number }[] = [
    { bytes: [0x00], expected: 1 },                            // NOP
    { bytes: [0x3E, 0x55], expected: 2 },                       // LD A,n
    { bytes: [0x01, 0x34, 0x12], expected: 3 },                 // LD BC,nn
    { bytes: [0xCD, 0x00, 0x10], expected: 3 },                 // CALL nn
    { bytes: [0x18, 0x05], expected: 2 },                       // JR e
    { bytes: [0xCB, 0x00], expected: 2 },                       // RLC B
    { bytes: [0xED, 0xA0], expected: 2 },                       // LDI
    { bytes: [0xED, 0x43, 0x00, 0x40], expected: 4 },           // LD (nn),BC
    { bytes: [0xDD, 0x21, 0x00, 0x40], expected: 4 },           // LD IX,nn
    { bytes: [0xDD, 0x36, 0x05, 0x42], expected: 4 },           // LD (IX+d),n
    { bytes: [0xDD, 0xCB, 0x05, 0x06], expected: 4 },           // DDCB
    { bytes: [0xDD, 0xDD], expected: 1 },                       // DD prefix swallowed → NOP* len 1
  ];
  for (const { bytes, expected } of cases) {
    it(`length(${bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}) === ${expected}`, () => {
      const mem = new Uint8Array(65536);
      mem.set(bytes, 0);
      expect(disasmOne(mem, 0).length).toBe(expected);
    });
  }
});

// ── REAL BUG: PC wraparound at 0xFFFF ───────────────────────────────────

describe('disasmOne — PC wraparound', () => {
  it('reports a positive length when an instruction wraps past 0xFFFF', () => {
    // LD BC,1234 placed at 0xFFFE — opcode at FFFE, lo at FFFF, hi at 0000.
    const line = disasmAt([0x01, 0x34, 0x12], 0xFFFE);
    expect(stripMarkers(line.text)).toBe('LD BC,1234');
    expect(line.length).toBe(3);
  });

  it('reports length 1 for a single-byte instruction at 0xFFFF', () => {
    // NOP at 0xFFFF wraps the read pointer back to 0 after consumption.
    const line = disasmAt([0x00], 0xFFFF);
    expect(line.length).toBe(1);
  });

  it('multi-line disassembly continues correctly past the wrap', () => {
    const mem = new Uint8Array(65536);
    mem[0xFFFF] = 0x00; // NOP
    mem[0x0000] = 0x00; // NOP
    const lines = disassemble(mem, 0xFFFF, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0].addr).toBe(0xFFFF);
    expect(lines[1].addr).toBe(0x0000);
  });
});

// ── disassembleAroundPC ──────────────────────────────────────────────────

describe('disassembleAroundPC', () => {
  it('places PC at index `before` when context exists', () => {
    // Fill with NOPs so any starting offset decodes the same.
    const mem = new Uint8Array(65536); // all 0 = NOPs
    const lines = disassembleAroundPC(mem, 0x100, 24, 6);
    const idx = lines.findIndex(l => l.addr === 0x100);
    expect(idx).toBe(6);
  });

  it('returns the requested number of lines', () => {
    const mem = new Uint8Array(65536);
    const lines = disassembleAroundPC(mem, 0x200, 24, 6);
    expect(lines.length).toBe(24);
  });

  it('aligns to the longest-context valid path through variable-length code', () => {
    const mem = new Uint8Array(65536);
    // Build a stream of 2-byte instructions (LD A,n × N) ending at PC.
    // Any "wrong" odd offset would desync — the function should pick the
    // even offset and include PC.
    for (let i = 0; i < 64; i += 2) { mem[i] = 0x3E; mem[i + 1] = i; }
    const pc = 0x20;
    const lines = disassembleAroundPC(mem, pc, 10, 4);
    const idx = lines.findIndex(l => l.addr === pc);
    expect(idx).toBeGreaterThanOrEqual(0);
    // Every line should be the 2-byte LD A,n we planted — proves alignment.
    for (const l of lines) {
      expect(stripMarkers(l.text).startsWith('LD A,')).toBe(true);
    }
  });

  it('always includes the PC line in the returned window (default sizes)', () => {
    // Sweep a few PCs across a NOP-filled program — PC must always show up.
    const mem = new Uint8Array(65536);
    for (const pc of [0x100, 0x123, 0x200, 0x4567]) {
      const lines = disassembleAroundPC(mem, pc);
      expect(lines.some(l => l.addr === pc), `pc ${pc.toString(16)} missing`).toBe(true);
    }
  });

  it('keeps PC in the window when totalLines is smaller than `before`', () => {
    // Degenerate config: 4 total lines, 6 before. PC must still be in the
    // result — the function should squeeze `before` to fit.
    const mem = new Uint8Array(65536);
    const lines = disassembleAroundPC(mem, 0x100, 4, 6);
    expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.some(l => l.addr === 0x100)).toBe(true);
  });

  it('PC lands at the last slot when totalLines fits exactly', () => {
    // totalLines=4, before=6: target = min(6, bestBefore, 3) = 3. PC at idx 3.
    const mem = new Uint8Array(65536); // NOPs everywhere
    const lines = disassembleAroundPC(mem, 0x100, 4, 6);
    const idx = lines.findIndex(l => l.addr === 0x100);
    expect(idx).toBe(3);
  });

  it('keeps PC in the window when totalLines equals 1', () => {
    const mem = new Uint8Array(65536);
    const lines = disassembleAroundPC(mem, 0x100, 1, 6);
    expect(lines.length).toBe(1);
    expect(lines[0].addr).toBe(0x100);
  });
});

// ── stripMarkers / formatDisasmHtml ──────────────────────────────────────

describe('stripMarkers', () => {
  it('removes all three marker bytes', () => {
    expect(stripMarkers('\x01a\x01\x02b\x02\x03c\x03')).toBe('abc');
  });
  it('returns the input unchanged when no markers present', () => {
    expect(stripMarkers('NOP')).toBe('NOP');
  });
});

describe('formatDisasmHtml', () => {
  function lines(bytes: number[]) {
    const mem = new Uint8Array(65536);
    mem.set(bytes, 0);
    return { mem, lines: disassemble(mem, 0, 10) };
  }

  it('emits an <span class="d-off"> with the address in hex', () => {
    const { mem, lines: ls } = lines([0x00]);
    const html = formatDisasmHtml(ls, mem, 0xFFFF);
    expect(html).toContain('<span class="d-off">0000</span>');
  });

  it('tags the current-PC line with d-cur and others without', () => {
    const { mem, lines: ls } = lines([0x00, 0x00, 0x00]);
    const html = formatDisasmHtml(ls, mem, ls[1].addr);
    // Only one d-cur in the output.
    const matches = html.match(/d-cur/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('tags breakpoint addresses with d-bp', () => {
    const { mem, lines: ls } = lines([0x00, 0x00, 0x00]);
    const html = formatDisasmHtml(ls, mem, 0xFFFF, new Set([ls[2].addr]));
    expect(html).toContain('d-bp');
    // Only the requested address gets it.
    const matches = html.match(/d-bp/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('PC that is also a breakpoint gets both classes', () => {
    const { mem, lines: ls } = lines([0x00]);
    const html = formatDisasmHtml(ls, mem, 0, new Set([0]));
    expect(html).toContain('d-cur');
    expect(html).toContain('d-bp');
  });

  it('renders raw bytes in hex, padded to a stable width', () => {
    const { mem, lines: ls } = lines([0x00, 0x3E, 0x42]); // NOP, LD A,42
    const html = formatDisasmHtml(ls, mem, 0xFFFF);
    expect(html).toContain('<span class="d-hex">00         </span>');
    expect(html).toContain('<span class="d-hex">3E 42      </span>');
  });

  it('colorizes value / address / port operands into distinct spans', () => {
    // LD A,42 → d-val (immediate). JP nn → d-adr. OUT (n),A → d-port.
    const mem = new Uint8Array(65536);
    mem[0] = 0x3E; mem[1] = 0x42;             // LD A,42
    mem[2] = 0xD3; mem[3] = 0xFE;             // OUT (FE),A
    mem[4] = 0xC3; mem[5] = 0x00; mem[6] = 0x10; // JP 1000
    const ls = disassemble(mem, 0, 10);
    const html = formatDisasmHtml(ls, mem, 0xFFFF);
    expect(html).toContain('<span class="d-val">42</span>');
    expect(html).toContain('<span class="d-port">FE</span>');
    expect(html).toContain('<span class="d-adr">1000</span>');
  });

  it('writes data-addr as a decimal number (consumers may parseInt it)', () => {
    const { mem, lines: ls } = lines([0x00]);
    const html = formatDisasmHtml(ls, mem, 0);
    expect(html).toContain('data-addr="0"');
  });
});

// ── Negative-displacement style on DD/FD ────────────────────────────────

describe('disasmOne — displacement formatting', () => {
  it('+00 for zero displacement', () => {
    expect(disasm([0xDD, 0x86, 0x00])).toBe('ADD A,(IX+00)');
  });
  it('-80 for the most negative displacement', () => {
    expect(disasm([0xDD, 0x86, 0x80])).toBe('ADD A,(IX-80)');
  });
  it('+7F for the most positive displacement', () => {
    expect(disasm([0xDD, 0x86, 0x7F])).toBe('ADD A,(IX+7F)');
  });
});
