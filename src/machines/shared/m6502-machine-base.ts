/**
 * M6502MachineBase: the driver of a machine whose CPU is a 6502 or a 65C02.
 *
 * Every 6502 machine extends this rather than BaseMachine itself. The seams the
 * debugger, the beam log and the snapshot writer read through the driver are
 * answered here, once, from the machine's own `cpu` and `memory`: the cycle
 * counter, the stack pointer, the pc, the return address an interrupt pushed,
 * and whether the next step enters an interrupt.
 *
 * The 6502 core makes an instruction's bus accesses before it counts the
 * instruction's cycles, so an access a watchpoint logs is queued and stamped
 * afterwards with its own cycle in the instruction. That is `deferAccessStamps`
 * (BaseMachine), set here, and the cycle is worked out from the opcode
 * (`debug/m6502/bus-cycles.ts`).
 *
 * Two hooks stay with a machine where its hardware needs them:
 *   - peekOpcode(), when an opcode could be fetched from a page whose reads
 *     have side effects: it answers -1 there.
 *   - interruptEntryPending(), on a machine with a second CPU (the C128).
 *
 * As with the Z80 base, the machine's frame loop, port decode and CPU bus
 * hooks are its own; the hooks run on every access and stay its closures.
 */

import type { M6502 } from '@/cores/m6502.ts';
import { accessCycle as m6502AccessCycle } from '@/debug/m6502/bus-cycles.ts';
import { m6502ReturnAddress } from '@/debug/beam-log.ts';
import type { IMachineMemory } from '@/machines/machine.ts';
import { BaseMachine } from '@/machines/base-machine.ts';

export abstract class M6502MachineBase extends BaseMachine {
  /** The machine's 6502 (a 65C02 where the machine has one). */
  abstract cpu: M6502;
  /** What the CPU sees: its 64K address space, hardware registers included. */
  abstract memory: IMachineMemory;

  protected override deferAccessStamps = true;

  override supportsBeamStops(): boolean { return true; }
  override supportsInterruptLog(): boolean { return true; }

  protected override cpuCycles(): number { return this.cpu.tStates; }
  protected override stackPointer(): number { return this.cpu.sp; }
  protected override cpuPc(): number { return this.cpu.pc; }
  /** The 6502 pushes PCH, PCL, P: the return address is at SP+2 (low), SP+3
   *  (high). Read through the side-effect-free `peekByte` where the memory
   *  has one. */
  protected override interruptedPc(): number {
    const memory = this.memory;
    return m6502ReturnAddress(this.cpu.sp, (a) => memory.peekByte?.(a) ?? memory.readByte(a));
  }
  /** The opcode at `addr` read without side effects, where the memory has such
   *  a read. Where it has none there is nothing to go on, so the answer is -1
   *  and a queued access takes its instruction's last cycle. */
  protected override peekOpcode(addr: number): number {
    return this.memory.peekByte?.(addr) ?? -1;
  }
  /** A 6502's next step enters an interrupt instead of running the
   *  instruction at pc. */
  protected override interruptEntryPending(): boolean { return this.cpu.interruptPending(); }
  /** The cycle of an instruction's bus access, from its opcode. */
  protected override busAccessCycle(opcode: number, pc: number, addr: number, write: boolean, cycles: number): number {
    return m6502AccessCycle(opcode, pc, addr, write, cycles);
  }
}
