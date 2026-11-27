/**
 * Z80MachineBase: the driver of a machine whose CPU is a Z80.
 *
 * Every Z80 machine extends this rather than BaseMachine itself. The seams the
 * debugger, the beam log and the snapshot writer read through the driver are
 * answered here, once, from the machine's own `cpu` and `memory`: the cycle
 * counter, the stack pointer, the pc and the return address an interrupt
 * pushed. They used to be the same four lines in every machine.
 *
 * It also answers for what a frame loop built on the driver's seams
 * (openFrame, checkStops, beforeInsn, afterInsn) can do. Such a loop stops at
 * a beam position and carries the stopped frame on instead of starting
 * another, and it reports interrupts once the machine sets the CPU's
 * `onInterrupt` to `noteInterrupt`. A machine whose loop cannot do either
 * overrides the answer to say so.
 *
 * What stays in the machine is what differs: its frame loop, its port decode,
 * and the read/write hooks it installs on the CPU. Those run on every access,
 * so they remain the machine's own closures.
 */

import type { Z80 } from '@/cores/z80.ts';
import { z80ReturnAddress } from '@/debug/beam-log.ts';
import type { IMachineMemory } from '@/machines/machine.ts';
import { BaseMachine } from '@/machines/base-machine.ts';

export abstract class Z80MachineBase extends BaseMachine {
  /** The machine's Z80. */
  abstract cpu: Z80;
  /** What the Z80 sees: its 64K address space, a view of the machine's banks. */
  abstract memory: IMachineMemory;

  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }

  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.cpu.sp; }
  protected override cpuPc(): number { return this.cpu.pc; }
  /** The Z80 pushes the return address low byte first: it is at SP, SP+1.
   *  Read through the side-effect-free `peekByte` where the memory has one. */
  protected override interruptedPc(): number {
    const memory = this.memory;
    return z80ReturnAddress(this.cpu.sp, (a) => memory.peekByte?.(a) ?? memory.readByte(a));
  }
}
