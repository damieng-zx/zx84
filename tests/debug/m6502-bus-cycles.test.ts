/**
 * Which cycle of a 6502 instruction a bus access falls on (src/debug/m6502/bus-cycles.ts).
 * Cycle numbers are the datasheet's: the opcode is fetched on cycle 1.
 */

import { describe, it, expect } from 'vitest';
import { accessCycle, instructionLength, isReadModifyWrite } from '@/debug/m6502/bus-cycles.ts';

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
