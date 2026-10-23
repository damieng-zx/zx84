/**
 * Which cycle of a 6502 instruction a bus access falls on.
 *
 * The 6502 core adds an instruction's cycles after its body, so while the CPU's
 * read and write callbacks run, its cycle count is still the instruction's
 * start. A debugger that wants to say *when* an access happened works the cycle
 * out afterwards from the opcode:
 *
 *  - the opcode and its operand bytes are fetched on cycles 1, 2, 3 in order;
 *  - a store writes on the last cycle;
 *  - a load reads on the last cycle (a page-crossing indexed load pays its extra
 *    cycle before it);
 *  - a read-modify-write reads two cycles before the end, writes the old value
 *    back (the dummy write, not modelled by the core) on the cycle before the
 *    end, and writes the new one on the last. That is true of every addressing
 *    mode: INC zp is 5 cycles and reads on the 3rd; INC abs,X is 7 and reads on
 *    the 5th.
 *
 * Anything else (the stack traffic of JSR, RTS, RTI, PHA, PLA and BRK, the
 * indirect pointer of JMP, interrupt entry) is put on the last cycle, which is
 * inside the instruction but not necessarily its exact cycle. This module
 * imports only the disassembler's opcode table.
 */

import { disasmOne } from './disasm.ts';

/** Instruction length by opcode, built from the disassembler's table. */
const LENGTH = new Uint8Array(256);
{
  const buf = new Uint8Array(3);
  for (let op = 0; op < 256; op++) {
    buf[0] = op;
    LENGTH[op] = disasmOne(buf, 0).length;
  }
}

/** Read-modify-write opcodes: ASL LSR ROL ROR INC DEC on memory, and the
 *  undocumented SLO RLA SRE RRA DCP ISC in all their addressing modes. */
const RMW = new Uint8Array(256);
for (const op of [
  0x06, 0x0E, 0x16, 0x1E, 0x46, 0x4E, 0x56, 0x5E, 0x26, 0x2E, 0x36, 0x3E,
  0x66, 0x6E, 0x76, 0x7E, 0xC6, 0xCE, 0xD6, 0xDE, 0xE6, 0xEE, 0xF6, 0xFE,
  0x03, 0x07, 0x0F, 0x13, 0x17, 0x1B, 0x1F,   // SLO
  0x23, 0x27, 0x2F, 0x33, 0x37, 0x3B, 0x3F,   // RLA
  0x43, 0x47, 0x4F, 0x53, 0x57, 0x5B, 0x5F,   // SRE
  0x63, 0x67, 0x6F, 0x73, 0x77, 0x7B, 0x7F,   // RRA
  0xC3, 0xC7, 0xCF, 0xD3, 0xD7, 0xDB, 0xDF,   // DCP
  0xE3, 0xE7, 0xEF, 0xF3, 0xF7, 0xFB, 0xFF,   // ISC
]) RMW[op] = 1;

/** The length in bytes of the instruction with this opcode. */
export function instructionLength(opcode: number): number {
  return LENGTH[opcode & 0xFF];
}

/** Whether the opcode reads a memory byte, modifies it and writes it back. */
export function isReadModifyWrite(opcode: number): boolean {
  return RMW[opcode & 0xFF] === 1;
}

/**
 * The cycle (1 = the first) of an instruction of `cycles` cycles, starting at
 * `pc` with this `opcode`, on which an access to `addr` falls.
 */
export function accessCycle(opcode: number, pc: number, addr: number, write: boolean, cycles: number): number {
  if (write) return cycles;
  // The opcode and operand bytes are read in order from the instruction's own address.
  const offset = (addr - pc) & 0xFFFF;
  if (offset < LENGTH[opcode & 0xFF]) return offset + 1;
  if (RMW[opcode & 0xFF] === 1 && cycles >= 3) return cycles - 2;
  return cycles;
}
