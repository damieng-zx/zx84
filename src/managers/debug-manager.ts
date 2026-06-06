/**
 * Debug Manager - handles debugging operations, tracing, and breakpoints.
 *
 * Responsibilities:
 * - Step into/over/out execution
 * - Breakpoint management
 * - Execution tracing (full/portio modes)
 * - CPU state inspection and disassembly
 */

import type { Machine } from '@/machine.ts';
import { Z80 } from '@/cores/z80.ts';
import { disasmOne } from '@/debug/z80-disasm.ts';
import { hex8, hex16 } from '@/utils/hex.ts';

export type TraceMode = 'full' | 'portio' | 'zxtl';

export class DebugManager {
  /** Address of a temporary "run to" breakpoint to clean up on hit */
  private pendingRunTo = -1;

  /**
   * Get the pending "run to" breakpoint address.
   */
  getPendingRunTo(): number {
    return this.pendingRunTo;
  }

  /**
   * Clear the pending "run to" breakpoint.
   */
  clearPendingRunTo(): void {
    this.pendingRunTo = -1;
  }

  /**
   * Execute a single instruction.
   */
  stepInto(machine: Machine, onUpdate: () => void): void {
    machine.cpu.step();
    onUpdate();
  }

  /**
   * Step over CALL/RST/conditional-jump/block-repeat instructions.
   *
   * Two completion strategies:
   *   - CALL/RST: step until SP returns to its pre-call level.
   *   - Conditional jumps + block repeats: step until PC reaches the next
   *     sequential instruction. (Block repeats are PC-based, not SP-based,
   *     because they don't touch SP; they just rewind PC by 2 each iteration.)
   */
  stepOver(machine: Machine, onUpdate: () => void): void {
    const cpu = machine.cpu;
    const op = machine.memory.readByte(cpu.pc);

    // Block repeats: ED B0..B3 (LDIR/CPIR/INIR/OTIR) and ED B8..BB (…DR).
    // Both share the pattern `1011 0xxx` ignoring bit 3; mask 0xF4 keeps
    // bits 7,6,5,4,2 so only 0xB0 and 0xB8 (each in 4 variants by bits 0-1)
    // can match. `0xB0 & 0xF4 == 0xB8 & 0xF4 == 0xB0`.
    const isBlockRepeat = op === 0xED &&
      ((machine.memory.readByte((cpu.pc + 1) & 0xFFFF) & 0xF4) === 0xB0);

    // CALL nn / CALL cc,nn / RST n — SP-based completion.
    const isCall =
      op === 0xCD ||                  // CALL nn
      (op & 0xC7) === 0xC4 ||         // CALL cc,nn
      (op & 0xC7) === 0xC7;           // RST n

    // Conditional jumps + block repeats: PC-based completion.
    const isPcOver =
      isBlockRepeat ||
      op === 0x10 ||                  // DJNZ e         (2 bytes)
      (op & 0xE7) === 0x20 ||         // JR cc,e        (2 bytes)
      (op & 0xC7) === 0xC2;           // JP cc,nn       (3 bytes)

    if (isPcOver) {
      const instrLen = (op & 0xC7) === 0xC2 ? 3 : 2;
      const nextPC = (cpu.pc + instrLen) & 0xFFFF;
      const limit = cpu.tStates + 5_000_000;
      cpu.step();
      while (cpu.pc !== nextPC && cpu.tStates < limit) {
        cpu.step();
      }
    } else if (!isCall) {
      cpu.step();
    } else {
      const targetSP = cpu.sp;
      const limit = cpu.tStates + 5_000_000; // safety: max ~1.4 seconds
      cpu.step(); // execute the CALL/RST
      while (((targetSP - cpu.sp) & 0xFFFF) > 0 && cpu.tStates < limit) {
        cpu.step();
      }
    }

    onUpdate();
  }

  /**
   * Step out of current function (run until RET brings SP back).
   */
  stepOut(machine: Machine, onUpdate: () => void): void {
    const cpu = machine.cpu;
    const targetSP = (cpu.sp + 2) & 0xFFFF; // SP after RET pops return address
    const limit = cpu.tStates + 10_000_000; // safety: max ~2.8 seconds

    // Run until SP reaches targetSP. Use 16-bit circular arithmetic so wrap-around
    // cases (e.g. initial SP=0xFFFE → targetSP=0x0000) are handled correctly.
    while (((targetSP - cpu.sp) & 0xFFFF) > 0 && cpu.tStates < limit) {
      cpu.step();
    }

    onUpdate();
  }

  /**
   * Run exactly one frame (to the next frame boundary) and update the display.
   */
  stepFrame(machine: Machine, onUpdate: () => void): void {
    machine.tick();
    if (machine.display) machine.display.updateTexture(machine.pixels);
    onUpdate();
  }

  /**
   * Toggle breakpoint at address.
   */
  toggleBreakpoint(
    machine: Machine,
    addr: number,
    onStatus: (msg: string) => void,
    onUpdate: () => void
  ): void {
    if (machine.breakpoints.has(addr)) {
      machine.breakpoints.delete(addr);
      onStatus(`Breakpoint removed at ${hex16(addr)}`);
    } else {
      machine.breakpoints.add(addr);
      onStatus(`Breakpoint set at ${hex16(addr)}`);
    }
    onUpdate();
  }

  /**
   * Run to address (set temporary breakpoint).
   */
  runTo(
    machine: Machine,
    addr: number,
    emulationPaused: boolean,
    onResume: () => void
  ): void {
    const wasSet = machine.breakpoints.has(addr);
    machine.breakpoints.add(addr);

    if (!wasSet) {
      this.pendingRunTo = addr;
    }

    if (emulationPaused) {
      machine.start();
      onResume();
    }
  }

  /**
   * Start execution tracing.
   */
  startTrace(machine: Machine, mode: TraceMode = 'full', onStart: () => void): void {
    machine.startTrace(mode);
    onStart();
  }

  /**
   * Stop execution tracing and return trace text.
   */
  stopTrace(machine: Machine, onStop: (text: string, lineCount: number) => void): void {
    const text = machine.stopTrace();
    const lines = text === '' ? 0 : text.split('\n').length;
    onStop(text, lines);
  }

  /**
   * Copy CPU state and disassembly to clipboard. Awaits the clipboard
   * write so a permission denial or transient failure is reported via
   * `onStatus` rather than silently swallowed.
   */
  async copyCpuState(machine: Machine, onStatus: (msg: string) => void): Promise<void> {
    const cpu = machine.cpu;
    const f = cpu.f;
    const flags = [
      `Sign=${(f & Z80.FLAG_S) ? 1 : 0}`,
      `Zero=${(f & Z80.FLAG_Z) ? 1 : 0}`,
      `Half=${(f & Z80.FLAG_H) ? 1 : 0}`,
      `P/V=${(f & Z80.FLAG_PV) ? 1 : 0}`,
      `Sub=${(f & Z80.FLAG_N) ? 1 : 0}`,
      `Carry=${(f & Z80.FLAG_C) ? 1 : 0}`,
    ].join('  ');

    const iff = cpu.iff1 ? 'EI' : 'DI';
    const halt = cpu.halted ? ' HALT' : '';

    const lines = [
      `AF  ${hex16(cpu.af)}  AF' ${hex16((cpu.a_ << 8) | cpu.f_)}`,
      `BC  ${hex16(cpu.bc)}  BC' ${hex16((cpu.b_ << 8) | cpu.c_)}`,
      `DE  ${hex16(cpu.de)}  DE' ${hex16((cpu.d_ << 8) | cpu.e_)}`,
      `HL  ${hex16(cpu.hl)}  HL' ${hex16((cpu.h_ << 8) | cpu.l_)}`,
      `IX  ${hex16(cpu.ix)}  IY  ${hex16(cpu.iy)}`,
      `PC  ${hex16(cpu.pc)}  SP  ${hex16(cpu.sp)}`,
      `I   ${hex8(cpu.i)}    R   ${hex8(cpu.r)}  IM ${cpu.im}  ${iff}${halt}`,
      `Flags: ${flags}`,
      '',
      'Disassembly:',
    ];

    // Disassemble 16 instructions around PC
    const snap = machine.memory.snapshot();
    let addr = cpu.pc;
    for (let i = 0; i < 16; i++) {
      const dl = disasmOne(snap, addr);
      const bytesStr = Array.from({ length: dl.length }, (_, j) => hex8(snap[(dl.addr + j) & 0xFFFF]))
        .join(' ')
        .padEnd(12, ' ');
      const mnem = dl.text.padEnd(24, ' ');
      lines.push(`${dl.addr === cpu.pc ? '>' : ' '} ${hex16(addr)}  ${bytesStr}  ${mnem}`);
      addr = (addr + dl.length) & 0xFFFF;
    }

    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      onStatus('CPU state + disassembly copied to clipboard');
    } catch (err) {
      onStatus(`Clipboard copy failed: ${(err as Error).message}`);
    }
  }

}
