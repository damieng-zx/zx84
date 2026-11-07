/**
 * Which cycle of a 6502 instruction a bus access falls on (src/debug/m6502/bus-cycles.ts).
 * Cycle numbers are the datasheet's: the opcode is fetched on cycle 1.
 */

import { describe, it, expect } from 'vitest';
import { accessCycle, accessTime, baseCycles, instructionLength, isReadModifyWrite } from '@/debug/m6502/bus-cycles.ts';

describe('6502 bus cycles', () => {
  it('knows the length of every addressing mode', () => {
    expect(instructionLength(0xEA)).toBe(1);   // NOP
    expect(instructionLength(0xA9)).toBe(2);   // LDA #
    expect(instructionLength(0xA5)).toBe(2);   // LDA zp
    expect(instructionLength(0xAD)).toBe(3);   // LDA abs
    expect(instructionLength(0xBD)).toBe(3);   // LDA abs,X
    expect(instructionLength(0xB1)).toBe(2);   // LDA (zp),Y
    expect(instructionLength(0x4C)).toBe(3);   // JMP
  });

  it('knows the read-modify-write opcodes', () => {
    for (const op of [0xE6, 0xEE, 0xFE, 0xC6, 0x06, 0x1E, 0x4E, 0x2E, 0x6E, 0xE7, 0xDF]) expect(isReadModifyWrite(op)).toBe(true);
    for (const op of [0xA5, 0xAD, 0x85, 0x8D, 0x4C, 0xEA, 0x20]) expect(isReadModifyWrite(op)).toBe(false);
  });

  it('puts the opcode and operand fetches on cycles 1, 2 and 3', () => {
    // LDA $1234 at $E000: 4 cycles.
    expect(accessCycle(0xAD, 0xE000, 0xE000, false, 4)).toBe(1);
    expect(accessCycle(0xAD, 0xE000, 0xE001, false, 4)).toBe(2);
    expect(accessCycle(0xAD, 0xE000, 0xE002, false, 4)).toBe(3);
    // ...and across the top of memory.
    expect(accessCycle(0xAD, 0xFFFF, 0x0001, false, 4)).toBe(3);
  });

  it('reads a load on its last cycle and writes a store on its last', () => {
    expect(accessCycle(0xAD, 0xE000, 0x1234, false, 4)).toBe(4);       // LDA abs
    expect(accessCycle(0xBD, 0xE000, 0x1234, false, 5)).toBe(5);       // LDA abs,X across a page
    expect(accessCycle(0xA5, 0xE000, 0x0080, false, 3)).toBe(3);       // LDA zp
    expect(accessCycle(0x8D, 0xE000, 0x1234, true, 4)).toBe(4);        // STA abs
    expect(accessCycle(0x85, 0xE000, 0x0080, true, 3)).toBe(3);        // STA zp
  });

  it('reads a read-modify-write two cycles before its end and writes on its last', () => {
    expect(accessCycle(0xE6, 0xE000, 0x0080, false, 5)).toBe(3);       // INC zp
    expect(accessCycle(0xE6, 0xE000, 0x0080, true, 5)).toBe(5);
    expect(accessCycle(0xEE, 0xE000, 0x1234, false, 6)).toBe(4);       // INC abs
    expect(accessCycle(0xFE, 0xE000, 0x1234, false, 7)).toBe(5);       // INC abs,X
    expect(accessCycle(0xF6, 0xE000, 0x0080, false, 6)).toBe(4);       // INC zp,X
    expect(accessCycle(0xE3, 0xE000, 0x0080, false, 8)).toBe(6);       // ISC (zp,X)
  });
});

describe('baseCycles and accessTime', () => {
  it('measures the documented base cycles of the core', () => {
    expect(baseCycles(0xA9, false)).toBe(2);   // LDA #
    expect(baseCycles(0xAD, false)).toBe(4);   // LDA abs
    expect(baseCycles(0x8D, false)).toBe(4);   // STA abs
    expect(baseCycles(0x9D, false)).toBe(5);   // STA abs,X
    expect(baseCycles(0xEE, false)).toBe(6);   // INC abs
    expect(baseCycles(0x20, false)).toBe(6);   // JSR
    expect(baseCycles(0x9C, true)).toBe(4);    // STZ abs (65C02)
  });
  it('puts a store on its last cycle and a soft-switch read on its own', () => {
    // STA $C050 at $0300, starting at cycle 1000: the write is cycle 4.
    expect(accessTime(1000, 0x8D, 0x0300, 0xC050, true, false)).toBe(1003);
    // LDA $C054 reads on cycle 4; the opcode fetch is cycle 1.
    expect(accessTime(1000, 0xAD, 0x0300, 0xC054, false, false)).toBe(1003);
    expect(accessTime(1000, 0xAD, 0x0300, 0x0300, false, false)).toBe(1000);
    // INC abs reads on cycle 4 and writes on cycle 6.
    expect(accessTime(1000, 0xEE, 0x0300, 0x2000, false, false)).toBe(1003);
    expect(accessTime(1000, 0xEE, 0x0300, 0x2000, true, false)).toBe(1005);
    expect(accessTime(1000, -1, 0x0300, 0x2000, true, false)).toBe(1000);
  });

  it('puts an indexed load that crosses a page a cycle later, and nothing else', () => {
    // LDA abs,X is 4 cycles, 5 when the index carries into the high byte; the
    // read is on the last. A store is 5 either way, and so is INC abs,X's 7.
    expect(accessTime(1000, 0xBD, 0x0300, 0xC100, false, false, false)).toBe(1003);
    expect(accessTime(1000, 0xBD, 0x0300, 0xC100, false, false, true)).toBe(1004);
    expect(accessTime(1000, 0xB1, 0x0300, 0xC100, false, false, true)).toBe(1005);   // LDA (zp),Y: 5, 6 across
    expect(accessTime(1000, 0x9D, 0x0300, 0xC100, true, false, true)).toBe(1004);    // STA abs,X
    expect(accessTime(1000, 0xFE, 0x0300, 0xC100, false, false, true)).toBe(1004);   // INC abs,X reads on cycle 5
    // The 65C02's ASL abs,X is 6 cycles, 7 across a page; it reads two before the end.
    expect(accessTime(1000, 0x1E, 0x0300, 0xC100, false, true, false)).toBe(1003);
    expect(accessTime(1000, 0x1E, 0x0300, 0xC100, false, true, true)).toBe(1004);
    expect(accessTime(1000, 0x1E, 0x0300, 0xC100, true, true, true)).toBe(1006);
  });

  it('knows the Rockwell part: RMB zp is 5 cycles, 3 bytes for BBR', () => {
    expect(baseCycles(0x37, 'r65c02')).toBe(5);
    expect(baseCycles(0x37, true)).toBe(1);                // a one-cycle NOP on the base part
    // RMB3 $20 reads the byte on cycle 3 and writes it on 5.
    expect(accessTime(1000, 0x37, 0x0300, 0x0020, false, 'r65c02')).toBe(1002);
    expect(accessTime(1000, 0x37, 0x0300, 0x0020, true, 'r65c02')).toBe(1004);
    // BBR0 $20,rel: the opcode, the zero-page address and the offset are 3 bytes.
    expect(accessTime(1000, 0x0F, 0x0300, 0x0302, false, 'r65c02')).toBe(1002);
    // SMB3 ($B7) is an RMW too, though $B7 is LAX on the NMOS part.
    expect(accessTime(1000, 0xB7, 0x0300, 0x0020, false, 'r65c02')).toBe(1002);
    expect(accessTime(1000, 0xB7, 0x0300, 0x0020, false, false)).toBe(1003);
  });

  it('reads TSB and TRB two cycles before their end on a 65C02 (they are NOPs on the NMOS part)', () => {
    expect(accessTime(1000, 0x0C, 0x0300, 0xC050, false, true)).toBe(1003);    // TSB abs: 6 cycles, read on 4
    expect(accessTime(1000, 0x0C, 0x0300, 0xC050, true, true)).toBe(1005);
    expect(accessTime(1000, 0x0C, 0x0300, 0xC050, false, false)).toBe(1003);   // NOP abs: 4 cycles, reads on 4
  });
});
