/**
 * The 1 MHz bus: where in an instruction an access to &FC00-&FEFF falls, and
 * how long the 2 MHz CPU is held for it.
 *
 * The Model B runs its 6502 at 2 MHz but every device in FRED, JIM and SHEILA
 * (&FC00-&FEFF: the VIAs, ACIA, CRTC, ULAs, ADC, disc controller, Econet and
 * Tube windows) is on the 1 MHz bus. The machine's clock logic stretches the
 * 2 MHz cycle that addresses them until it can be synchronised with the 1 MHz
 * clock (Advanced User Guide, "The 1 MHz bus"): an access that begins on a
 * cycle in phase with the 1 MHz clock takes one extra 2 MHz cycle, one that
 * begins half a 1 MHz cycle out of phase waits a cycle for the edge and then
 * takes the extra one — two. Either way the access ends in phase, so the next
 * cycle starts on a 1 MHz boundary again.
 *
 * Phase is the parity of the CPU's cycle count: it starts at zero on reset
 * with the 1 MHz clock, and both counts advance together.
 */

import { accessCycle, baseCycles, isReadModifyWrite } from '@/debug/m6502/bus-cycles.ts';

/** Whether `addr` is on the 1 MHz bus. */
export function onSlowBus(addr: number): boolean {
  return addr >= 0xFC00 && addr < 0xFF00;
}

/** Opcodes that read memory through an indexed address and so pay a cycle
 *  before the read when the index carries into the high byte: abs,X; abs,Y;
 *  (zp),Y. (The undocumented NOPs that only compute the address make no access
 *  and are left out.) */
const INDEXED_READ = new Uint8Array(256);
for (const op of [
  0x11, 0x31, 0x51, 0x71, 0xB1, 0xD1, 0xF1, 0xB3,                       // (zp),Y
  0x19, 0x39, 0x59, 0x79, 0xB9, 0xD9, 0xF9, 0xBE, 0xBF, 0xBB,           // abs,Y
  0x1D, 0x3D, 0x5D, 0x7D, 0xBD, 0xDD, 0xFD, 0xBC,                       // abs,X
]) INDEXED_READ[op] = 1;
const INDIRECT_Y = new Set([0x11, 0x31, 0x51, 0x71, 0xB1, 0xD1, 0xF1, 0xB3]);

/**
 * The cycle of the instruction (1 = its first) on which a bus access falls:
 * the opcode at `pc`, an access to `addr`. `peek` reads memory without side
 * effects, to see whether an indexed read carried into the next page.
 */
export function instructionCycle(
  opcode: number, pc: number, addr: number, write: boolean, peek: (a: number) => number,
): number {
  const cycles = baseCycles(opcode, false);
  const c = accessCycle(opcode, pc, addr, write, cycles);
  if (write || INDEXED_READ[opcode] === 0) return c;
  // A data read (not the opcode or operand fetch) that crossed a page.
  if (((addr - pc) & 0xFFFF) < 3) return c;
  let base: number;
  if (INDIRECT_Y.has(opcode)) {
    const z = peek((pc + 1) & 0xFFFF);
    base = peek(z) | (peek((z + 1) & 0xFF) << 8);
  } else {
    base = peek((pc + 1) & 0xFFFF) | (peek((pc + 2) & 0xFFFF) << 8);
  }
  return ((base ^ addr) & 0xFF00) !== 0 ? c + 1 : c;
}

/** Extra 2 MHz cycles an access that begins on cycle `at` is held for. */
export function stretchAt(at: number): number {
  return (at & 1) === 0 ? 1 : 2;
}

/** The final write of a read-modify-write is preceded by the 6502's write of
 *  the unmodified value back, a second access to the same address. */
export function hasDummyWrite(opcode: number): boolean {
  return isReadModifyWrite(opcode);
}

/** Total base cycles of the instruction (before any stretch). */
export function instructionCycles(opcode: number): number {
  return baseCycles(opcode, false);
}
